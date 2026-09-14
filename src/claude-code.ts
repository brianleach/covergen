/**
 * The subscription generator backend: Claude Code headless instead of the
 * Messages API.
 *
 * `claude -p --output-format json` runs one turn on whatever login the local
 * Claude Code install has, so a sweep can draw on a Claude subscription rather
 * than a metered API key. It is the documented way to drive the agent loop as a
 * subprocess and it adds no dependency: anyone who would pick this backend
 * already has the binary.
 *
 * Load-bearing choices: the system prompt goes through a file, not argv; the run
 * is stripped to a single text completion (`--tools ""`, `--strict-mcp-config`,
 * `--disable-slash-commands`, `--setting-sources ""`) so nothing in the
 * environment can run a tool or inject a hook; the child works in an empty
 * scratch directory, never the target repo; and repairs resume the recorded
 * session id, keeping the "continue the same chat" contract of the API backend.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractCode, hashCode, shortId, type Generator, type Usage } from "./generate.js";
import type { Candidate, PromptBlocks, PromptMessage } from "./types.js";

/** One `claude` invocation. Injected in tests so `npm test` never spends a token. */
export type ClaudeExec = (args: string[], stdin?: string) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface ClaudeCodeOptions {
  binary?: string;
  model?: string;
  timeoutMs?: number;
  /** Tokens this backend may spend before it refuses to call again. 0 disables. */
  maxTokensPerSweep?: number;
  exec?: ClaudeExec;
}

const DEFAULT_TIMEOUT_MS = 600_000;

/**
 * The nesting guards go because Claude Code refuses to start inside another
 * Claude Code session, and a sweep launched from an agent session is exactly how
 * this gets used. The API key goes because a key in the ambient environment
 * silently switches the child to metered billing, the opposite of the point.
 */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  delete out.CLAUDECODE;
  delete out.CLAUDE_CODE_ENTRYPOINT;
  delete out.ANTHROPIC_API_KEY;
  return out;
}

/** Spawn the real binary in `cwd`, prompt on stdin. Never rejects on a nonzero exit. */
export function claudeExec(binary: string, cwd: string, timeoutMs: number): ClaudeExec {
  return (args, stdin) =>
    new Promise((resolve) => {
      const child = spawn(binary, args, { cwd, env: childEnv(), stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ code: 127, stdout, stderr: `${stderr}${String(err)}` });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, stdout, stderr });
      });
      child.stdin.end(stdin ?? "");
    });
}

export interface ClaudeReply { text: string; sessionId?: string; usage: Usage }

/** Pull the fields we use out of one `--output-format json` result. */
export function parseReply(stdout: string): ClaudeReply {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(stdout.trim()) as Record<string, unknown>;
  } catch {
    throw new Error(`claude did not return JSON. Output began: ${stdout.replace(/\s+/g, " ").slice(0, 240)}`);
  }
  const u = (raw.usage ?? {}) as Record<string, number>;
  const text = typeof raw.result === "string" ? raw.result : "";
  if (raw.is_error === true) throw new Error(`claude reported an error: ${text.slice(0, 400)}`);
  return {
    text,
    sessionId: typeof raw.session_id === "string" ? raw.session_id : undefined,
    usage: {
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
    },
  };
}

/** Named in every preflight failure: the backend never switches billing on its own. */
const BACKUP = "run with COVERGEN_GENERATOR=api to fall back to the metered key.";

/**
 * Verify the local install can generate before a sweep starts spending time.
 * Reads only whether a login exists and what kind it is; the status payload also
 * carries an account identity, which is never read and never logged.
 */
export async function preflightClaudeCode(exec: ClaudeExec): Promise<string> {
  const res = await exec(["auth", "status", "--json"]);
  if (res.code === 127) {
    throw new Error(`generator claude-code needs the claude binary on PATH. Install Claude Code, or ${BACKUP}`);
  }
  let status: Record<string, unknown>;
  try {
    status = JSON.parse(res.stdout.trim()) as Record<string, unknown>;
  } catch {
    throw new Error(`could not read "claude auth status --json" (exit ${res.code}). Run it by hand to see why.`);
  }
  if (status.loggedIn !== true) {
    throw new Error(`claude is installed but not logged in. Run \`claude auth login\`, or ${BACKUP}`);
  }
  const method = typeof status.authMethod === "string" ? status.authMethod : "unknown";
  const plan = typeof status.subscriptionType === "string" ? status.subscriptionType : "unknown";
  return `${method} (${plan})`;
}

