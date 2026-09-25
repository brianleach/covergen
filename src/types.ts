/**
 * Canonical shapes shared by every stage. Keep this file dependency-free.
 * All paths are absolute unless a field name says otherwise.
 */

export type RunnerName = "rspec" | "vitest" | "bun" | "jest" | "pytest" | "go" | "cargo" | "node-test";

/** The repo entry's `pytest:` block. `package` absent means derive `--cov` from `sources`. */
export interface PytestOptions {
  /** argv that invokes pytest, e.g. ["python","-m","pytest"] or ["uv","run","pytest"]. */
  command: string[];
  package?: string;
  /** Glob for test files, cwd-relative. Preflight fails when nothing matches. */
  testGlob: string;
}

/** The repo entry's `go:` block. Go selects tests by package, never by file. */
export interface GoOptions {
  /** argv that invokes the test command, e.g. ["go","test"]. */
  command: string[];
  /** Package patterns to test and to measure, e.g. ["./..."]. */
  packages: string[];
  /**
   * -race, on by default, and only on the gate runs. pass^k cannot see a data
   * race: k runs on one idle machine all pass, and the detector is what turns
   * that into a failure here rather than a flake in the repo's own CI. Baselines
   * run without it, because they measure coverage and the flag triples the time.
   */
  race: boolean;
  /** Build tags, passed as one -tags flag. */
  buildTags?: string[];
}

/** The repo entry's `cargo:` block. Rust selects tests by crate, never by file. */
export interface CargoOptions {
  /** argv that invokes cargo-llvm-cov, e.g. ["cargo","llvm-cov"]. */
  command: string[];
  /**
   * Crates to test and measure, each passed as `-p <crate>`. Empty means the
   * whole workspace, which is what a single-crate repo wants. A list is how a
   * large workspace keeps a failing test in an unswept crate out of its
   * baseline.
   */
  packages: string[];
  /** Extra arguments for the test harness, passed after `--`. */
  testArgs: string[];
}

/** The repo entry's `node_test:` block, for suites on Node's built-in test runner. */
export interface NodeTestOptions {
  /** argv that runs the suite, e.g. ["node","--import","tsx","--test"] or ["tsx","--test"]. */
  command: string[];
  /** Glob for test files, cwd-relative. The whole-suite run passes it to Node as is. */
  testGlob: string;
  /** Globs coverage is reported over. Absent means `sources`. */
  coverageInclude?: string[];
}

/** Which backend makes the model calls: the metered API, or a Claude subscription. */
export type GeneratorBackend = "api" | "claude-code";

/** One repo entry from covergen.yaml, resolved (paths absolute). */
/**
 * The repo entry's `explore:` block, read only by explore mode. Everything here
 * is a name or a pattern: the base URL and the session file are named as
 * environment variables, so neither a private preview URL nor the path to the
 * owner's session is ever written into the config or into this repository.
 */
export interface ExploreOptions {
  /** Environment variable holding the base URL to explore. */
  baseUrlEnv: string;
  /** Environment variable holding the path to a Playwright storageState file. */
  storageStateEnv: string;
  /** Route patterns whose writes may be generated against. Empty means read-only. */
  allowMutations: string[];
  /** Hard ceiling on pages one crawl reads. */
  maxPages: number;
  /** Route patterns the crawl never visits, e.g. logout. */
  ignorePatterns: string[];
  /** Glob, relative to cwd, for the end to end specs that already exist. */
  specGlob: string;
}

