import { describe, expect, it } from "vitest";
import { generateMutants, langFor, maskLine, type Mutant } from "./mutate.js";

const RUBY = [
  "class Charger",                                   // 1
  "  def charge(amount)",                            // 2
  "    return nil if amount == 0",                   // 3
  "    raise 'too big' if amount > 100",             // 4
  "    ok = amount.positive? && account.present?",   // 5
  "    return :denied unless ok",                    // 6
  "    log('amount == 0 && done')",                  // 7
  "    @receipt = true",                             // 8
  "    return :ok",                                  // 9
  "  end",                                           // 10
  "end",                                             // 11
  "",                                                // 12
].join("\n");

const TS = [
  "export function charge(amount: number): string {", // 1
  "  if (amount === 0) {",                            // 2
  "    return 'zero';",                               // 3
  "  }",                                              // 4
  "  const big = amount > 100 && amount < 1000;",     // 5
  "  const flag = true;",                             // 6
  "  // amount === 0 && flag",                        // 7
  "  const label = 'a === b';",                       // 8
  "  return big ? 'big' : 'small';",                  // 9
  "}",                                                // 10
].join("\n");

const PY = [
  "def charge(amount: int, ok: bool = True) -> str:", // 1
  "    if amount == 0:",                              // 2
  '        return "zero"',                            // 3
  "    if amount > 100 and ok:",                      // 4
  "        return \"big\"  # amount == 0 and ok",     // 5
  "    return charge_slowly(amount)",                 // 6
  "",                                                 // 7
].join("\n");

const GO = [
  "package rates",                                        // 1
  "",                                                     // 2
  "func Charge(amount int, ok bool) error {",             // 3
  "\tif amount == 0 || !ok {",                            // 4
  "\t\treturn err",                                        // 5
  "\t}",                                                   // 6
  "\tdone := true",                                        // 7
  "\tif amount > 100 {",                                   // 8
  "\t\treturn nil",                                        // 9
  "\t}",                                                   // 10
  "\t// amount == 0 && done",                              // 11
  "\tlog(`a == b`, done)",                                 // 12
  "\treturn nil",                                          // 13
  "}",                                                    // 14
  "",                                                     // 15
].join("\n");

function mutate(path: string, source: string, lines: number[], max = 50): Mutant[] {
  return generateMutants({ path, source, lines, max });
}

/** The one line that differs between the original and a mutant. */
function changedLine(original: string, mutant: Mutant): string {
  const before = original.split("\n");
  const after = mutant.source.split("\n");
  expect(after).toHaveLength(before.length);
  const differing = before.map((_, i) => i).filter((i) => before[i] !== after[i]);
  expect(differing).toEqual([mutant.line - 1]);
  return after[mutant.line - 1]!;
}

describe("langFor", () => {
  it("maps the ruby, python, js, go and rust extensions and nothing else", () => {
    expect(langFor("app/models/user.rb")).toBe("ruby");
    expect(langFor("src/shop/rates.py")).toBe("python");
    for (const p of ["a.ts", "a.tsx", "a.js", "a.jsx"]) expect(langFor(p)).toBe("js");
    expect(langFor("cmd/api/main.go")).toBe("go");
    expect(langFor("src/rates.rs")).toBe("rust");
    for (const p of ["a.java", "Makefile"]) expect(langFor(p)).toBeUndefined();
  });
});

