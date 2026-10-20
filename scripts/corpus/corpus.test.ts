import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkLicense, classifyLicense } from "./license.js";
import {
  applyAlias,
  countSymbols,
  definitionOf,
  isBarrel,
  isHelperFile,
  isPlainAlias,
  packageEntry,
  pairRepo,
  resolveImport,
  tsconfigAliases,
  workspacePackages,
} from "./pair.js";
import { ceilingFromP99, dedupe, percentile } from "./stats.js";

const mini = fileURLToPath(new URL("../../fixtures/corpus/mini-repo", import.meta.url));

describe("pairing resolver", () => {
  const result = pairRepo(mini);
  const sourceOf = (test: string) => result.pairs.find((p) => p.testPath === test)?.sourcePath;

  it("pairs a test with the source it imports most symbols from, with the nearest vitest range", () => {
    expect(sourceOf("test/math.test.ts")).toBe("src/math.ts");
    expect(result.pairs.every((p) => p.vitestVersion === "^2.1.8")).toBe(true);
  });

  it("counts the namespace members a test uses and accepts vitest globals", () => {
    expect(sourceOf("test/globals.spec.ts")).toBe("src/strings.ts");
  });

  it("breaks a tie with the first relative import", () => {
    expect(sourceOf("test/tie.test.ts")).toBe("src/strings.ts");
  });

  it("drops helpers-only, other runners, generated files, snapshots and unresolved package imports", () => {
    expect(result.tests).toBe(16);
    expect(result.pairs).toHaveLength(8);
    expect(result.drops).toEqual({
      no_resolvable_source: 4,
      workspace_entry_unreadable: 1,
      not_vitest: 1,
      generated: 1,
      snapshot: 1,
    });
  });

  it("resolves .js specifiers to .ts and refuses paths outside the repo", () => {
    expect(resolveImport(mini, "test/math.test.ts", "../src/math.js")).toBe("src/math.ts");
    expect(resolveImport(mini, "test/math.test.ts", "../../../package.json")).toBeNull();
    expect(resolveImport(mini, "test/math.test.ts", "vitest")).toBeNull();
  });

  it("collects .test.tsx files and pairs them like .test.ts files", () => {
    expect(sourceOf("test/component.test.tsx")).toBe("src/strings.ts");
  });

  it("resolves a workspace package import, comments in the clause ignored, re-exports followed one level", () => {
    expect(sourceOf("test/workspace.test.ts")).toBe("packages/core/src/add.ts");
  });

  it("follows namespace members through nested barrels and local export lists, and survives cycles", () => {
    expect(sourceOf("test/namespace.test.ts")).toBe("packages/core/src/nested/deep.ts");
    expect(definitionOf(mini, "packages/core/src/index.ts", "deeper")).toBe("packages/core/src/nested/deep.ts");
    expect(definitionOf(mini, "packages/core/src/cycle-a.ts", "missing")).toBeNull();
  });

  it("never takes a barrel or a test helper as the source of a package or alias import", () => {
    expect(isBarrel('// re-exports only\nexport * from "./a";\nexport { b as c } from "./b";\nexport * as d from "./d";')).toBe(true);
    expect(isBarrel('export * from "./a";\nexport const x = 1;')).toBe(false);
    expect(["test-utils.ts", "testUtils.ts", "vitestSetup.ts", "setup-tests.ts", "spec_helper.ts"].every(isHelperFile)).toBe(true);
    expect(["setup-server.ts", "utils.ts", "testing.ts"].some(isHelperFile)).toBe(false);
    expect(sourceOf("test/helper-alias.test.ts")).toBeUndefined();
  });

  it("prefers a relative import over a workspace import with more symbols", () => {
    expect(sourceOf("test/relative-first.test.ts")).toBe("src/math.ts");
  });

  it("gives a workspace package whose entry cannot be read its own drop reason", () => {
    expect(sourceOf("test/broken.test.ts")).toBeUndefined();
    expect(packageEntry(mini, "packages/broken", "")).toBeNull();
  });

  it("reads workspace globs with exclusions, includes the root package, never the test runner import", () => {
    const packages = workspacePackages(mini, ["package.json", ...["core", "broken", "ignored", "vitest"].map((p) => `packages/${p}/package.json`)]);
    expect([...packages]).toEqual([
      ["mini-repo", ""],
      ["@mini/core", "packages/core"],
      ["@mini/broken", "packages/broken"],
      ["vitest", "packages/vitest"],
    ]);
    expect(sourceOf("test/ignored.test.ts")).toBeUndefined();
    expect(sourceOf("test/helper-only.test.ts")).toBeUndefined();
  });

  it("maps a built main to src and resolves package subpaths", () => {
    expect(packageEntry(mini, "packages/core", "")).toBe("packages/core/src/index.ts");
    expect(packageEntry(mini, "packages/core", "greet")).toBe("packages/core/src/greet.ts");
    expect(packageEntry(mini, "packages/core", "missing")).toBeNull();
  });

  it("resolves plain prefix and exact tsconfig aliases through extends and JSON with comments", () => {
    expect(sourceOf("test/alias.test.ts")).toBe("src/strings.ts");
    const aliases = tsconfigAliases(mini, "test/alias.test.ts");
    expect(aliases.map((a) => a.key)).toEqual(["~/*", "#strings", "#utils", "outside/*"]);
    expect(applyAlias(aliases, "~/math")).toBe(`${mini}/src/math`);
    expect(applyAlias(aliases, "#strings/more")).toBeNull();
  });

  it("leaves fancy aliases and aliases pointing outside the repo unresolved", () => {
    expect(sourceOf("test/fancy.test.ts")).toBeUndefined();
    expect(isPlainAlias("fancy/*", ["src/*", "lib/*"])).toBe(false);
    expect(isPlainAlias("@two/*/x/*", ["src/*/*"])).toBe(false);
    expect(isPlainAlias("*/mid", ["src/*/mid"])).toBe(false);
    expect(isPlainAlias("a/*", ["src/index.ts"])).toBe(false);
    expect(isPlainAlias("a", "src/a.ts")).toBe(false);
    expect(isPlainAlias("a/*", ["src/*.ts"])).toBe(true);
  });

  it("counts named, default and type imports", () => {
    expect(countSymbols("{ a, b as c, }", "")).toBe(2);
    expect(countSymbols("def, { a }", "")).toBe(2);
    expect(countSymbols("type { T }", "")).toBe(1);
  });
});