export interface RepoConfig {
  name: string;
  root: string;
  runner: RunnerName;
  /** Optional working directory inside root (e.g. apps/web for a monorepo). */
  cwd: string;
  /** Glob(s) for source files eligible for generation. */
  sources: string[];
  /**
   * Glob(s) subtracted from `sources`. Narrower than rewriting `sources` and the
   * only practical way to drop one extension: a package whose runner has no DOM
   * environment excludes `**` + `/*.tsx` so component targets are never picked.
   */
  exclude?: string[];
  /** Given a source path relative to cwd, the conventional spec path relative to cwd. */
  specPath: (relSource: string) => string;
  /**
   * True when the config names `spec_template` itself. Then `specPath` wins over
   * the nearest existing spec, which stays only as the prompt's style example.
   */
  specTemplateExplicit?: boolean;
  /** Overrides `sweep.pr_max_lines_per_file` for this repo. 0 disables the ceiling. */
  prMaxLinesPerFile?: number;
  /**
   * Language the mutation spot-check treats every source as, over the extension
   * and the shebang. For sources whose name says nothing about their language.
   */
  language?: "ruby" | "js" | "python" | "go" | "rust";
  /** Idiom pack markdown, loaded verbatim into the stable prompt block. */
  idiomPackPath?: string;
  /** Overrides the top-level generator backend for this repo. */
  generator?: GeneratorBackend;
  /** false leaves the repo out of `sweep --all`. */
  sweep?: boolean;
  /** Extra hints (e.g. "run bundle exec rspec via docker compose exec api"). */
  commandPrefix?: string[];
  /**
   * Commands run in cwd after a candidate passes the coverage gate, with the
   * candidate still spliced in (typecheck, lint). Any nonzero exit rejects it as
   * build_failed so the repair loop sees the error.
   */
  validate?: string[][];
  /** Rule ids from src/rules.ts this repo turns off, e.g. ["behavioral-evidence"]. */
  disableRules?: string[];
  /**
   * Accept a candidate the mutation spot-check could not judge, because no
   * operator applied to any line it covered. Off by default: a test nothing can
   * break is the thing the spot-check exists to catch. A repo of declaration-
   * heavy files where that is the normal case turns it on.
   */
  allowNoMutants?: boolean;
  /** Settings for the pytest runner. Ignored by every other runner. */
  pytest?: PytestOptions;
  /** Settings for the go runner. Ignored by every other runner. */
  go?: GoOptions;
  /** Settings for the cargo runner. Ignored by every other runner. */
  cargo?: CargoOptions;
  /** Settings for the node-test runner. Ignored by every other runner. */
  nodeTest?: NodeTestOptions;
  /** Settings for explore mode. Absent means this repo has no explorable target. */
  explore?: ExploreOptions;
}

/** Line coverage for one file. Lines absent from the map were not instrumented. */
export interface FileCoverage {
  /** Path relative to the repo cwd, normalized with forward slashes. */
  path: string;
  /** line number -> hit count */
  lines: Map<number, number>;
}

export type CoverageMap = Map<string, FileCoverage>;

/** Line totals over some set of files, with `pct` 0 when nothing is instrumented. */
export interface CoverageSummary {
  covered: number;
  total: number;
  pct: number;
  /** How many files contributed instrumented lines. */
  files: number;
}

/** Which files a reported percentage was measured over. */
export type CoverageScope = "sources" | "all";

/**
 * The same coverage run read two ways: over the files the repo declares as
 * sources, and over every file the report instrumented. They differ whenever
 * the runner measures more than covergen targets, which is the usual case, and
 * a single number that does not say which one it is has been read as the other
 * one often enough to be worth reporting both.
 */
export interface ScopedCoverage {
  sources: CoverageSummary;
  all: CoverageSummary;
}

/** A run's coverage before and after the tests it accepted. */
export interface RunCoverage {
  before: ScopedCoverage;
  after: ScopedCoverage;
}

export interface CoverageDelta {
  path: string;
  /** Lines that were 0 hits before and >0 after. */
  newlyCovered: number[];
  /** Lines that were >0 before and 0 after (should be empty; a regression). */
  lost: number[];
  before: { covered: number; total: number };
  after: { covered: number; total: number };
}

