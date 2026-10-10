import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkLicense, classifyLicense } from "./license.js";
import { countSymbols, pairRepo, resolveImport } from "./pair.js";
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

  it("drops helpers-only, other runners, generated files and snapshots", () => {
    expect(result.tests).toBe(7);
    expect(result.pairs).toHaveLength(3);
    expect(result.drops).toEqual({ no_resolvable_source: 1, not_vitest: 1, generated: 1, snapshot: 1 });
  });

  it("resolves .js specifiers to .ts and refuses paths outside the repo", () => {
    expect(resolveImport(mini, "test/math.test.ts", "../src/math.js")).toBe("src/math.ts");
    expect(resolveImport(mini, "test/math.test.ts", "../../../package.json")).toBeNull();
    expect(resolveImport(mini, "test/math.test.ts", "vitest")).toBeNull();
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
