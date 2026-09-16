import { describe, expect, it } from "vitest";
import { assertionKinds, exercisesCode, ruleViolations, rules, rulesFor, rulesText, stripLineComments, verdictFor } from "./rules.js";
import type { RunnerName } from "./types.js";

/** Violation messages for one candidate, in the "id: message" shape the pipeline joins. */
const check = (code: string, runner: RunnerName, disabled?: string[]) =>
  ruleViolations(code, runner, disabled).map((v) => `${v.id}: ${v.message}`);

const ids = (violations: string[]) => violations.map((v) => v.split(":")[0]);

const cleanJs = `
import { describe, expect, it } from "vitest";
describe("adder", () => {
  it("adds", () => {
    expect(add(1, 2)).toBe(3);
  });
});
`;

const cleanRuby = `
RSpec.describe Adder do
  it "adds" do
    expect(described_class.new.add(1, 2)).to eq(3)
  end
end
`;

describe("rules registry", () => {
  it("passes clean code in both language families", () => {
    expect(check(cleanJs, "vitest")).toEqual([]);
    expect(check(cleanRuby, "rspec")).toEqual([]);
  });

  it("has a unique id and a description for every rule", () => {
    const seen = new Set(rules.map((r) => r.id));
    expect(seen.size).toBe(rules.length);
    for (const rule of rules) expect(rule.description.length).toBeGreaterThan(10);
  });

  it("rulesFor returns every rule a runner is in scope for", () => {
    // no-os-specific is the one runner-scoped rule: rspec and cargo are out of it.
    for (const runner of ["vitest", "bun", "jest", "go", "pytest"] as const) {
      expect(rulesFor(runner).length).toBe(rules.length);
    }
    for (const runner of ["rspec", "cargo"] as const) {
      expect(rulesFor(runner).map((r) => r.id)).not.toContain("no-os-specific");
      expect(rulesFor(runner).length).toBe(rules.length - 1);
    }
  });
});

describe("no-sleep", () => {
  it("flags ruby sleep", () => {
    expect(ids(check(`${cleanRuby}\nsleep 1\n`, "rspec"))).toContain("no-sleep");
  });

  it("flags setTimeout without fake timers", () => {
    const code = cleanJs.replace("expect(add(1, 2)).toBe(3);", "await new Promise((r) => setTimeout(r, 50));\n    expect(add(1, 2)).toBe(3);");
    expect(ids(check(code, "vitest"))).toContain("no-sleep");
  });

  it("allows setTimeout when fake timers are installed", () => {
    const code = `vi.useFakeTimers();\n${cleanJs}\nsetTimeout(fn, 50);`;
    expect(ids(check(code, "vitest"))).not.toContain("no-sleep");
  });
});

describe("no-deadline-poll", () => {
  // The shape this exists for: a generated Go test that passed one CI run and
  // failed the next, because 10 attempts times 50ms is a wall-clock bet on an
  // idle machine, and pass^k on one machine cannot see that.
  const goPoll = `
func TestReady(t *testing.T) {
	for i := 0; i < 10; i++ {
		if ready(queue) {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("never became ready")
}
`;

  it("flags a fixed attempt count with a sleep and no deadline", () => {
    const found = check(goPoll, "go");
    expect(ids(found)).toContain("no-deadline-poll");
    expect(found.join("\n")).toContain("runner contention");
  });

  it("allows the same loop when a context timeout bounds the wait", () => {
    const bounded = goPoll.replace("for i := 0; i < 10; i++ {", "ctx, cancel := context.WithTimeout(context.Background(), time.Second)\n\tdefer cancel()\n\tfor ctx.Err() == nil {");
    expect(ids(check(bounded, "go"))).not.toContain("no-deadline-poll");
  });

  it("reads the JS deadline and flags the Ruby times-loop that has none", () => {
    const js = 'for (let i = 0; i < 20; i++) { if (done()) break; await sleep(10); }\nconst deadline = Date.now() - 1;\nexpect(done()).toBe(true);';
    expect(ids(check(js, "vitest"))).not.toContain("no-deadline-poll");
    const ruby = "20.times do\n  break if done?\n  sleep 0.05\nend\nexpect(done?).to eq(true)";
    expect(ids(check(ruby, "rspec"))).toContain("no-deadline-poll");
  });

  it("leaves a sleep with no attempt loop to no-sleep alone", () => {
    const found = ids(check(`${cleanRuby}\nsleep 1\n`, "rspec"));
    expect(found).toContain("no-sleep");
    expect(found).not.toContain("no-deadline-poll");
  });
});