/** A contiguous chunk of uncovered source to target with one candidate. */
export interface Segment {
  path: string;
  startLine: number;
  endLine: number;
  /** The exact uncovered line numbers inside [startLine, endLine]. */
  uncoveredLines: number[];
  /** Source text of the segment, with line numbers prefixed. */
  text: string;
  /** Best-effort enclosing symbol (def/function/class name) if detectable. */
  symbol?: string;
}

export interface RunOptions {
  /** Spec/test files to run, relative to cwd. Empty = whole suite. */
  files: string[];
  coverage: boolean;
  timeoutMs: number;
  env?: Record<string, string>;
  /**
   * Report every file matched by the repo's coverage config, not just the files the
   * run loaded. Set by the two whole-project baselines, the `baseline` command and the
   * pipeline's whole-suite baseline, because a source file with no test at all is never
   * loaded and would otherwise be missing from the map rather than showing 0%. Per-file
   * gate runs and fast-mode baselines leave it off so the delta stays cheap.
   */
  wholeProject?: boolean;
  /**
   * This run is judging a candidate, not measuring a baseline. A runner may pay
   * for strictness here that a baseline cannot afford: the go runner adds -race,
   * which is the only way the gate sees a data race at all.
   */
  gate?: boolean;
  /**
   * Run one named test case out of `files` instead of all of them, which is what
   * the audit needs to attribute coverage and wall time to a single case. Each
   * runner translates it into its own name filter. A runner with no such filter
   * ignores it, and the caller falls back to whole-file granularity.
   */
  caseFilter?: string;
}

/** One test case inside a spec file, as a runner's case lister sees it. */
export interface TestCase {
  /** The name, spelled exactly as this runner's name filter has to match it. */
  name: string;
  /** 1-based line where the case opens. */
  line: number;
}

export interface RunResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** Absolute path to an lcov.info file when coverage was requested and produced. */
  lcovPath?: string;
}

/** How much preflight is allowed to spend. */
export interface PreflightOptions {
  /**
   * Run the checks that cost a build or a coverage pass as well as the cheap
   * ones. Off by default, so `covergen preflight` stays a few seconds; the
   * pipeline turns it on once per repo, while there is no baseline to prove the
   * same thing.
   */
  deep?: boolean;
}

/** One runner adapter. Implementations live in src/runners/. */
export interface Runner {
  name: RunnerName;
  /**
   * Verify the toolchain and coverage reporter are available. Throw with a fix
   * hint if not. Two tiers: without `deep` only cheap checks run (tool versions
   * and presence, a test file exists, the coverage tool answers a no-op), and
   * `deep` adds the smoke coverage run.
   */
  preflight(repo: RepoConfig, opts?: PreflightOptions): Promise<void>;
  /**
   * Non-fatal preflight observations: things that will cost candidates and
   * repair rounds rather than fail outright, such as a runner with no DOM
   * environment configured while the source globs still match component files.
   */
  warnings?(repo: RepoConfig): Promise<string[]>;
  /**
   * Per-runner check on the spliced spec file, run before the suite. A returned
   * string rejects the candidate as build_failed and goes into the repair loop.
   * gofmt is what this exists for: Go treats unformatted code as a failure.
   */
  checkSpec?(repo: RepoConfig, specPath: string): Promise<string | undefined>;
  run(repo: RepoConfig, opts: RunOptions): Promise<RunResult>;
  /**
   * The test cases one spec file declares, for the audit. Absent means this
   * runner cannot name a single case, so the audit judges the file as a whole
   * and says so in the report.
   */
  listCases?(repo: RepoConfig, specPath: string): Promise<TestCase[]>;
  /** File extension and naming for a new spec next to `relSource`. */
  specPathFor(repo: RepoConfig, relSource: string): string;
}

