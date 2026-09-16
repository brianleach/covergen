/**
 * Validator rules registry (AutoCover's "rules" agent, trimmed to what a regex can see).
 *
 * Every rule is a one-line rationale plus a `test` that returns a violation message
 * or null. The same registry feeds two consumers: `checkRules` runs it over a
 * generated candidate, and `rulesText` renders it into the stable prompt block so
 * the model is told the rules before it writes anything.
 *
 * These are heuristics on text, not an AST. They are deliberately biased toward
 * false negatives: a rule that fires on legitimate code costs a wasted repair round.
 */

import type { CandidateStatus, RunnerName } from "./types.js";

/** The candidate status a rule violation produces. */
export type RuleStatus = Extract<
  CandidateStatus,
  "rule_violation" | "tautological" | "declaration_snapshot" | "os_specific"
>;

/** One rule firing on one candidate. */
export interface RuleViolation {
  id: string;
  status: RuleStatus;
  message: string;
}

export interface Rule {
  id: string;
  /** One line, written to be pasted straight into the prompt. */
  description: string;
  /** Which runner(s) the rule applies to. "all" (the default) applies everywhere. */
  runner?: RunnerName | readonly RunnerName[] | "all";
  /** The status a violation of this rule produces, unless `test` names another. */
  status: RuleStatus;
  /** Returns a violation message, or null when the code is clean. */
  test: (code: string) => string | { message: string; status: RuleStatus } | null;
}

const rubyRunners: RunnerName[] = ["rspec"];

export function isRuby(runner: RunnerName): boolean {
  return rubyRunners.includes(runner);
}

/**
 * Drop line comments so a rule does not fire on prose. String literals are left
 * alone: stripping them correctly needs a real lexer, and a rule firing inside a
 * string is rare enough to accept.
 */