describe("generateMutants: python operators", () => {
  it("uses python spellings: != , not (...), True/False, and/or, return None", () => {
    const at = (line: number, op: string) => changedLine(PY, mutate("a.py", PY, [line]).find((m) => m.id.endsWith(op))!);
    expect(at(2, "relational")).toBe("    if amount != 0:");
    expect(at(4, "condition")).toBe("    if not (amount > 100 and ok):");
    expect(at(1, "boolean")).toContain("ok: bool = False");
    expect(at(4, "logical")).toBe("    if amount > 100 or ok:");
    expect(at(6, "return")).toBe("    return None");
  });

  it("leaves every mutant parseable, and never matches inside a comment or a string", () => {
    // Line 5 holds its only ==, its only `and` and its only digit in a trailing
    // comment, and its only literal in a string, so nothing but return applies.
    expect(mutate("a.py", PY, [5]).map((m) => m.id)).toEqual(["m5-return"]);
    for (const m of mutate("a.py", PY, [1, 2, 3, 4, 5, 6])) {
      const line = changedLine(PY, m);
      const original = PY.split("\n")[m.line - 1]!;
      expect(line.length - line.trimStart().length).toBe(original.length - original.trimStart().length);
      expect(line).not.toContain(";");
    }
  });
});

describe("maskLine", () => {
  it("blanks string contents but keeps the line length", () => {
    const line = "  log('amount == 0')";
    const masked = maskLine(line, "ruby");
    expect(masked).toHaveLength(line.length);
    expect(masked).toContain("log(");
    expect(masked).not.toContain("==");
  });

  it("blanks trailing comments", () => {
    expect(maskLine("x = 1 # y == 2", "ruby")).not.toContain("==");
    expect(maskLine("x = 1; // y === 2", "js")).not.toContain("===");
  });

  it("does not treat an escaped quote as the end of a literal", () => {
    expect(maskLine("a = 'it\\'s == fine'", "ruby")).not.toContain("==");
  });
});

describe("generateMutants: ruby operators", () => {
  it("flips a relational operator", () => {
    const [m] = mutate("app/charger.rb", RUBY, [3]);
    expect(m!.id).toBe("m3-relational");
    expect(m!.description).toBe("relational: == to !=");
    expect(changedLine(RUBY, m!)).toBe("    return nil if amount != 0");
  });

  it("flips a boolean literal", () => {
    const m = mutate("app/charger.rb", RUBY, [8]).find((x) => x.id === "m8-boolean")!;
    expect(m.description).toBe("boolean: true to false");
    expect(changedLine(RUBY, m)).toBe("    @receipt = false");
  });

  it("flips a logical operator", () => {
    const m = mutate("app/charger.rb", RUBY, [5]).find((x) => x.id === "m5-logical")!;
    expect(m.description).toBe("logical: && to ||");
    expect(changedLine(RUBY, m)).toContain("amount.positive? || account.present?");
  });

  it("flips and to or in the word form", () => {
    const src = "x = a and b\n";
    const m = mutate("a.rb", src, [1]).find((x) => x.id === "m1-logical")!;
    expect(m.description).toBe("logical: and to or");
    expect(changedLine(src, m)).toBe("x = a or b");
  });

  it("swaps if for unless and unless for if", () => {
    const ifm = mutate("app/charger.rb", RUBY, [3]).find((x) => x.id === "m3-condition")!;
    expect(changedLine(RUBY, ifm)).toBe("    return nil unless amount == 0");
    const unlessm = mutate("app/charger.rb", RUBY, [6]).find((x) => x.id === "m6-condition")!;
    expect(changedLine(RUBY, unlessm)).toBe("    return :denied if ok");
  });

  it("increments an integer literal", () => {
    const m = mutate("app/charger.rb", RUBY, [4]).find((x) => x.id === "m4-numeric")!;
    expect(m.description).toBe("numeric: 100 to 101");
    expect(changedLine(RUBY, m)).toContain("amount > 101");
  });

  it("does not touch digits inside an identifier or a dotted version", () => {
    const src = "VERSION = '1.2.3'\nutf8 = encoding_for(base64)\nx = 1.5\n";
    expect(mutate("a.rb", src, [1, 2, 3]).filter((m) => m.id.endsWith("numeric"))).toEqual([]);
  });

  it("replaces a ruby return value with nil", () => {
    const m = mutate("app/charger.rb", RUBY, [9]).find((x) => x.id === "m9-return")!;
    expect(m.description).toBe("return: value replaced with nil");
    expect(changedLine(RUBY, m)).toBe("    return nil");
  });

  it("does not produce a return mutant when the value is already nil", () => {
    expect(mutate("a.rb", "  return nil\n", [1]).map((m) => m.id)).toEqual([]);
  });

  it("flips present? to blank? and empty? to any?", () => {
    const presentSrc = "  return 1 if user.present?\n";
    const present = mutate("a.rb", presentSrc, [1]).find((m) => m.id === "m1-predicate")!;
    expect(changedLine(presentSrc, present)).toBe("  return 1 if user.blank?");

    const emptySrc = "  x = list.empty?\n";
    const empty = mutate("a.rb", emptySrc, [1]).find((m) => m.id === "m1-predicate")!;
    expect(changedLine(emptySrc, empty)).toBe("  x = list.any?");
  });

  it("negates a standalone nil? line and back again", () => {
    const src = "    user.nil?\n";
    const m = mutate("a.rb", src, [1]).find((x) => x.id === "m1-predicate")!;
    expect(changedLine(src, m)).toBe("    !user.nil?");
    const back = mutate("a.rb", "    !user.nil?\n", [1]).find((x) => x.id === "m1-predicate")!;
    expect(back.source).toBe("    user.nil?\n");
  });

  it("skips a nil? call that is part of a larger expression", () => {
    const src = "    x = a.nil? ? 1 : 2\n";
    expect(mutate("a.rb", src, [1]).filter((m) => m.id.endsWith("predicate"))).toEqual([]);
  });
});