export type CandidateStatus =
  | "generated"
  | "build_failed"
  | "test_failed"
  | "flaky"
  | "no_coverage_gain"
  | "rule_violation"
  /** Every assertion is a matcher that passes whatever the code did. */
  | "tautological"
  /** Never called the code under test with an input, so it pins a declaration. */
  | "declaration_snapshot"
  /** Assumes one operating system without guarding it, so it fails on the other runner. */
  | "os_specific"
  | "weak_assertions"
  | "accepted"
  | "frozen";

export interface Candidate {
  id: string;
  /** sha256 of normalized test text, used for dedup. */
  hash: string;
  segment: Segment;
  /** Spec file this test targets, relative to cwd. */
  specPath: string;
  /** The test code to splice or write. */
  code: string;
  /** True if `code` is a complete new file; false if it is a block to append. */
  wholeFile: boolean;
  status: CandidateStatus;
  attempts: number;
  lastError?: string;
  delta?: CoverageDelta;
  /** Mutation spot-check result, present once the gate got that far. */
  mutation?: MutationSummary;
  /** Anthropic message history for chat-continuation repair. */
  history: PromptMessage[];
  /** System blocks used at generation time, re-sent on repair so the cache prefix matches. */
  system?: Pick<PromptBlocks, "stable" | "semiStable">;
}

export interface PromptMessage {
  role: "user" | "assistant";
  content: string;
}

/** Prompt split into cache-friendly blocks (AutoCover: stable / semi-stable / volatile). */
export interface PromptBlocks {
  /** Idiom pack + rules. Identical across a whole run. */
  stable: string;
  /** File under test + nearest existing spec. Identical across candidates for one file. */
  semiStable: string;
  /** The segment and its missing lines. Unique per candidate. */
  volatile: string;
}

export interface GateOptions {
  /** Number of consecutive passing runs required. */
  k: number;
  timeoutMs: number;
}

/** One surviving mutant, described well enough for the repair prompt. */
export interface MutantSummary {
  id: string;
  line: number;
  description: string;
}

/** What the bounded mutation spot-check found for one candidate. */
export interface MutationSummary {
  /** Mutants written and re-run. Zero means no operator applied to those lines. */
  tried: number;
  /** Mutants that made the candidate fail, which is the outcome we want. */
  killed: number;
  survivors: MutantSummary[];
}

export interface GateResult {
  status: Extract<
    CandidateStatus,
    | "build_failed" | "test_failed" | "flaky" | "no_coverage_gain" | "rule_violation"
    | "tautological" | "declaration_snapshot" | "os_specific" | "weak_assertions" | "accepted"
  >;
  runs: RunResult[];
  delta?: CoverageDelta;
  mutation?: MutationSummary;
  error?: string;
}

export interface RunSummary {
  repo: string;
  targets: string[];
  candidates: Candidate[];
  accepted: Candidate[];
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** Which backend spent them. Absent on summaries built before backends existed. */
  backend?: GeneratorBackend;
  /** Set when a run-wide ceiling stopped the run before every target was tried. */
  limitHit?: "tokens" | "minutes";
  /** The signal that stopped the run, when one did. The accepted specs are still on disk. */
  aborted?: string;
  /** This run's journal path. Absent on a dry run, which leaves nothing on disk to journal. */
  journal?: string;
  /** What those tokens cost, per model, when a price is known for the model. Never set on a subscription run. */
  cost?: RunCost;
  /**
   * Repo coverage before and after this run, scoped and whole. Absent on a fast
   * run, whose baseline measures one spec rather than the repo, and on summaries
   * written before the figure existed.
   */
  coverage?: RunCoverage;
  durationMs: number;
}

/** Dollar cost of one model's share of a run. */
export interface ModelCost {
  model: string;
  /** Undefined when no price table entry matched the model. */
  usd?: number;
}

export interface RunCost {
  /** Sum of the priced entries. Zero when nothing could be priced. */
  usd: number;
  byModel: ModelCost[];
  /** True when at least one model had no price entry, so `usd` is a floor. */
  partial: boolean;
}
