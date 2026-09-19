import { describe, expect, it } from "vitest";
import { goCases, jsCases, pytestCases } from "./cases.js";

describe("jsCases", () => {
  it("finds it and test blocks with their line numbers", () => {
    const text = [
      'describe("rates", () => {',
      '  it("adds the rate", () => {',
      "    expect(1).toBe(1);",
      "  });",
      "",
      "  test('rounds down', () => {});",
      "  it.only(`handles zero`, () => {});",
      "});",
    ].join("\n");
    expect(jsCases(text)).toEqual([
      { name: "adds the rate", line: 2 },
      { name: "rounds down", line: 6 },
      { name: "handles zero", line: 7 },
    ]);
  });

  it("ignores describe blocks and a name that is not a literal", () => {
    expect(jsCases('describe("rates", () => {});\nit(name, () => {});')).toEqual([]);
  });

  it("keeps an escaped quote inside the name", () => {
    expect(jsCases('it("won\\"t throw", () => {});')).toEqual([{ name: 'won\\"t throw', line: 1 }]);
  });
});

describe("goCases", () => {
  it("finds TestXxx functions and nothing else", () => {
    const text = ["package rates", "", "func TestApplyRate(t *testing.T) {}", "", "func helper() {}", "func BenchmarkApplyRate(b *testing.B) {}"].join("\n");
    expect(goCases(text)).toEqual([{ name: "TestApplyRate", line: 3 }]);
  });
});

describe("pytestCases", () => {
  it("finds test functions, including async and method-shaped ones", () => {
    const text = ["def test_rate():", "    pass", "", "async def test_async_rate():", "    pass", "", "def helper():", "    pass"].join("\n");
    expect(pytestCases(text)).toEqual([
      { name: "test_rate", line: 1 },
      { name: "test_async_rate", line: 4 },
    ]);
  });
});