describe("no-real-network", () => {
  it("flags an unstubbed fetch", () => {
    const code = cleanJs.replace("expect(add(1, 2)).toBe(3);", 'const r = await fetch("https://example.com");\n    expect(r.ok).toBe(true);');
    expect(ids(check(code, "vitest"))).toContain("no-real-network");
  });

  it("allows fetch when the file stubs it", () => {
    const code = `vi.stubGlobal("fetch", vi.fn());\n${cleanJs.replace("expect(add(1, 2)).toBe(3);", 'const r = await fetch("/x");\n    expect(r).toBeDefined();')}`;
    expect(ids(check(code, "vitest"))).not.toContain("no-real-network");
  });

  it("flags Net::HTTP without WebMock and allows it with stub_request", () => {
    const live = `${cleanRuby}\nNet::HTTP.get(uri)\n`;
    expect(ids(check(live, "rspec"))).toContain("no-real-network");
    expect(ids(check(`stub_request(:get, "http://x")\n${live}`, "rspec"))).not.toContain("no-real-network");
  });
});

describe("no-real-clock", () => {
  it("flags Date.now without fake timers", () => {
    expect(ids(check(`${cleanJs}\nconst t = Date.now();`, "vitest"))).toContain("no-real-clock");
  });

  it("allows Time.now under travel_to", () => {
    const code = `travel_to(Time.zone.parse("2020-01-01")) do\n${cleanRuby}\n  Time.now\nend`;
    expect(ids(check(code, "rspec"))).not.toContain("no-real-clock");
  });
});

describe("no-skipped-tests", () => {
  it("flags it.skip, xit and pending", () => {
    expect(ids(check(`${cleanJs}\nit.skip("later", () => { expect(1).toBe(2); });`, "vitest"))).toContain("no-skipped-tests");
    expect(ids(check(`${cleanRuby}\nxit "later" do\n  expect(1).to eq(2)\nend`, "rspec"))).toContain("no-skipped-tests");
    expect(ids(check(`${cleanRuby}\npending "not yet"`, "rspec"))).toContain("no-skipped-tests");
  });
});

describe("no-tautology", () => {
  it("flags expect(true).toBe(true) and expect(1).toBe(1)", () => {
    expect(ids(check("it('x', () => { expect(true).toBe(true); });", "vitest"))).toContain("no-tautology");
    expect(ids(check("it('x', () => { expect(1).toBe(1); });", "vitest"))).toContain("no-tautology");
  });

  it("flags the rspec form", () => {
    expect(ids(check("it 'x' do\n  expect(true).to be_truthy\nend", "rspec"))).toContain("no-tautology");
    expect(ids(check("it 'x' do\n  expect(nil).to eq(nil)\nend", "rspec"))).toContain("no-tautology");
  });

  it("does not flag a real comparison against a literal", () => {
    expect(ids(check("it('x', () => { expect(add(1, 2)).toBe(3); });", "vitest"))).not.toContain("no-tautology");
  });
});

describe("no-snapshot-only", () => {
  it("flags a snapshot with no other assertion", () => {
    const code = "it('renders', () => { expect(render(<A />)).toMatchSnapshot(); });";
    expect(ids(check(code, "jest"))).toContain("no-snapshot-only");
  });

  it("allows a snapshot alongside a real assertion", () => {
    const code = "it('renders', () => { expect(view.title).toBe('hi'); expect(view).toMatchSnapshot(); });";
    expect(ids(check(code, "jest"))).not.toContain("no-snapshot-only");
  });
});

