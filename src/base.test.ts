import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { refreshBase } from "./base.js";
import { runCmd } from "./pr.js";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const res = await runCmd("git", args, cwd);
  if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr || res.stdout}`);
  return res.stdout;
}

const sha = async (cwd: string, rev = "HEAD"): Promise<string> => (await git(cwd, "rev-parse", rev)).trim();

/** A work tree with one commit, a bare remote called origin, and origin/HEAD set. */
async function fixture(): Promise<{ tmp: string; work: string; remote: string }> {
  const tmp = await mkdtemp(join(tmpdir(), "covergen-base-test-"));
  const remote = join(tmp, "remote.git");
  const work = join(tmp, "work");
  await git(tmp, "init", "--bare", "-b", "main", remote);
  await mkdir(join(work, "src"), { recursive: true });
  await git(tmp, "init", "-b", "main", work);
  await git(work, "config", "user.email", "covergen@example.com");
  await git(work, "config", "user.name", "covergen");
  await writeFile(join(work, "src", "a.ts"), "export const a = 1;\n", "utf8");
  await git(work, "add", "--", "src/a.ts");
  await git(work, "commit", "-m", "initial");
  await git(work, "remote", "add", "origin", remote);
  await git(work, "push", "origin", "main");
  await git(work, "remote", "set-head", "origin", "-a");
  return { tmp, work, remote };
}

/** Someone else's merge landing on the default branch, the way one does overnight. */
async function moveOrigin(tmp: string, remote: string, tag: string): Promise<string> {
  const other = join(tmp, `other-${tag}`);
  await git(tmp, "clone", "--quiet", remote, other);
  await git(other, "config", "user.email", "someone@example.com");
  await git(other, "config", "user.name", "someone");
  await writeFile(join(other, "src", "a.ts"), `export const a = 1; // ${tag}\n`, "utf8");
  await git(other, "add", "--", "src/a.ts");
  await git(other, "commit", "-m", `someone else's work ${tag}`);
  await git(other, "push", "origin", "main");
  return sha(other);
}

describe("refreshBase", () => {
  it("fast-forwards a clean checkout to the default branch and reports both commits", async () => {
    const { tmp, work, remote } = await fixture();
    await git(work, "checkout", "-b", "nightly");
    const before = await sha(work);
    const moved = await moveOrigin(tmp, remote, "one");

    const out = await refreshBase({ root: work });

    expect(out).toMatchObject({ refreshed: true, before, after: moved, branch: "nightly", base: "main" });
    expect(await sha(work)).toBe(moved);
  });

  it("leaves a branch holding its own commits alone", async () => {
    const { tmp, work, remote } = await fixture();
    await git(work, "checkout", "-b", "mine");
    await writeFile(join(work, "src", "b.ts"), "export const b = 2;\n", "utf8");
    await git(work, "add", "--", "src/b.ts");
    await git(work, "commit", "-m", "work in progress");
    const before = await sha(work);
    await moveOrigin(tmp, remote, "two");

    const out = await refreshBase({ root: work });

    expect(out.refreshed).toBe(false);
    expect(out.reason).toBe("mine has 1 commit not on origin/main");
    expect(await sha(work)).toBe(before);
  });

  it("leaves a dirty checkout alone, and ignores the state directory when told to", async () => {
    const { tmp, work, remote } = await fixture();
    await moveOrigin(tmp, remote, "three");
    const before = await sha(work);
    await mkdir(join(work, "scratch"), { recursive: true });
    await writeFile(join(work, "scratch", "state.json"), "{}", "utf8");
    await writeFile(join(work, "src", "a.ts"), "export const a = 3;\n", "utf8");

    const dirty = await refreshBase({ root: work, ignore: ["scratch"] });
    expect(dirty.refreshed).toBe(false);
    expect(dirty.reason).toContain("checkout is dirty (src/a.ts");
    expect(await sha(work)).toBe(before);

    // The same checkout with only the state directory dirty is refreshable.
    await git(work, "checkout", "--", "src/a.ts");
    const clean = await refreshBase({ root: work, ignore: ["scratch"] });
    expect(clean.refreshed).toBe(true);
  });

  it("does nothing when the switch is off, and nothing when the checkout is already current", async () => {
    const { tmp, work, remote } = await fixture();
    const moved = await moveOrigin(tmp, remote, "four");

    const off = await refreshBase({ root: work, enabled: false });
    expect(off).toMatchObject({ refreshed: false, reason: "refresh_base: false" });
    expect(await sha(work)).not.toBe(moved);

    expect((await refreshBase({ root: work })).refreshed).toBe(true);
    const again = await refreshBase({ root: work });
    expect(again).toMatchObject({ refreshed: false, reason: "already at origin/main" });
  });

  it("reports rather than throws when the directory is not a checkout", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "covergen-base-test-"));
    const out = await refreshBase({ root: tmp });
    expect(out).toMatchObject({ refreshed: false, before: "", after: "", reason: "no commit to refresh from" });
  });

  it("reports rather than throws when there is no remote to refresh from", async () => {
    const { work } = await fixture();
    await git(work, "remote", "remove", "origin");
    const out = await refreshBase({ root: work });
    expect(out.refreshed).toBe(false);
    expect(out.reason).toMatch(/git fetch origin failed|no origin\/main to refresh from/);
  });
});
