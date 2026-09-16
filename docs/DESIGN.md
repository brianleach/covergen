# covergen design

## 1. What it is

covergen is a command line tool that writes unit tests for code nothing currently tests. It points at a
sibling repo, runs that repo's own test runner with coverage on, finds source lines with zero hits, asks
Claude for one candidate test per chunk of uncovered code, and then tries hard to throw the candidate
away. A candidate is kept only if it builds, passes k times in a row, covers at least one line that was
uncovered before, loses none, passes the repo's typecheck and lint, and fails when small breaks are made
to the lines it covers. Everything else is discarded or sent back for repair. The output is test code on
disk plus a markdown report.

It is not a CI check. No model runs in CI; CI runs the committed tests like any other test. It does not
open pull requests: the nightly job commits accepted tests to a local dated branch and stops, and a human
opens the PR. There is no IDE surface, no editor extension, and no background precompute.

## 2. Lineage

Three published systems are the source of the design. The dossier at `docs/research/autocover-sources.md`
traces every number below to a paper.

From Meta's TestGen-LLM (FSE 2024, arXiv:2402.09171) comes the acceptance gate: a candidate must build,
then pass reliably, then increase line coverage, in that order. TestGen-LLM ran each test 5 times and
discarded any that failed once, and its reviewers asked for coverage attributed per test case rather than
per class, which is why acceptance here is per test case too. Its deployment numbers set expectations:
1,979 test classes targeted, 196 improved, 73% of recommendations accepted and landed, per-trial success
of 4 to 5%.

From CoverUp (FSE 2025, arXiv:2403.16218) comes targeting and repair. CoverUp cuts uncovered code into
segments with a default 50 line cap, prompts per segment with the excerpt and the exact missing lines,
and on failure continues the same chat with the error instead of starting over. `segments.ts` and
`repair.ts` are that idea.

From Uber's AutoCover (ICSE-SEIP 2026) comes everything above the gate: coverage treated as necessary but
insufficient, a rules registry checked before and after generation, bounded mutation testing on accepted
tests, content hash dedup, freezing chronic non-improvers, and the stable / semi-stable / volatile prompt
split for caching. AutoCover reports viable test rates of about 20% for Java, 40% for Go and 80% for
Python, and produces about 11% of all new tests reviewed at Uber. No TypeScript rate is reported, and no
Ruby prior art exists at all.

Deliberately not built. No LangGraph and no multi-agent framework: the same loop fits in a dozen files
and a `for` loop, for one engineer and six repos. No IDE surface: AutoCover's depends on a shared Bazel
build cache and a save debounce that only pays off at scale. No cloud routine for the headless mode:
whole-suite baselines need each repo's database and toolchain, so the scheduled surface is a local job.

## 3. The pipeline

`src/types.ts` is the contract between stages. Each stage reads one shape and produces the next.

**Config.** `src/config.ts` parses `covergen.yaml` with Zod into a `RepoConfig` per repo: absolute root
and cwd, runner name, source globs, a `specPath` function built from a template, idiom pack path,
optional `commandPrefix`, and the `validate` commands. Defaults for k, timeouts, mutation, segment caps
and models live in the same schema.

**Baseline.** `src/pipeline.ts` calls the runner's `preflight`, runs the suite with coverage on, and
hands the resulting `lcov.info` to `src/lcov.ts`, which parses it into a `CoverageMap`: one
`FileCoverage` per path holding a line number to hit count map.

**Segments.** `src/segments.ts` collects the target's zero hit lines, clusters them (gaps of up to 3
covered lines stay inside one cluster), expands each cluster to its enclosing definition where
detectable, and emits `Segment` values carrying the line range, the exact uncovered line numbers,
numbered source text and the enclosing symbol. A cluster over `segments.max_lines` falls back to the
cluster plus 5 lines of context each side.

**Prompt.** `src/prompt.ts` turns one `Segment` plus the file, the nearest existing spec and the rules
registry into `PromptBlocks`. `findNearestSpec` decides whether the model writes a complete file or an
appendable block.