describe("dedupe", () => {
  it("drops tests equal after whitespace normalization, across repos, keeping the first", () => {
    const rows = [
      { repo: "a/x", test: "it('x', () => {\n  expect(1).toBe(1)\n})" },
      { repo: "b/y", test: "it('x', () => { expect(1).toBe(1) })   " },
      { repo: "b/y", test: "it('y', () => {})" },
    ];
    const { kept, dropped } = dedupe(rows);
    expect(dropped).toBe(1);
    expect(kept.map((r) => r.repo)).toEqual(["a/x", "b/y"]);
  });
});

describe("license filter", () => {
  const mit = "MIT License\n\nPermission is hereby granted, free of charge, to any person\nTHE SOFTWARE IS PROVIDED \"AS IS\"";
  const bsd = "Redistribution and use in source and binary forms, with or without modification";

  it("names the four allowed licenses from LICENSE text", () => {
    expect(classifyLicense(mit)).toBe("MIT");
    expect(classifyLicense("Apache License\n Version 2.0, January 2004")).toBe("Apache-2.0");
    expect(classifyLicense(bsd)).toBe("BSD-2-Clause");
    expect(classifyLicense(`${bsd}\nNeither the name of the copyright holder`)).toBe("BSD-3-Clause");
  });

  it("treats copyleft, mixed and unknown texts as unclear", () => {
    expect(classifyLicense("GNU GENERAL PUBLIC LICENSE Version 3")).toBeNull();
    expect(classifyLicense(`${mit}\n\nGNU LESSER GENERAL PUBLIC LICENSE`)).toBeNull();
    expect(classifyLicense(`${mit}\n${bsd}`)).toBeNull();
    expect(classifyLicense("All rights reserved.")).toBeNull();
  });

  it("drops a seed whose LICENSE file is missing or disagrees with its declared license", () => {
    expect(checkLicense("MIT", null, "")).toEqual({ ok: false, reason: "license_missing" });
    expect(checkLicense("Apache-2.0", "LICENSE", mit)).toEqual({ ok: false, reason: "license_mismatch" });
    expect(checkLicense("MIT", "LICENSE.md", mit)).toEqual({ ok: true, license: "MIT", file: "LICENSE.md" });
  });
});

describe("stats", () => {
  it("takes nearest-rank percentiles and rounds the ceiling up to 256", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 99)).toBe(99);
    expect(percentile([], 99)).toBe(0);
    expect(ceilingFromP99(23791)).toBe(23808);
    expect(ceilingFromP99(10)).toBe(256);
  });
});