describe("has-assertion", () => {
  it("flags a file with no assertion", () => {
    expect(ids(check("it('does a thing', () => { doThing(); });", "vitest"))).toContain("has-assertion");
  });

  it("accepts rspec is_expected and should forms", () => {
    expect(ids(check("it { is_expected.to be_valid }", "rspec"))).not.toContain("has-assertion");
  });
});

describe("stripLineComments", () => {
  it("removes line comments so prose does not trip a rule", () => {
    expect(stripLineComments("const a = 1; // sleep here\n# Time.now is fine")).not.toMatch(/sleep|Time\.now/);
  });

  it("keeps a rule from firing on a comment", () => {
    expect(ids(check(`${cleanJs}\n// do not use Date.now() here`, "vitest"))).not.toContain("no-real-clock");
  });
});

/**
 * Three specs for one imaginary module: one that proves the code ran, one that
 * describes the shape of a declaration, and one that exercises behavior.
 */
const tautologicalSpec = `
import { describe, expect, it } from "vitest";
import { shorten } from "./slugs.js";
describe("shorten", () => {
  it("works", () => {
    expect(shorten("a-very-long-title", 8)).toBeDefined();
    expect(() => shorten("x", 2)).not.toThrow();
  });
});
`;

const declarationSpec = `
import { describe, expect, it } from "vitest";
import { SCHEMA } from "./slugs.js";
describe("SCHEMA", () => {
  it("has the expected shape", () => {
    expect(Object.keys(SCHEMA)).toHaveLength(3);
    expect(typeof SCHEMA.max).toBe("number");
  });
});
`;

const behavioralSpec = `
import { describe, expect, it } from "vitest";
import { shorten } from "./slugs.js";
describe("shorten", () => {
  it("truncates on a word boundary", () => {
    expect(shorten("a-very-long-title", 8)).toBe("a-very");
  });
});
`;

describe("assertionKinds", () => {
  it("names the matcher behind every assertion, in both language families", () => {
    expect(assertionKinds(behavioralSpec)).toEqual(["toBe"]);
    expect(assertionKinds(tautologicalSpec)).toEqual(["toBeDefined", "not.toThrow"]);
    expect(assertionKinds(declarationSpec)).toEqual(["toHaveLength", "toBe"]);
    expect(assertionKinds("it 'x' do\n  expect(described_class.new.tier(9)).to eq(:gold)\nend")).toEqual(["eq"]);
    expect(assertionKinds("it { is_expected.not_to be_valid }")).toEqual(["not_to be_valid"]);
  });

  it("counts two assertions on one line separately", () => {
    const code = "it('x', () => { expect(render(p)).toMatchSnapshot(); expect(title(p)).toBe('hi'); });";
    expect(assertionKinds(code)).toEqual(["toMatchSnapshot", "toBe"]);
  });

  it("names a value compared to itself for what it is", () => {
    expect(assertionKinds("expect(user.id).toBe(user.id);")).toEqual(["self-comparison"]);
    expect(assertionKinds("expect(user.id).toBe(other.id);")).toEqual(["toBe"]);
  });

  it("reports nothing for a test with no assertion, and ignores commented ones", () => {
    expect(assertionKinds("it('x', () => { doThing(1); });")).toEqual([]);
    expect(assertionKinds("// expect(a).toBe(b)")).toEqual([]);
  });
});