export function stripLineComments(code: string): string {
  return code
    .split("\n")
    .map((line) => line.replace(/\s*(?:\/\/|#)\s.*$/, ""))
    .join("\n");
}

function has(code: string, pattern: RegExp): boolean {
  return pattern.test(code);
}

/** Any recognizable assertion, in either language family. */
const ASSERTION =
  /\bexpect\s*\(|\bexpect\s*\{|\bassert[._(!]|\bassert\s+\S|\bis_expected\b|\.should\b|\bexpect\(.+\)\.to\b|\bt\.(?:Error|Errorf|Fatal|Fatalf)\s*\(/;

/** Test doubles / stubs that make an otherwise-live call hermetic. */
const STUB = /stub_request|WebMock|webmock|vi\.mock|vi\.spyOn|vi\.stubGlobal|jest\.mock|jest\.spyOn|mock\.module|spyOn\s*\(|nock\s*\(|msw|setupServer|fetchMock|mockResolvedValue|mockImplementation|allow\s*\(|instance_double|double\s*\(|monkeypatch\.|mocker\.|MagicMock|unittest\.mock|\bpatch\s*\(|\bresponses\b|httptest\./;

/**
 * The three halves of a retry loop with no deadline, which the pass^k gate cannot
 * see: k runs on one idle machine all pass, and the same test fails the first time
 * it shares a runner with something else.
 */

/** Any sleep, in any of the languages a runner covers. */
const SLEEP = /\bsleep\s*[(\s]|\btime\.Sleep\s*\(|\bthread\.sleep\s*\(|\bsleep!\s*\(|std::thread::sleep|\basyncio\.sleep\s*\(/i;

/** A loop with a bound counted in attempts rather than in time. */
const FIXED_ATTEMPTS =
  /for\s+\w+\s*:?=\s*0\s*;[^;]*<\s*\d+|for\s*\(\s*(?:let|var|const|int)\s+\w+\s*=\s*0\s*;[^;]*<\s*\d+|for\s+\w+\s+in\s+range\s*\(\s*\d+|for\s+_\s+in\s+0\s*\.\.=?\s*\d+|\b\d+\s*\.times\b|\bfor\s+\w+\s+in\s+1\s*\.\.\s*\d+/;

/** Something that bounds the wait in wall-clock time instead of in attempts. */
const DEADLINE =
  /WithTimeout|WithDeadline|context\.Deadline|time\.After|time\.Now\s*\(\s*\)\s*\.\s*(?:Before|After|Sub)|Deadline\s*\(|\bdeadline\b|Date\.now\s*\(\s*\)\s*[-<>]|performance\.now|AbortSignal\.timeout|\bwaitFor\s*\(|vi\.waitFor|\bEventually\b|Instant::now|\btimeout\b/i;

/** Time control: fake timers, or Rails/ActiveSupport time travel. */
const FAKE_TIME =
  /useFakeTimers|setSystemTime|advanceTimersBy|travel_to|travel\s*\(|freeze_time|Timecop|vi\.setSystemTime|jest\.setSystemTime|freezegun/;

/**
 * Portability: what a test reaches for that only one operating system has.
 *
 * A suite that runs on a Linux runner and a macOS runner sees both, so a test
 * written against one of them passes on the machine that generated it and fails
 * on the other. The Go list is the long one because Go tests reach for the host
 * directly; a Node or Python test can only trip the paths and the host binaries,
 * so those two runners get the same list minus what their language cannot say.
 */
const OS_SPECIFIC: { pattern: RegExp; what: string }[] = [
  {
    pattern: /(?:^|[^\w.:/])\/(?:proc|sys)\//m,
    what: "reads a /proc or /sys path, which Linux has and macOS does not",
  },
  {
    pattern: /\bsyscall\.[A-Z]\w*/,
    what: "uses a syscall constant, whose value and whose existence differ per operating system",
  },
  {
    pattern: /\bKeychain\b|\bkeychain\b|find-generic-password|\bsecurity\s+(?:add|find|delete)-/,
    what: "reaches the macOS Keychain or the security binary, which no Linux runner has",
  },
  {
    pattern: /\bPATH_MAX\b|\bMAX_PATH\b/,
    what: "hardcodes a path length limit, which is not the same number on every operating system",
  },
];

/** The skip that keeps platform behavior off the runner that does not have it. */
const SKIP_CALL = /\bt\.Skipf?\s*\(|\btesting\.Short\s*\(\s*\)/;

/** A check on which operating system the test is running: Go, Node, Python. */
const PLATFORM_CHECK = /\bruntime\.GOOS\b|\bprocess\.platform\b|\bsys\.platform\b|\bplatform\.system\s*\(/;

/**
 * True when the platform-specific code is fenced off. Go has to skip, because a
 * `runtime.GOOS` branch that asserts something else still runs everywhere. Node
 * and Python cannot skip at all (no-skipped-tests forbids it), so a check on the
 * platform around the assertion is the guard those two have.
 */
export function guardsPlatform(code: string): boolean {
  if (/\bruntime\.GOOS\b/.test(code)) return SKIP_CALL.test(code);
  return PLATFORM_CHECK.test(code);
}

/**
 * Assertion analysis, for the run report: what kind of check each assertion makes.
 *
 * Read off the text, without an AST. The matcher name is what distinguishes a test
 * that pins behavior (toBe, toEqual, raise_error) from one that only proves the
 * line ran (toBeDefined, a snapshot, a value compared to itself), so the report
 * names it per accepted spec and the reviewer can see it without opening the file.
 *
 * Known misses, all deliberate: an assertion whose matcher is on a later line more
 * than 400 characters away reads as `unknown`, a Ruby matcher used without a `to`
 * or `not_to` is not seen, and a custom matcher is reported under its own name.
 */

/** Where an assertion starts. Global: a line can hold more than one. */
const ASSERTION_START = /\bexpect\s*[({]|\bassert[._(!]|\bassert\s+\S|\bis_expected\b|\.should\b|\bt\.(?:Error|Errorf|Fatal|Fatalf)\s*\(/g;
const SELF_COMPARISON =
  /expect\s*\(\s*([^()]+?)\s*\)\s*\.\s*(?:toBe|toEqual|toStrictEqual)\s*\(\s*([^()]+?)\s*\)|expect\s*\(\s*([^()]+?)\s*\)\s*\.\s*to\s+(?:eq|eql|equal|be)\s*\(\s*([^()]+?)\s*\)/;

/** The matcher one assertion uses, normalized. Undefined when none is recognizable. */
export function matcherOf(text: string): string | undefined {
  const self = text.match(SELF_COMPARISON);
  if (self) {
    const left = self[1] ?? self[3];
    const right = self[2] ?? self[4];
    if (left !== undefined && left === right) return "self-comparison";
  }
  const js = text.match(/\.\s*(not|resolves|rejects)?\s*\.?\s*(to[A-Z]\w*)\s*\(/);
  if (js) return js[1] === "not" ? `not.${js[2]}` : js[2];
  const ruby = text.match(/\.\s*(to|to_not|not_to)\s+([a-z_][\w?]*)/);
  if (ruby) return ruby[1] === "to" ? (ruby[2] as string) : `not_to ${ruby[2]}`;
  // Go has no matchers: the assertion is the `if` above the failure call, so the
  // reported name is the call itself.
  const go = text.match(/\bt\.(Errorf?|Fatalf?)\s*\(/);
  if (go) return `t.${go[1] as string}`;
  const bare = text.match(/\b(assert_[a-z_]+|assert)\b/);
  return bare ? (bare[1] as string) : undefined;
}

/**
 * One entry per assertion in `code`, in source order. Each assertion is classified
 * from its own text up to the next assertion, so two on one line are two entries
 * and a chain broken over several lines is one.
 */
export function assertionKinds(code: string): string[] {
  const c = stripLineComments(code);
  const starts = [...c.matchAll(ASSERTION_START)].map((m) => m.index ?? 0);
  return starts.map((start, i) => {
    const end = i + 1 < starts.length ? (starts[i + 1] as number) : c.length;
    return matcherOf(c.slice(start, Math.min(end, start + 400))) ?? "unknown";
  });
}

/**
 * Behavioral evidence: does this candidate call the code under test with an input,
 * and does anything it asserts fail when that code breaks?
 *
 * Two questions, one pass over the text: a test that never calls the code describes
 * a declaration, and a test that calls it and only checks the result exists
 * describes nothing at all. Either way the suite gains a covered line and no
 * ability to notice a regression, which is what decision 18 rules out.
 */

/**
 * Matchers that pass whatever the code did. `toBeFalsy`, `toBeNull` and `be_nil`
 * are deliberately absent: asserting that a lookup came back empty is the honest
 * way to pin that behavior.
 */
const WEAK_MATCHERS = new Set([
  "toBeDefined", "not.toBeUndefined", "toBeTruthy", "not.toThrow", "not.toThrowError",
  "toMatchSnapshot", "toMatchInlineSnapshot", "self-comparison",
  "be_truthy", "be_present", "match_snapshot", "not_to raise_error", "not_to be_nil",
]);

/**
 * Callees that prove nothing about the code under test: the framework, the stubbing
 * helpers, and the builtins a shape assertion is written with. Only the head of a
 * chain is looked up, so `Object.keys(...)` and `vi.fn()` are both inert.
 */
const INERT_CALLEE =
  /^(?:describe|context|it|test|specify|expect|before|beforeEach|beforeAll|after|afterEach|afterAll|let|let!|subject|require|import|typeof|console|process|Object|JSON|Array|String|Number|Boolean|Promise|Set|Map|Date|Math|vi|jest|mock|spyOn|allow|double|instance_double|stub_request|travel_to|freeze_time|pytest|monkeypatch|mocker|patch|Mock|MagicMock|print|len|str|int|float|bool|list|dict|tuple|sorted|repr|type|isinstance|getattr|range|t|testing|httptest)$/;

/**
 * A call: the callee chain, then a lookahead at what the argument list opens with.
 * The lookbehind keeps a chained matcher (`.toBe(3)`) from reading as a call, and
 * the argument is looked at but never consumed, so `add(1)` inside `expect(add(1))`
 * is still found.
 */
const CALL = /(?<![\w.$)\]])([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$!?]*)*)\s*\(\s*(?=(\S?))/g;

/** RSpec's ways of naming the code under test without a call this can see. */
const RUBY_SUBJECT = /\bis_expected\b|\bsubject\b|\bdescribed_class\b/;

/**
 * True when something in `code` calls the code under test with an input. Known
 * misses, all in the direction of accepting: a matcher argument (`.to eq(3)`) is
 * not a call, a zero-argument call reads as no input unless it is a constructor,
 * and any RSpec subject idiom counts because Ruby calls a method without
 * parentheses and this cannot tell that from a property read.
 */
export function exercisesCode(code: string): boolean {
  const c = stripLineComments(code);
  if (RUBY_SUBJECT.test(c) || /\bnew\s+[A-Z]/.test(c)) return true;
  for (const m of c.matchAll(CALL)) {
    const callee = m[1] as string;
    const start = m.index ?? 0;
    // An RSpec matcher takes arguments too, and those are the expected value.
    if (/\b(?:to|to_not|not_to|and|or)\s+$/.test(c.slice(Math.max(0, start - 10), start))) continue;
    if (INERT_CALLEE.test(callee.split(".")[0] as string)) continue;
    // An empty argument list passes no input.
    if (m[2] === "" || m[2] === ")") continue;
    return true;
  }
  return false;
}

export const rules: Rule[] = [
  {
    id: "no-sleep",
    status: "rule_violation",
    description: "Never sleep or wait on a timer. Drive time with fake timers or by calling the code directly.",
    test: (code) => {
      const c = stripLineComments(code);
      if (has(c, /\bsleep[\s(]|\btime\.Sleep\s*\(/)) return "uses sleep; tests must not wait on wall-clock time";
      if (has(c, /setTimeout\s*\(/) && !has(c, FAKE_TIME)) {
        return "uses setTimeout without fake timers; tests must not wait on wall-clock time";
      }
      if (has(c, /setInterval\s*\(/)) return "uses setInterval; tests must not wait on wall-clock time";
      return null;
    },
  },
  {
    id: "no-deadline-poll",
    status: "rule_violation",
    description:
      "Never poll a fixed number of times with a sleep between attempts. Wait on a wall-clock deadline or a context timeout, so a slow machine waits longer instead of failing.",
    test: (code) => {
      const c = stripLineComments(code);
      if (!has(c, SLEEP)) return null;
      if (!has(c, FIXED_ATTEMPTS)) return null;
      if (has(c, DEADLINE)) return null;
      return "no-deadline-poll: polls a fixed number of times with a sleep between attempts and no wall-clock deadline or context timeout; runner contention makes that pass on one machine and fail on the next";
    },
  },
  {
    id: "no-os-specific",
    runner: ["go", "vitest", "jest", "bun", "pytest"],
    status: "os_specific",
    description:
      "Never assume one operating system. Tests run on Linux and on macOS runners, so keep /proc and /sys paths, syscall constants, the Keychain and hardcoded path limits out of the test: use t.TempDir (or the runner's temp helper), and guard genuine platform behavior with a runtime.GOOS check that calls t.Skip.",
    test: (code) => {
      const c = stripLineComments(code);
      const found = OS_SPECIFIC.filter((o) => o.pattern.test(c)).map((o) => o.what);
      if (found.length === 0) {
        // A GOOS comparison that skips nothing is the other half of the same bug:
        // the branch runs on both machines and only the expectation changes.
        if (has(c, /\bruntime\.GOOS\s*[=!]=/) && !has(c, SKIP_CALL)) {
          return 'compares runtime.GOOS but never skips, so it still runs on the other operating system with a different expectation; make the guard skip: if runtime.GOOS != "linux" { t.Skip("...") }';
        }
        return null;
      }
      if (guardsPlatform(c)) return null;
      return `${found.join("; ")}; the suite runs on Linux and on macOS runners. Use a portable equivalent (t.TempDir for files), or guard it: if runtime.GOOS != "linux" { t.Skip("...") }`;
    },
  },
  {
    id: "no-real-network",
    status: "rule_violation",
    description: "Never make a real network call. Stub every HTTP client (WebMock in RSpec, vi.mock/msw in JS).",
    test: (code) => {
      const c = stripLineComments(code);
      const live = /\bfetch\s*\(|\bhttp\.(?:get|Get|Post|Head|PostForm)\s*\(|\bhttps\.get\s*\(|Net::HTTP|HTTParty|RestClient|Faraday\.|axios\.|\brequests\.(?:get|post|put|patch|delete|head|request)\s*\(|\bhttpx\.|\burlopen\s*\(/;
      if (!has(c, live)) return null;
      if (has(c, STUB)) return null;
      return "makes a real HTTP call with no stub in the file; stub the client instead";
    },
  },
  {
    id: "no-real-clock",
    status: "rule_violation",
    description: "Never read the real clock. Freeze time (vi.useFakeTimers, travel_to) before asserting on it.",
    test: (code) => {
      const c = stripLineComments(code);
      const live = /Date\.now\s*\(\)|new Date\s*\(\s*\)|\bTime\.now\b|\bTime\.current\b|\bDateTime\.now\b|\bDate\.today\b|\bdatetime\.(?:now|utcnow)\s*\(|\btime\.time\s*\(|\bdate\.today\s*\(/;
      if (!has(c, live)) return null;
      if (has(c, FAKE_TIME)) return null;
      return "reads the real clock without fake timers or travel_to; freeze time first";
    },
  },
  {
    id: "no-skipped-tests",
    status: "rule_violation",
    description: "Never skip, pend, or mark a test todo. A test that does not run proves nothing.",
    test: (code) => {
      const c = stripLineComments(code);
      if (has(c, /\b(?:it|test|describe|context|xit|xdescribe|xcontext|xspecify)\.skip\b/)) return "contains a skipped test";
      if (has(c, /\b(?:xit|xdescribe|xcontext|xspecify)\s*[({'"]/)) return "contains a skipped test (x-prefixed block)";
      if (has(c, /\b(?:it|test)\.(?:todo|failing)\b/)) return "contains a todo/failing test";
      if (has(c, /^\s*pending\b|,\s*(?:skip|pending):/m)) return "contains a pending test";
      if (has(c, /pytest\.mark\.(?:skip|skipif|xfail)\b|\bpytest\.(?:skip|xfail)\s*\(/)) return "contains a skipped test";
      if (has(c, /#\[\s*ignore\b/)) return "contains an ignored test";
      return null;
    },
  },
  {
    id: "no-tautology",
    status: "rule_violation",
    description: "Never assert a literal against itself (expect(true).toBe(true)). Assert on the code's real output.",
    test: (code) => {
      const c = stripLineComments(code);
      const js = /expect\s*\(\s*(true|false|null|undefined|-?\d+(?:\.\d+)?)\s*\)\s*\.\s*(?:toBe|toEqual|toStrictEqual)\s*\(\s*(true|false|null|undefined|-?\d+(?:\.\d+)?)\s*\)/g;
      for (const m of c.matchAll(js)) {
        if (m[1] === m[2]) return `tautological assertion expect(${m[1]}) against itself`;
      }
      const ruby = /expect\s*\(\s*(true|false|nil|-?\d+(?:\.\d+)?)\s*\)\s*\.\s*to\s+(?:eq|be|eql|equal)\s*\(?\s*(true|false|nil|-?\d+(?:\.\d+)?)\s*\)?/g;
      for (const m of c.matchAll(ruby)) {
        if (m[1] === m[2]) return `tautological assertion expect(${m[1]}) against itself`;
      }
      if (has(c, /expect\s*\(\s*true\s*\)\s*\.\s*to\s+be_truthy/)) return "tautological assertion expect(true).to be_truthy";
      return null;
    },
  },
  {
    id: "no-snapshot-only",
    status: "rule_violation",
    description: "Never let a snapshot be the only assertion. Snapshots record behavior, they do not specify it.",
    runner: "all",
    test: (code) => {
      const c = stripLineComments(code);
      const snapshots = c.match(/toMatch(?:Inline)?Snapshot|match_snapshot/g)?.length ?? 0;
      if (snapshots === 0) return null;
      // Counting beats regex surgery here: every snapshot consumes one expect(), so
      // any surplus expect() is a real assertion.
      const expectations = c.match(/\bexpect\s*[({]/g)?.length ?? 0;
      if (expectations > snapshots) return null;
      if (has(c, /\bassert[._(]|\bassert\s+\S|\bis_expected\b|\.should\b/)) return null;
      return "snapshot is the only assertion; add an assertion on real behavior";
    },
  },
  {
    id: "has-assertion",
    status: "rule_violation",
    description: "Every test must assert something. A test with no expectation cannot fail.",
    test: (code) => {
      const c = stripLineComments(code);
      return has(c, ASSERTION) ? null : "contains no assertion";
    },
  },
  {
    id: "behavioral-evidence",
    status: "tautological",
    description:
      "Call the code under test with a real input and assert on what it returns or changes. Proving a value exists, or snapshotting a declaration, is not a test.",
    test: (code) => {
      const kinds = assertionKinds(code);
      // No assertion at all is has-assertion's rejection, and it says it better.
      if (kinds.length === 0) return null;
      if (!exercisesCode(code)) {
        return {
          status: "declaration_snapshot",
          message: "never calls the code under test with an input; it only describes what the module declares",
        };
      }
      if (kinds.every((k) => WEAK_MATCHERS.has(k))) {
        const seen = [...new Set(kinds)].join(", ");
        return { status: "tautological", message: `every assertion is a weak matcher (${seen}); none of them fails when the code breaks` };
      }
      return null;
    },
  },
];

/** Every rule id, for validating `disable_rules` in the config. */
export const ruleIds: string[] = rules.map((r) => r.id);

/**
 * Rules that apply to one runner ("all" and unset both apply everywhere), minus
 * the ids the repo turned off with `disable_rules`.
 */
export function rulesFor(runner: RunnerName, disabled: readonly string[] = []): Rule[] {
  return rules.filter((r) => appliesTo(r, runner) && !disabled.includes(r.id));
}

/** True when the rule covers this runner. Unset and "all" cover every runner. */
function appliesTo(rule: Rule, runner: RunnerName): boolean {
  if (rule.runner === undefined || rule.runner === "all") return true;
  return typeof rule.runner === "string" ? rule.runner === runner : rule.runner.includes(runner);
}

/** Every violation for `code`, in registry order. Empty means clean. */
export function ruleViolations(code: string, runner: RunnerName, disabled: readonly string[] = []): RuleViolation[] {
  const out: RuleViolation[] = [];
  for (const rule of rulesFor(runner, disabled)) {
    const found = rule.test(code);
    if (!found) continue;
    out.push(typeof found === "string" ? { id: rule.id, status: rule.status, message: found } : { id: rule.id, ...found });
  }
  return out;
}

/**
 * The one status a set of violations adds up to. The specific rejection wins over
 * the generic one, and every message travels in the error either way. Undefined
 * means the candidate is clean.
 */
export function verdictFor(violations: readonly RuleViolation[]): RuleStatus | undefined {
  if (violations.length === 0) return undefined;
  return violations.find((v) => v.status !== "rule_violation")?.status ?? "rule_violation";
}

/** The registry rendered for the stable prompt block. */
export function rulesText(runner: RunnerName, disabled: readonly string[] = []): string {
  const lines = rulesFor(runner, disabled).map((r) => `- ${r.description}`);
  return ["Rules every generated test must follow:", ...lines].join("\n");
}
