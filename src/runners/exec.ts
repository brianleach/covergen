/**
 * Child process execution for the runners. spawn with an argv array (never a
 * shell string), a detached process group so a timeout kills the whole tree,
 * and 2 MB tail buffers on stdout and stderr. Also owns the per-run coverage
 * output directory under <repo>/.covergen/coverage/.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { RepoConfig } from "../types.js";

/** Hard cap on captured stdout/stderr. We keep the tail, which is where failures live. */
export const OUTPUT_CAP_BYTES = 2 * 1024 * 1024;

/** Grace between the SIGTERM and the SIGKILL sent to a timed out process group. */
const KILL_GRACE_MS = 2_000;

/** Wait after the child exits for its stdio to close before settling without it. */
const DRAIN_GRACE_MS = 250;

export interface ExecOptions {
  cwd: string;
  timeoutMs: number;
  env?: Record<string, string>;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export type ExecFn = (cmd: string[], opts: ExecOptions) => Promise<ExecResult>;

/** Ring-ish buffer: append everything, drop from the head once past the cap. */
class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;

  constructor(private readonly cap: number) {}

  push(chunk: Buffer | string): void {
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    this.chunks.push(buf);
    this.size += buf.length;
    while (this.size > this.cap && this.chunks.length > 0) {
      const first = this.chunks[0]!;
      const excess = this.size - this.cap;
      if (first.length <= excess) {
        this.chunks.shift();
        this.size -= first.length;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.size -= excess;
      }
    }
  }

  toString(): string {
    return Buffer.concat(this.chunks, this.size).toString("utf8");
  }
}

/**
 * Run a command with spawn (argv array, never a shell string) and capture its output.
 *
 * On timeout the whole process tree is killed: the child is spawned detached so it leads its
 * own process group, and we signal the negated pid (SIGTERM, then SIGKILL after a grace period)
 * to reach every descendant. A `bundle exec` or `npx` wrapper otherwise leaves the real runner
 * alive.
 *
 * We settle on the child's own exit, never on stdio close. A grandchild that outlives the runner,
 * a test worker reparented to init for instance, keeps the inherited stdout pipe open, so close
 * may never fire and waiting for it is what hangs a run long past its timeout. Once the child is
 * gone we give the streams a short drain window; if they are still open when it elapses we kill
 * the leftover group, keep the output captured so far, and resolve.
 *
 * Never rejects. A spawn failure comes back as exitCode 127 with the message on stderr.
 */
export function runCommand(cmd: string[], opts: ExecOptions): Promise<ExecResult> {
  const [file, ...args] = cmd;
  if (!file) return Promise.reject(new Error("runCommand: empty command"));

  const started = Date.now();
  return new Promise<ExecResult>((resolve) => {
    const stdout = new TailBuffer(OUTPUT_CAP_BYTES);
    const stderr = new TailBuffer(OUTPUT_CAP_BYTES);
    // Own process group, so a timeout can kill the whole tree and not just the wrapper script.
    const grouped = process.platform !== "win32";

    // stdin is closed rather than piped: runners read no input, and an open pipe lets one block
    // forever on a read nothing will answer.
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      detached: grouped,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.on("data", (c: Buffer) => stdout.push(c));
    child.stderr?.on("data", (c: Buffer) => stderr.push(c));
    // A killed group can tear a pipe down mid-read; that is not a run failure.
    child.stdout?.on("error", () => {});
    child.stderr?.on("error", () => {});

    const timers: NodeJS.Timeout[] = [];
    const later = (ms: number, fn: () => void): void => {
      timers.push(setTimeout(fn, ms));
    };

    let settled = false;
    let closed = false;
    let timedOut = false;
    let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;

    const finish = (exitCode: number, extraStderr?: string): void => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      if (!closed) {
        // Something in the group still holds our pipes. Reclaim it, then let go of the streams
        // so they cannot keep this process alive.
        signalGroup(child, grouped, "SIGKILL");
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
      }
      if (extraStderr) stderr.push(Buffer.from(extraStderr));
      resolve({
        exitCode,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        durationMs: Date.now() - started,
      });
    };

    const settle = (): void => {
      const code = exited?.code ?? null;
      if (timedOut) {
        finish(code ?? 124, `\ncovergen: timed out after ${opts.timeoutMs}ms, killed process group\n`);
        return;
      }
      if (code === null) {
        finish(128, `\ncovergen: terminated by signal ${exited?.signal}\n`);
        return;
      }
      finish(code);
    };

    child.on("error", (err: Error) => finish(127, `\ncovergen: failed to run ${file}: ${err.message}\n`));

    child.on("exit", (code, signal) => {
      exited = { code, signal };
      if (closed) settle();
      else later(DRAIN_GRACE_MS, settle);
    });

    child.on("close", () => {
      closed = true;
      if (exited) settle();
    });

    later(opts.timeoutMs, () => {
      timedOut = true;
      signalGroup(child, grouped, "SIGTERM");
      later(KILL_GRACE_MS, () => signalGroup(child, grouped, "SIGKILL"));
      // Backstop for a child that will not die: the caller waits at most the timeout plus the
      // kill grace, whatever the process does.
      later(KILL_GRACE_MS + DRAIN_GRACE_MS, settle);
    });
  });
}

/** Signal the child's whole process group where we have one, else just the child. */
function signalGroup(child: ChildProcess, grouped: boolean, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    // Negative pid targets the whole process group created by `detached: true`.
    process.kill(grouped ? -pid : pid, signal);
  } catch {
    // The group is already gone, or we never got one.
    try {
      process.kill(pid, signal);
    } catch {
      /* ignore */
    }
  }
}

/** Prepend repo.commandPrefix (e.g. ["docker","compose","exec","-T","api"]) when present. */
export function withPrefix(prefix: string[] | undefined, cmd: string[]): string[] {
  return prefix && prefix.length > 0 ? [...prefix, ...cmd] : cmd;
}

/**
 * A fresh output directory for one coverage run:
 * `<repo.root>/.covergen/coverage/<timestamp-random>/`.
 *
 * Every run gets its own leaf so parallel gate runs (pass^k, several candidates at once) never
 * read each other's lcov.info. Callers are responsible for cleanup; the whole tree is disposable.
 */
export function coverageOutDir(repo: RepoConfig): string {
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const dir = join(repo.root, ".covergen", "coverage", stamp);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Resolve the lcov file a runner was told to write. Missing lcov is not a test failure: the suite
 * may have legitimately exited non-zero before writing one, so the caller keeps the exit code and
 * only loses `lcovPath`.
 */
export function resolveLcov(path: string): { lcovPath?: string; note?: string } {
  if (existsSync(path)) return { lcovPath: path };
  return { note: `\ncovergen: expected lcov at ${path} but it was not written\n` };
}