describe("generateMutants: js operators", () => {
  it("flips strict equality", () => {
    const m = mutate("src/charge.ts", TS, [2]).find((x) => x.id === "m2-relational")!;
    expect(m.description).toBe("relational: === to !==");
    expect(changedLine(TS, m)).toBe("  if (amount !== 0) {");
  });

  it("negates an if condition by paren balancing", () => {
    const m = mutate("src/charge.ts", TS, [2]).find((x) => x.id === "m2-condition")!;
    expect(m.description).toBe("condition: if condition negated");
    expect(changedLine(TS, m)).toBe("  if (!(amount === 0)) {");
  });

  it("balances nested parens when negating", () => {
    const src = "if (isBig(a, b) && c) {\n}\n";
    const m = mutate("a.js", src, [1]).find((x) => x.id === "m1-condition")!;
    expect(changedLine(src, m)).toBe("if (!(isBig(a, b) && c)) {");
  });

  it("flips && and the relational operators on a compound line", () => {
    const rel = mutate("src/charge.ts", TS, [5]).find((x) => x.id === "m5-relational")!;
    expect(changedLine(TS, rel)).toBe("  const big = amount <= 100 && amount < 1000;");
    const log = mutate("src/charge.ts", TS, [5]).find((x) => x.id === "m5-logical")!;
    expect(changedLine(TS, log)).toBe("  const big = amount > 100 || amount < 1000;");
  });

  it("flips a boolean literal", () => {
    const m = mutate("src/charge.ts", TS, [6]).find((x) => x.id === "m6-boolean")!;
    expect(changedLine(TS, m)).toBe("  const flag = false;");
  });

  it("replaces a js return value with undefined", () => {
    const m = mutate("src/charge.ts", TS, [3]).find((x) => x.id === "m3-return")!;
    expect(m.description).toBe("return: value replaced with undefined");
    expect(changedLine(TS, m)).toBe("    return undefined;");
  });

  it("leaves a bare return alone", () => {
    expect(mutate("a.ts", "  return;\n", [1]).map((m) => m.id)).toEqual([]);
  });

  it("does not mistake an arrow function or a hash rocket for a comparison", () => {
    expect(mutate("a.ts", "const f = (x) => x;\n", [1]).filter((m) => m.id.endsWith("relational"))).toEqual([]);
    expect(mutate("a.rb", "  { a => b }\n", [1]).filter((m) => m.id.endsWith("relational"))).toEqual([]);
  });

  it("produces no mutants for an unsupported language", () => {
    expect(mutate("a.java", "if (x == 1) {\n    return 2;\n}\n", [1, 2])).toEqual([]);
  });
});