**Generate.** `src/generate.ts` sends the two system blocks and the volatile user message to the
Anthropic API and pulls exactly one fenced code block from the reply. It returns a `Candidate`: the code,
a sha256 over the code with whitespace collapsed, the segment, target spec path, a `wholeFile` flag, the
message history and the system blocks. Candidates for one file are generated concurrently, then deduped
by hash.

**Rules.** `src/rules.ts` runs its registry over the candidate text before anything is spliced: a
violation is `rule_violation` and the candidate never reaches the gate. The same registry is rendered
into the stable prompt block, so the model is told the rules before it writes.

**Gate.** `src/gate.ts` splices the candidate into the real spec file, runs it, and returns a
`GateResult`. Evaluations run one at a time, because each writes to the repo working tree.
`src/repair.ts` takes a failing `GateResult`, continues the same chat, then re-gates, giving up after
`max_repair_rounds`.

**Emit and state.** `src/emit.ts` writes accepted tests into their spec files and renders the markdown
report; `src/state.ts` folds the run into `state.json`. The pipeline returns a `RunSummary`: repo,
targets, candidates, the accepted subset, tokens and duration.

## 4. The gate

The acceptance rule is one sentence, enforced in `gate.ts` in this order. A candidate is accepted when it
runs without a build error, passes k consecutive runs, the runner produced an lcov file, it lost no
lines, it newly covered at least one line of the target source, every `repo.validate` command exits zero
with it still spliced in, and, when the mutation spot-check is on and produced at least one mutant, at
least `min_killed` of them made the test fail. Any other outcome is a named status: `build_failed`,
`test_failed`, `flaky`, `no_coverage_gain`, `weak_assertions`, `tautological`, `declaration_snapshot` or
`os_specific`.

The Go gate runs the candidate under `-race`. pass^k sees a flake only when the same run fails twice on
the same machine, and a data race is the case it cannot see at all, so the detector is what turns it into
a rejection here instead of a failure in the repo's CI later. The baselines stay uninstrumented: they
measure coverage, and the flag costs several times the run.

There are two baselines and they measure different things. Gain is measured against the whole-suite
baseline, so a line counts as a gain only if nothing in the suite covered it. Loss is measured against a
separate run of the candidate's own spec file alone, taken before the splice. The gate runs one spec file
at a time, so against the suite baseline every line another spec covers would look lost. The raw
percentage from a spec-alone run is not comparable to the suite number either, so the reported After is
Before plus the gain.

pass^k is the flakiness filter. The first run is with coverage, the next `k - 1` are without. A failure
on any repeat run is `flaky`, not `test_failed`, and carries the failing run's output. Default k is 3.

`repo.validate` is a list of argv arrays run in `repo.cwd` after the coverage check passes, with the
candidate still in the file: typecheck, lint, whatever the repo's CI runs. A nonzero exit is reported as
`build_failed` with the command and its output.

The mutation spot-check is last, because it is the most expensive. `src/mutate.ts` makes small
single-line edits to the lines the candidate newly covered, capped at `mutation.max_mutants` (default 5).
Operators run in a fixed order per line: relational, boolean, logical, condition, numeric, return,
predicate. String literals and comments are masked first, so a mutant never rewrites a message. Each
mutant is written to the source file and the spec re-run; a failing run means the mutant was killed, the
outcome we want. A candidate killing fewer than `min_killed` is `weak_assertions`. Zero mutants generated
means the check is skipped, not failed. The source file is restored in an inner `finally`, before the
outer one restores the spec.

Fast mode changes the baselines and nothing else. With `--fast` the "whole-suite" baseline is a run of
the target's own specs, so a line some other spec already covers counts as a gain. The spec baseline in
fast mode is a snapshot of that same map, taken per target, because the suite baseline is mutated in
place as candidates are accepted and lines one accepted candidate added must not read as lost for the
next one.

