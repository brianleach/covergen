import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rollback, watchForAbort, type SignalSource } from "./abort.js";

/** A stand-in for `process`, so no test ever installs a real signal handler. */
function fakeSource(): SignalSource & { raise: (signal: NodeJS.Signals) => void; installed: () => number } {
  const handlers = new Set<(signal: NodeJS.Signals) => void>();
  return {
    on: (_signal, handler) => handlers.add(handler),
    off: (_signal, handler) => handlers.delete(handler),
    // Raised once per test: a second signal re-raises on the real process by
    // design, which would take the test runner with it.
    raise: (signal) => {
      for (const handler of [...handlers]) handler(signal);
    },
    installed: () => handlers.size,
  };
}

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "covergen-abort-"));
}

describe("rollback", () => {
  it("puts changed files back and deletes the ones that did not exist", async () => {
    const dir = await scratch();
    const existing = join(dir, "foo.rb");
    const created = join(dir, "foo_spec.rb");
    await writeFile(existing, "class Foo\nend\n", "utf8");
    await writeFile(created, "generated\n", "utf8");

    await writeFile(existing, "class Foo # mutant\nend\n", "utf8");
    rollback([
      { path: existing, original: "class Foo\nend\n" },
      { path: created, original: undefined },
    ]);

    expect(await readFile(existing, "utf8")).toBe("class Foo\nend\n");
    expect(existsSync(created)).toBe(false);
  });

  it("does not throw on a file that is already gone", () => {
    expect(() => rollback([{ path: join(tmpdir(), "covergen-not-here.rb"), original: undefined }])).not.toThrow();
  });
});

describe("watchForAbort", () => {
  it("restores the guarded files on the first signal and reports it", async () => {
    const dir = await scratch();
    const source = join(dir, "foo.rb");
    const spec = join(dir, "foo_spec.rb");
    await writeFile(source, "original source\n", "utf8");
    const host = fakeSource();
    const watch = watchForAbort(host);

    expect(watch.aborted()).toBe(false);
    watch.guard([
      { path: source, original: "original source\n" },
      { path: spec, original: undefined },
    ]);
    // The gate is mid-candidate: a mutant in the source, a candidate in the spec.
    await writeFile(source, "mutated source\n", "utf8");
    await writeFile(spec, "candidate under test\n", "utf8");

    host.raise("SIGTERM");

    expect(watch.aborted()).toBe(true);
    expect(watch.signal()).toBe("SIGTERM");
    expect(await readFile(source, "utf8")).toBe("original source\n");
    expect(existsSync(spec)).toBe(false);
    watch.release();
    expect(host.installed()).toBe(0);
  });

  it("rolls nothing back when nothing is in flight", async () => {
    const dir = await scratch();
    const kept = join(dir, "accepted_spec.rb");
    await writeFile(kept, "accepted test\n", "utf8");
    const host = fakeSource();
    const watch = watchForAbort(host);
    watch.guard([]);

    host.raise("SIGINT");

    expect(watch.signal()).toBe("SIGINT");
    expect(await readFile(kept, "utf8")).toBe("accepted test\n");
    watch.release();
  });
});

  it("removes the handlers and re-raises on a second signal", () => {
    const host = fakeSource();
    const watch = watchForAbort(host);
    const kills: Array<[number, string | number | undefined]> = [];
    const realKill = process.kill;
    process.kill = ((pid: number, signal?: string | number) => {
      kills.push([pid, signal]);
      return true;
    }) as typeof process.kill;
    try {
      host.raise("SIGINT");
      host.raise("SIGTERM");
    } finally {
      process.kill = realKill;
    }

    expect(kills).toEqual([[process.pid, "SIGTERM"]]);
    expect(host.installed()).toBe(0);
    expect(watch.signal()).toBe("SIGINT");
  });