/** Stable key for a conversation, so a repair round can find its session id. */
function conversationKey(history: PromptMessage[]): string {
  return createHash("sha256").update(JSON.stringify(history)).digest("hex");
}

/** Replay for the case where no session id is known: the whole chat as one prompt. */
function transcript(history: PromptMessage[], userMessage: string): string {
  const turns = history.map((m) => `${m.role === "user" ? "User" : "Assistant"}:\n${m.content}`);
  return [...turns, `User:\n${userMessage}`].join("\n\n---\n\n");
}

export function createClaudeCodeGenerator(opts: ClaudeCodeOptions = {}): Generator {
  const model = opts.model;
  const maxTokens = opts.maxTokensPerSweep ?? 0;
  const totals: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  /** conversation key -> session id of the run that produced it. */
  const sessions = new Map<string, string>();
  function spent(): number {
    return totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
  }

  async function ask(system: string | undefined, prompt: string, resume?: string): Promise<ClaudeReply> {
    if (maxTokens > 0 && spent() >= maxTokens) {
      throw new Error(
        `subscription token ceiling reached: ${spent()} of ${maxTokens} tokens spent. Raise claude_code.max_tokens_per_sweep or split the sweep.`,
      );
    }
    // One scratch directory per call: the child's working directory, so the target
    // repo's CLAUDE.md and .claude/ stay out of the prompt, and the home of the
    // system prompt file. Removed either way when the call returns.
    const dir = await mkdtemp(join(tmpdir(), "covergen-cc-"));
    const run = opts.exec ?? claudeExec(opts.binary ?? "claude", dir, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const args = ["-p", "--output-format", "json"];
      if (model) args.push("--model", model);
      if (resume) args.push("--resume", resume);
      if (system !== undefined) {
        // Through a file, not argv: the system blocks carry a whole source file
        // and a whole idiom pack, and one argv string is capped near 128 KB.
        const file = join(dir, "system.txt");
        await writeFile(file, system, "utf8");
        args.push("--system-prompt-file", file);
      }
      args.push("--strict-mcp-config", "--disable-slash-commands", "--setting-sources", "", "--tools", "");
      const res = await run(args, prompt);
      if (res.code !== 0 && !res.stdout.trim().startsWith("{")) {
        const tail = `${res.stderr}\n${res.stdout}`.trim().split("\n").slice(-10).join("\n");
        throw new Error(`claude exited ${res.code}. Output:\n${tail}`);
      }
      const reply = parseReply(res.stdout);
      totals.input += reply.usage.input;
      totals.output += reply.usage.output;
      totals.cacheRead += reply.usage.cacheRead;
      totals.cacheWrite += reply.usage.cacheWrite;
      return reply;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  function systemText(blocks: Pick<PromptBlocks, "stable" | "semiStable">): string {
    return `${blocks.stable}\n\n${blocks.semiStable}`;
  }

  function remember(history: PromptMessage[], sessionId?: string): void {
    if (sessionId) sessions.set(conversationKey(history), sessionId);
  }

  return {
    async generate(blocks, segment, specPath, wholeFile) {
      const reply = await ask(systemText(blocks), blocks.volatile);
      const code = extractCode(reply.text);
      const history: PromptMessage[] = [
        { role: "user", content: blocks.volatile },
        { role: "assistant", content: reply.text },
      ];
      remember(history, reply.sessionId);
      return {
        id: shortId(),
        hash: hashCode(code),
        segment,
        specPath,
        code,
        wholeFile,
        status: "generated",
        attempts: 1,
        history,
        system: { stable: blocks.stable, semiStable: blocks.semiStable },
      } satisfies Candidate;
    },

    async continueChat(history, userMessage, system) {
      const key = conversationKey(history);
      const sessionId = sessions.get(key);
      const text = system ? systemText(system) : undefined;
      // No session id means this conversation was generated by a different
      // process or backend. Replaying it as one prompt costs more tokens than a
      // resume but keeps the repair loop working rather than failing the round.
      const reply = sessionId
        ? await ask(text, userMessage, sessionId)
        : await ask(text, transcript(history, userMessage));
      sessions.delete(key);
      remember(
        [...history, { role: "user", content: userMessage }, { role: "assistant", content: reply.text }],
        reply.sessionId,
      );
      return reply.text;
    },

    usage() {
      return { ...totals };
    },
  };
}