## 5. Repair

Repair is a chat continuation, not a new request. The model already has the idiom pack, the file, the
nearest spec and the segment in context from the generate call, so a round is one user turn appended to
the same history. The cached system blocks are re-sent unchanged so the prompt cache prefix still
matches.

The user turn is chosen by the gate status. `build_failed` gets the runner output and "fix the cause, not
the symptom". `test_failed` says the code under test is correct and the test is wrong. `no_coverage_gain`
lists the lines still uncovered and asks what input reaches them. `flaky` names the usual sources of
nondeterminism. `weak_assertions` lists the surviving mutants line by line and asks for assertions on the
observable result. Every round ends with the same instruction to return one fenced code block.

Regardless of `max_repair_rounds`, `flaky` gets exactly one round, and the three verdicts that mean the
test checks nothing (`weak_assertions`, `tautological`, `declaration_snapshot`) share one round between
them. Both cases mean the model already had what it needed.

Freezing matters as much as repairing. A candidate that runs out of rounds comes back as `frozen`, as
does one whose reply had no fenced block, or more than one. `state.ts` records the hashes of everything
that failed for good, and the next run skips them.

## 6. State and caching

`<repo.root>/.covergen/state.json` holds three things: frozen candidate hashes, accepted candidate
hashes, and the last 20 run summaries. Frozen plus accepted is the skip set, so neither a known-bad
candidate nor an already-landed one is generated again. Writes are atomic, temp file plus rename, because
a sweep can be killed mid-run. A missing or corrupt file starts fresh rather than failing the run. A dry
run records freezes but not accepted hashes, since it wrote nothing.

The whole-suite baseline is cached at `.covergen/baseline/<fingerprint>.lcov`. The fingerprint is a
sha256 over `git rev-parse HEAD` plus the names and contents of dirty working-tree files, truncated to 16
characters, so any content change to the tree invalidates it. `--refresh-baseline` bypasses the cache. A
cache write failure logs a warning and never fails the run.

`.covergen/candidates/` holds every candidate's final code, accepted or not, named by status and hash
prefix, with a header giving the spec path, source lines, attempt count, newly covered lines and the
first line of the last error. That is what a dry run leaves for review. `.covergen/last-run.md` is the
markdown report, also printed to stdout, and `.covergen/coverage/` holds scratch lcov output.

## 7. Runners

The `Runner` interface has three methods. `preflight` verifies the toolchain and coverage reporter and
throws with a fix hint. `run` takes `RunOptions` (files relative to cwd, coverage on or off, timeout,
extra env) and returns a `RunResult` with `ok`, exit code, stdout, stderr, duration and an optional
`lcovPath`. `specPathFor` names a new spec beside a source file.

Four adapters, all normalizing to lcov. RSpec goes through SimpleCov: the run sets `COVERAGE`,
`SIMPLECOV_LCOV`, `SIMPLECOV_LCOV_PATH` and `SIMPLECOV_COVERAGE_DIR`, and the target repo's `spec_helper`
installs `simplecov-lcov` when it sees them, the one thing the repo has to opt into. Vitest passes
`--coverage --coverage.reporter=lcov` with a per-run reports directory, bun passes `--coverage
--coverage-reporter=lcov --coverage-dir`, and Jest passes `--coverage --coverageReporters=lcov
--coverageDirectory`, plus `--runInBand --forceExit` and `--runTestsByPath`, the last because Jest treats
positional arguments as regexes and a path containing parentheses otherwise matches nothing.

`commandPrefix` is prepended to every command a runner builds: `["rbenv", "exec"]` pins a Ruby version,
`["docker", "compose", "exec", "-T", "api"]` runs the suite in a container. `COVERGEN_SOURCE` carries the
source file under test, relative to cwd. Vitest uses it for `--coverage.include` and Jest for
`--collectCoverageFrom`, so the delta stays attributable to one file; RSpec passes it through as plain
env.