describe("generateMutants: go operators", () => {
  it("flips comparisons, && and ||, true and false, and integers", () => {
    expect(changedLine(GO, mutate("rates.go", GO, [4])[0]!)).toBe("\tif amount != 0 || !ok {");
    const logical = mutate("rates.go", GO, [4]).find((m) => m.id === "m4-logical")!;
    expect(changedLine(GO, logical)).toBe("\tif amount == 0 && !ok {");
    expect(changedLine(GO, mutate("rates.go", GO, [7])[0]!)).toBe("\tdone := false");
    const numeric = mutate("rates.go", GO, [8]).find((m) => m.id === "m8-numeric")!;
    expect(changedLine(GO, numeric)).toBe("\tif amount > 101 {");
  });

  it("swaps a plain return err and return nil, the nil direction only where an err return exists", () => {
    const toNil = mutate("rates.go", GO, [5]).find((m) => m.id === "m5-return-err")!;
    expect(changedLine(GO, toNil)).toBe("\t\treturn nil");
    expect(toNil.description).toBe("return: err to nil");
    const toErr = mutate("rates.go", GO, [9]).find((m) => m.id === "m9-return-err")!;
    expect(changedLine(GO, toErr)).toBe("\t\treturn err");

    // A file with no plain `return err` of its own leaves `return nil` alone:
    // the name would not be in scope and the mutant would not compile.
    const plain = "package x\n\nfunc f() error {\n\treturn nil\n}\n";
    expect(mutate("x.go", plain, [4])).toEqual([]);
    const withErr = `${plain}\nfunc g() error {\n\treturn err\n}\n`;
    expect(changedLine(withErr, mutate("x.go", withErr, [4])[0]!)).toBe("\treturn err");
  });

  it("never mutates a comment, a raw string, or a channel arrow", () => {
    expect(mutate("rates.go", GO, [11, 12])).toEqual([]);
    const chan = "package x\n\nfunc f(c chan int) int {\n\treturn <-c\n}\n";
    expect(mutate("x.go", chan, [4])).toEqual([]);
  });
});

const RUST = [
  "pub fn fee(cents: u8, ok: bool) -> u8 {",         // 1
  "    if cents > 100 && ok {",                      // 2
  "        return 25;",                              // 3
  "    }",                                           // 4
  "    let done: bool = false;",                     // 5
  "    let names: Vec<&'static str> = Vec::new();",  // 6
  "    if let Some(n) = names.first() {",            // 7
  "        println!(\"cents > 100 && ok\");",          // 8
  "    }",                                           // 9
  "    if done { 1 } else { 0 }",                    // 10
  "}",                                               // 11
  "",                                                // 12
].join("\n");

describe("generateMutants: rust operators", () => {
  it("flips comparisons, && and ||, true and false, and negates an if header", () => {
    expect(changedLine(RUST, mutate("rates.rs", RUST, [2])[0]!)).toBe("    if cents <= 100 && ok {");
    const logical = mutate("rates.rs", RUST, [2]).find((m) => m.id === "m2-logical")!;
    expect(changedLine(RUST, logical)).toBe("    if cents > 100 || ok {");
    const negated = mutate("rates.rs", RUST, [2]).find((m) => m.id === "m2-condition")!;
    expect(changedLine(RUST, negated)).toBe("    if !(cents > 100 && ok) {");
    expect(changedLine(RUST, mutate("rates.rs", RUST, [5])[0]!)).toBe("    let done: bool = true;");
  });

  it("leaves generics, lifetimes, if let, comments and typed literals alone", () => {
    // A `<` glued to an identifier is type syntax, and `'static` is a lifetime,
    // not a char literal that would mask the rest of the line.
    expect(mutate("rates.rs", RUST, [6])).toEqual([]);
    // `if let` binds a pattern; `!(let ...)` would not compile.
    expect(mutate("rates.rs", RUST, [7])).toEqual([]);
    // The operators inside the string are masked before matching.
    expect(mutate("rates.rs", RUST, [8])).toEqual([]);
    // No numeric operator: `100u8 + 1` is a deny-by-default overflow lint, and no
    // return operator: Rust has no universal empty value to substitute.
    expect(mutate("rates.rs", RUST, [3])).toEqual([]);
  });
});

