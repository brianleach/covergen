import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OUTPUT_CAP_BYTES, runCommand, withPrefix } from "./exec.js";

const node = process.execPath;

/** True once the pid is unreachable. Signal 0 only checks for existence. */
function isGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

async function waitUntilGone(pid: number, withinMs: number): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    if (isGone(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return isGone(pid);
}

describe("withPrefix", () => {
  it("returns the command unchanged with no prefix", () => {
    expect(withPrefix(undefined, ["bundle", "exec", "rspec"])).toEqual(["bundle", "exec", "rspec"]);
    expect(withPrefix([], ["bun", "test"])).toEqual(["bun", "test"]);
  });

  it("prepends a docker compose prefix", () => {
    expect(withPrefix(["docker", "compose", "exec", "-T", "api"], ["bundle", "exec", "rspec"])).toEqual([
      "docker",
      "compose",
      "exec",
      "-T",
      "api",
      "bundle",
      "exec",
      "rspec",
    ]);
  });

  it("does not mutate the inputs", () => {
    const prefix = ["docker", "exec"];
    const cmd = ["bun", "test"];
    withPrefix(prefix, cmd);
    expect(prefix).toEqual(["docker", "exec"]);
    expect(cmd).toEqual(["bun", "test"]);
  });
});

describe("runCommand", () => {
  it("captures stdout, stderr and a zero exit code", async () => {
    const res = await runCommand([node, "-e", "process.stdout.write('out'); process.stderr.write('err')"], {
      cwd: process.cwd(),
      timeoutMs: 30_000,
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("out");
    expect(res.stderr).toBe("err");
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("reports a non-zero exit code without throwing", async () => {
    const res = await runCommand([node, "-e", "process.exit(3)"], { cwd: process.cwd(), timeoutMs: 30_000 });
    expect(res.exitCode).toBe(3);
  });

  it("passes env through on top of process.env", async () => {
    const res = await runCommand([node, "-e", "process.stdout.write(String(process.env.COVERGEN_TEST_VAR))"], {
      cwd: process.cwd(),
      timeoutMs: 30_000,
      env: { COVERGEN_TEST_VAR: "hello" },
    });
    expect(res.stdout).toBe("hello");
  });

  it("runs in the requested cwd", async () => {
    const res = await runCommand([node, "-e", "process.stdout.write(process.cwd())"], {
      cwd: import.meta.dirname,
      timeoutMs: 30_000,
    });
    expect(res.stdout).toContain("runners");
  });

  it("never interprets arguments as a shell string", async () => {
    const res = await runCommand([node, "-e", "process.stdout.write(process.argv[1] ?? '')", "a; echo pwned"], {
      cwd: process.cwd(),
      timeoutMs: 30_000,
    });
    expect(res.stdout).toBe("a; echo pwned");
  });

  it("returns exit code 127 with a message when the binary is missing", async () => {
    const res = await runCommand(["covergen-definitely-not-a-real-binary"], {
      cwd: process.cwd(),
      timeoutMs: 30_000,
    });
    expect(res.exitCode).toBe(127);
    expect(res.stderr).toContain("failed to run");
  });

  it("rejects an empty command", async () => {
    await expect(runCommand([], { cwd: process.cwd(), timeoutMs: 1000 })).rejects.toThrow(/empty command/);
  });

  it("kills the process on timeout and notes it on stderr", async () => {
    const res = await runCommand([node, "-e", "setTimeout(() => {}, 60000)"], {
      cwd: process.cwd(),
      timeoutMs: 300,
    });
    expect(res.stderr).toContain("timed out after 300ms");
    expect(res.exitCode).not.toBe(0);
    expect(res.durationMs).toBeLessThan(30_000);
  });

  it.skipIf(process.platform === "win32")(
    "settles when an orphaned grandchild holds stdout open, and reclaims the group",
    async () => {
      const script = join(import.meta.dirname, "fixtures", "spawns-orphan.mjs");
      const res = await runCommand([node, script], { cwd: process.cwd(), timeoutMs: 1000 });

      // The runner exited on its own, so this is not the timeout path.
      expect(res.exitCode).toBe(0);
      expect(res.stderr).not.toContain("timed out");

      const pid = Number(/GRANDCHILD_PID=(\d+)/.exec(res.stdout)?.[1]);
      expect(pid).toBeGreaterThan(0);
      expect(await waitUntilGone(pid, 5_000)).toBe(true);
    },
    15_000,
  );

  it("caps captured output at 2 MB and keeps the tail", async () => {
    const script = `
      const chunk = "x".repeat(1024 * 1024);
      process.stdout.write(chunk);
      process.stdout.write(chunk);
      process.stdout.write(chunk);
      process.stdout.write("TAIL_MARKER");
    `;
    const res = await runCommand([node, "-e", script], { cwd: process.cwd(), timeoutMs: 60_000 });
    expect(Buffer.byteLength(res.stdout)).toBe(OUTPUT_CAP_BYTES);
    expect(res.stdout.endsWith("TAIL_MARKER")).toBe(true);
    expect(res.stdout.startsWith("TAIL")).toBe(false);
  }, 60_000);
});

it("reports exit code 128 and the signal when the child is killed by a signal", async () => {
  const res = await runCommand([node, "-e", "process.kill(process.pid, 'SIGKILL')"], {
    cwd: process.cwd(),
    timeoutMs: 30_000,
  });
  expect(res.exitCode).toBe(128);
  expect(res.stderr).toContain("terminated by signal SIGKILL");
  expect(res.stderr).not.toContain("timed out");
});