describe("no-os-specific", () => {
  const procfs = `func TestLimit(t *testing.T) {
	data, err := os.ReadFile("/proc/self/limits")
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	if got := ParseLimit(string(data)); got != 1024 {
		t.Errorf("ParseLimit() = %d, want 1024", got)
	}
}`;

  const guarded = `func TestLimit(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("/proc/self/limits only exists on Linux")
	}
	data, err := os.ReadFile("/proc/self/limits")
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	if got := ParseLimit(string(data)); got != 1024 {
		t.Errorf("ParseLimit() = %d, want 1024", got)
	}
}`;

  it("rejects a Go test that reads procfs, and accepts the same test behind a skip", () => {
    const found = ruleViolations(procfs, "go");
    expect(found.map((v) => v.id)).toEqual(["no-os-specific"]);
    expect(found[0]?.message).toContain("/proc");
    expect(verdictFor(found)).toBe("os_specific");
    expect(check(guarded, "go")).toEqual([]);
  });

  it("rejects a syscall constant, the Keychain and a hardcoded path limit", () => {
    const syscall = `func TestFlag(t *testing.T) {\n\tif got := OpenFlags(syscall.O_NOATIME); got != 1 {\n\t\tt.Errorf("OpenFlags() = %d, want 1", got)\n\t}\n}`;
    const keychain = `func TestKey(t *testing.T) {\n\tout, err := exec.Command("security", "find-generic-password", "-s", "svc").Output()\n\tif err != nil {\n\t\tt.Fatalf("security error = %v", err)\n\t}\n\tif got := ParseKey(string(out)); got != "k" {\n\t\tt.Errorf("ParseKey() = %q, want \\"k\\"", got)\n\t}\n}`;
    const pathMax = `func TestPath(t *testing.T) {\n\tif got := len(BuildPath("a")); got >= PATH_MAX {\n\t\tt.Errorf("len(BuildPath()) = %d, want under the limit", got)\n\t}\n}`;
    expect(ids(check(syscall, "go"))).toContain("no-os-specific");
    expect(ids(check(keychain, "go"))).toContain("no-os-specific");
    expect(ids(check(pathMax, "go"))).toContain("no-os-specific");
  });

  it("rejects a runtime.GOOS branch that skips nothing", () => {
    const branching = `func TestSeparator(t *testing.T) {\n\twant := "/tmp/a"\n\tif runtime.GOOS == "windows" {\n\t\twant = "C:\\\\tmp\\\\a"\n\t}\n\tif got := JoinPath("tmp", "a"); got != want {\n\t\tt.Errorf("JoinPath() = %q, want %q", got, want)\n\t}\n}`;
    const found = ruleViolations(branching, "go");
    expect(found.map((v) => v.id)).toEqual(["no-os-specific"]);
    expect(found[0]?.message).toContain("t.Skip");
  });

  it("applies a lighter version to the Node and Python runners, and not to rspec", () => {
    const js = `it("reads the limit", () => {\n  expect(parseLimit(readFileSync("/proc/self/limits", "utf8"))).toBe(1024);\n});`;
    const py = `def test_limit():\n    with open("/proc/self/limits") as fh:\n        assert parse_limit(fh.read()) == 1024\n`;
    const pyGuarded = `def test_limit():\n    if sys.platform == "linux":\n        with open("/proc/self/limits") as fh:\n            assert parse_limit(fh.read()) == 1024\n`;
    expect(ids(check(js, "vitest"))).toContain("no-os-specific");
    expect(ids(check(js, "jest"))).toContain("no-os-specific");
    expect(ids(check(py, "pytest"))).toContain("no-os-specific");
    expect(ids(check(pyGuarded, "pytest"))).not.toContain("no-os-specific");
    // The rule is off for rspec, so the same text only trips the generic rules.
    expect(ids(check(py.replace("def test_limit():", 'it "reads" do'), "rspec"))).not.toContain("no-os-specific");
  });

  it("leaves a portable test alone, and is turned off by disable_rules", () => {
    const portable = `func TestFee(t *testing.T) {\n\tdir := t.TempDir()\n\tif got := WriteFee(dir, 25); got != 25 {\n\t\tt.Errorf("WriteFee() = %d, want 25", got)\n\t}\n}`;
    expect(check(portable, "go")).toEqual([]);
    expect(verdictFor(ruleViolations(procfs, "go", ["no-os-specific"]))).toBeUndefined();
  });
});