describe("generateMutants: bounds and safety", () => {
  it("only mutates the requested lines and leaves every other byte identical", () => {
    const mutants = mutate("app/charger.rb", RUBY, [4]);
    expect(mutants.length).toBeGreaterThan(0);
    for (const m of mutants) {
      expect(m.line).toBe(4);
      changedLine(RUBY, m);
    }
  });

  it("never mutates inside a string literal or a comment", () => {
    // Line 7 of the ruby fixture is entirely a string containing == and &&.
    expect(mutate("app/charger.rb", RUBY, [7])).toEqual([]);
    // Lines 7 and 8 of the TS fixture are a comment and a string.
    expect(mutate("src/charge.ts", TS, [7, 8])).toEqual([]);
  });

  it("stops at max, taking the lowest lines first", () => {
    const capped = mutate("app/charger.rb", RUBY, [3, 4, 5, 8, 9], 3);
    expect(capped).toHaveLength(3);
    expect(capped.map((m) => m.id)).toEqual(["m3-relational", "m3-condition", "m3-numeric"]);
  });

  it("returns nothing for max zero or no eligible lines", () => {
    expect(mutate("app/charger.rb", RUBY, [3], 0)).toEqual([]);
    expect(mutate("app/charger.rb", RUBY, [])).toEqual([]);
    // Line 12 is blank, line 99 is out of range.
    expect(mutate("app/charger.rb", RUBY, [12, 99])).toEqual([]);
  });

  it("is deterministic and ordered by line then operator", () => {
    const once = mutate("app/charger.rb", RUBY, [8, 5, 3]).map((m) => m.id);
    const twice = mutate("app/charger.rb", RUBY, [3, 5, 8]).map((m) => m.id);
    expect(once).toEqual(twice);
    expect(once).toEqual([
      "m3-relational",
      "m3-condition",
      "m3-numeric",
      "m3-return",
      "m5-logical",
      "m5-predicate",
      "m8-boolean",
    ]);
  });
});

describe("generateMutants: compound token scanning", () => {
  it("consumes <=> whole, so the scan resumes at the character just past it", () => {
    // The `<=` starts one character past the spaceship: it is only reached if
    // the scanner steps over all three characters of `<=>` and no more.
    const src = "  r = (a <=><= b)\n";
    const m = mutate("a.rb", src, [1]).find((x) => x.id === "m1-relational")!;
    expect(m.description).toBe("relational: <= to >");
    expect(changedLine(src, m)).toBe("  r = (a <=>> b)");
  });

  it("consumes === whole outside js, leaving it unflipped and resuming just past it", () => {
    const src = "  ok = (a ===<= b)\n";
    const m = mutate("a.rb", src, [1]).find((x) => x.id === "m1-relational")!;
    expect(m.description).toBe("relational: <= to >");
    expect(changedLine(src, m)).toBe("  ok = (a ===> b)");
  });
});

describe("matchingParen", () => {
  it("skips the if condition operator when the paren closes on a later line", () => {
    const src = "if (isBig(a, b) &&\n    c) {\n}\n";
    const mutants = mutate("a.ts", src, [1]);
    // No condition mutant: the `(` never closes on line 1, so there is nothing to negate.
    expect(mutants.map((m) => m.id)).toEqual(["m1-logical"]);
    expect(changedLine(src, mutants[0]!)).toBe("if (isBig(a, b) ||");
  });
});