Everything runs through `runners/exec.ts`: `execFile` with an argv array and never a shell string, a
detached process group so a timeout kills the whole tree rather than just a `bundle exec` wrapper, and 2
MB tail buffers. Each coverage run gets its own output directory.

## 8. Prompt

The prompt is split three ways because that is the shape prompt caching rewards. `stable` is the idiom
pack, the rules registry and the output format, identical for a whole run. `semiStable` is the file under
test with line numbers plus the nearest existing spec, identical for every segment of one file.
`volatile` is the segment, its uncovered line numbers and the spec path. `generate.ts` puts stable and
semiStable in `system`, each with its own cache breakpoint, and sends only volatile as the user message.
A run over one file with eight segments pays for the idiom pack and the source listing once.

The idiom packs in `idioms/` are the existing test-writer agent prompts, one per runner: `rspec.md`,
`vitest-nextjs.md`, `bun.md`, `jest-expo.md`. They are loaded verbatim into the stable block and selected
per repo by `idiom_pack`. A repo without a pack follows the existing spec's conventions.

The anti-bloat rules sit in the stable block too, because reviewers reject bloat faster than they reject
wrong tests: write the fewest examples that reach the listed lines, usually one to three; do not test
what the existing spec already covers; no helper scaffolding unless the existing spec already uses that
pattern; reuse the existing spec's lets, fixtures and mocks; do not assert on implementation details a
harmless refactor would break. The output format is strict: exactly one fenced code block, no preamble,
and either a complete file or an appendable block.

## 9. Security and safety

The Anthropic key is read from a `.env` next to `covergen.yaml`, parsed into a private map, and handed to
the client through `PipelineArgs.apiKey`. It never enters `process.env`. This is not theoretical: the key
used to be loaded into the environment, the runners inherit `process.env`, and one target repo's suite
calls the real API when it sees a key, which timed out 18 tests and produced no lcov. Runners inherit the
environment minus the key.

The working tree is always restored. The gate captures the spec file's original bytes before writing and
puts them back in a `finally`; a file the gate created is deleted outright. Mutants are written to the
source file inside an inner `try` with its own `finally`, so the source is restored before the spec is.
`emit.ts` never overwrites an existing file with a whole-file candidate, because a generated file
clobbering a hand-written spec is the one unrecoverable mistake this tool could make.

A dry run gates everything a real run does, including writing a whole-file candidate to disk so later
segments can be gated as blocks against it, then removing those files and the directories it created. It
records freezes but not accepted hashes.

The nightly job checks out `covergen/nightly/<date>` in a repo with a clean working tree, runs `sweep`,
commits the accepted tests with the report as the commit message, and switches back. It never pushes and
never opens a pull request. A repo with a dirty tree is skipped.

## 10. Known limitations

Segments and mutants are both regex and indentation heuristics, not an AST. Segmenting finds enclosing
definitions by matching `def`, `class`, `module` and brace or indent structure, so an unusual layout gets
a line window instead of a real block. Mutation masks strings and comments character by character, which
is best effort and not a lexer, and has operators only for `.rb`, `.ts`, `.tsx`, `.js` and `.jsx`;
anything else yields no mutants.

Ruby predicate mutation is narrow on purpose. `.present?`, `.blank?`, `.empty?` and `.any?` flip freely,
but `.nil?` is touched only when the whole line is one optionally negated receiver, because anything more
needs to know where the expression starts.

The spec-alone baseline costs one extra runner invocation per target that already has a spec, the price
of judging loss correctly.

Yield varies by runner and the reasons are not fully understood here. AutoCover's published spread is 20%
to 80% by language; the plan budgeted 30 to 50% for RSpec and Vitest, under 20% for jest-expo. Real
per-runner numbers are still to be collected.

Generated tests can still be more verbose than hand-written ones. The anti-bloat rules help, and the
AutoCover user survey lists less bloat as a top request, but nothing in the gate measures it. That check
is still a human reading the diff, which is why the tool stops at a local branch.