describe("rulesText", () => {
  it("renders one bullet per rule under a heading", () => {
    const text = rulesText("rspec");
    expect(text).toMatch(/^Rules every generated test must follow:/);
    expect(text.split("\n").filter((l) => l.startsWith("- ")).length).toBe(rulesFor("rspec").length);
  });
});

describe("behavioral-evidence", () => {
  it("tells the three specs apart: weak matchers, a declaration, real behavior", () => {
    const weak = ruleViolations(tautologicalSpec, "vitest");
    expect(weak.map((v) => v.id)).toContain("behavioral-evidence");
    expect(verdictFor(weak)).toBe("tautological");
    expect(weak.find((v) => v.id === "behavioral-evidence")?.message).toContain("toBeDefined");

    expect(verdictFor(ruleViolations(declarationSpec, "vitest"))).toBe("declaration_snapshot");
    expect(exercisesCode(declarationSpec)).toBe(false);

    expect(check(behavioralSpec, "vitest")).toEqual([]);
    expect(exercisesCode(behavioralSpec)).toBe(true);
  });

  it("counts a call inside an expectation, and not the matcher's own arguments", () => {
    expect(exercisesCode("expect(shorten('title', 8)).toBe('title');")).toBe(true);
    expect(exercisesCode("expect(VERSION).toBe('1.2.0');")).toBe(false);
    expect(exercisesCode("expect(described_class.new.tier(9)).to eq(:gold)")).toBe(true);
    expect(exercisesCode("expect(config.max).to eq(3)")).toBe(false);
  });

  it("leaves an honest assertion on a falsy value alone", () => {
    const nils = 'it("is missing", () => { expect(lookup({}, "k")).toBeNull(); expect(lookup({}, "k")).toBeFalsy(); });';
    expect(check(nils, "vitest")).toEqual([]);
    expect(check('it "is empty" do\n  expect(described_class.new.tier(0)).to be_nil\nend', "rspec")).toEqual([]);
  });

  it("reports the specific verdict when a text rule fires alongside it", () => {
    const found = ruleViolations('it("renders", () => { expect(render(props)).toMatchSnapshot(); });', "vitest");
    expect(found.map((v) => v.id)).toEqual(["no-snapshot-only", "behavioral-evidence"]);
    // Both messages travel in the error; the status names the more specific one.
    expect(verdictFor(found)).toBe("tautological");
  });

  it("is turned off by disable_rules, leaving every other rule on", () => {
    expect(verdictFor(ruleViolations(tautologicalSpec, "vitest", ["behavioral-evidence"]))).toBeUndefined();
    expect(rulesFor("vitest", ["behavioral-evidence"]).length).toBe(rules.length - 1);
    expect(rulesText("vitest", ["behavioral-evidence"])).not.toContain("Proving a value exists");
    const withSleep = `${tautologicalSpec}\nsleep(1);`;
    expect(verdictFor(ruleViolations(withSleep, "vitest", ["behavioral-evidence"]))).toBe("rule_violation");
  });

  it("says nothing about a test with no assertion, which has-assertion already rejects", () => {
    expect(ruleViolations("it('x', () => { doThing(1); });", "vitest").map((v) => v.id)).toEqual(["has-assertion"]);
  });
});

describe("matcherOf", () => {
  it("names a Go failure call and a bare assert when no matcher is present", () => {
    const goTest = 'if got := Add(1, 2); got != 3 {\n  t.Errorf("Add(1, 2) = %d", got)\n}';
    expect(assertionKinds(goTest)).toEqual(["t.Errorf"]);
    expect(assertionKinds("assert_equal 3, add(1, 2)")).toEqual(["assert_equal"]);
  });
});

describe("isRuby", () => {
  it("is true only for the ruby runners", async () => {
    const { isRuby } = await import("./rules.js");
    expect(isRuby("rspec")).toBe(true);
    expect(isRuby("vitest")).toBe(false);
    expect(isRuby("jest")).toBe(false);
  });
});
