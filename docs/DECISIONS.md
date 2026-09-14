# covergen decisions

Decision records, newest facts folded into the record they belong to. Dates come from the
commit that made the decision real.

## 1. pass^k, not pass@k

2026-09-02

**Context.** A generated test can pass once by luck: ordering, leftover state, a real clock, an
unseeded random. TestGen-LLM ran each candidate 5 times and discarded any that failed once.
pass@k in the literature means the opposite thing, at least one success in k samples.

**Decision.** Require k consecutive passing runs of the same candidate. Default k is 3. The
first run collects coverage, the rest do not.

**Consequences.** Flakiness gets its own status rather than reading as a plain test failure, so
the repair prompt can name nondeterminism directly. The gate costs k runner invocations per
candidate, which is the main reason candidates are gated one at a time.

## 2. Acceptance per test case, not per file

2026-09-02

**Context.** Judging a whole spec file lets a good test carry a worthless one. Meta's reviewers
asked for coverage attributed per test case for exactly this reason.

**Decision.** One candidate is one unit of acceptance, gated and accepted or rejected alone.

**Consequences.** Each accepted candidate raises the bar for the next: its newly covered lines
are marked in the baseline in memory, so two tests for the same lines cannot both land. Every
candidate needs its own gate run, which is slow but is what makes the coverage numbers in the
report true per test.

## 3. Gain against the suite, loss against the spec alone

2026-09-02

**Context.** The gate runs one spec file at a time. Diffing that run against the whole-suite
baseline made every line covered by some other spec look lost, so good candidates were rejected
as regressions.

**Decision.** Two baselines. Gain is measured against the whole-suite baseline, so a line counts
only if nothing in the suite covered it. Loss is measured against a run of the candidate's own
spec file alone, taken before the splice.

**Consequences.** One extra runner invocation per target that already has a spec. The After
percentage cannot come from the spec-alone run, so it is reported as Before plus the gain. In
fast mode the spec baseline is a snapshot, because the suite baseline is mutated as candidates
are accepted.

## 4. No model in CI

2026-09-02

**Context.** A model in the CI gate makes builds nondeterministic, spends tokens on every push,
and puts an external service on the critical path of merging.

**Decision.** covergen runs on a developer machine or a scheduled local job. CI runs the
committed tests only.

**Consequences.** Generated tests are reviewed and committed like any other code. Coverage never
regresses because of an API outage. The tool has no CI integration to maintain.

## 5. The tool never opens pull requests

2026-09-02

**Context.** AutoCover's headless surface opens merge requests routed to owning teams. That
works with a monorepo, CODEOWNERS everywhere and thousands of engineers to absorb the review
load. Here it would mean unreviewed generated tests landing in six repos.

**Decision.** covergen writes files. The nightly job commits accepted tests to a local branch
`covergen/nightly/<date>` and switches back. It never pushes. A human opens the PR.

**Consequences.** Every generated test is read by a person before anyone else sees it. Output is
capped by review appetite, not by generation throughput. Repos with a dirty working tree are
skipped rather than committed into.

## 6. The Anthropic key never enters process.env

2026-09-02

**Context.** The key was loaded from `.env` into `process.env`. Runners inherit `process.env`,
and one target repo's suite calls the real API when it sees a key: 18 tests timed out and no lcov
was written, so the run could prove nothing.

**Decision.** Parse `.env` next to `covergen.yaml` into a private map and pass the key to the
Anthropic client through `PipelineArgs.apiKey`. Runners inherit the environment minus the key.

**Consequences.** A suite under test cannot make a real model call with our credentials.
Preflight warns when no key is found, since the failure would otherwise show up as an API error
mid-run.

## 7. Runner adapters, not language adapters

2026-09-02

**Context.** Six repos, four test runners, three languages. AutoCover has language and repository
adapters because it also owns codegen and mocks through Bazel. We own neither.

**Decision.** One adapter per test runner, and every adapter emits lcov. One parser, one diff,
one coverage model.

**Consequences.** Adding a repo that uses an existing runner is a config entry, not code. The
cost is pushed into the target repo: each one has to be able to write lcov, which is what the
Phase 0 branches do. Anything a runner cannot express in lcov (branch coverage, scenarios) is
invisible to the gate.

## 8. Segments capped at 50 lines, 8 per file

2026-09-02

**Context.** A whole uncovered file is too much for one prompt and produces sprawling tests. A
single line is too little context to write anything. CoverUp's default cap is 50 lines.

**Decision.** `segments.max_lines` 50, `segments.max_per_file` 8. Uncovered lines are clustered
with gaps of up to 3 covered lines, expanded to the enclosing definition when detectable, and
otherwise trimmed to the cluster plus 5 lines of context.

**Consequences.** One prompt maps to roughly one function, which is what the model handles best.
A file with heavy uncovered surface is only partly attacked in one run; the rest is picked up on
a later run once the first tests have landed.

## 9. Stable, semi-stable, volatile prompt blocks

2026-09-02

**Context.** Every segment of one file re-sends the same idiom pack, the same rules and the same
source listing. AutoCover restructured its prompts into exactly these three tiers to make
caching pay, and reports cache hit rates above 50% for its generator.

**Decision.** `stable` (idiom pack, rules, output format) and `semiStable` (file under test,
nearest spec) go into `system`, each with its own cache breakpoint. Only `volatile` (the segment)
rides in the user message.

**Consequences.** A run over one file pays for the prefix once. The same blocks are re-sent on
every repair round so the cached prefix still matches, which is why `Candidate` carries them.
Token accounting tracks cache reads and writes separately.

## 10. Opus for generation, Sonnet for repair

2026-09-02

**Context.** Test writing is the reasoning-heavy half of the work, and a rejected candidate costs
a full gate run: k runner invocations plus validate plus up to 5 mutant runs. Repair is narrower,
since the model already has the file, the spec and the error in context.

**Decision.** `generator_model` defaults to `claude-opus-5` and `repair_model` to
`claude-sonnet-5`, both overridable per config. Adaptive thinking is on and `max_tokens` defaults
to 16384.

**Consequences.** Generation costs more per call and rejects less often, which is the cheaper
trade when a rejection costs runner time. The 16384 default exists because 4096 silently
truncated component tests; a truncated reply is now a loud error rather than a broken candidate.
`repair_model` is not wired up yet: the repair loop continues the same chat through the same
generator, so it currently runs on the generator model.

## 11. Reuse the test-writer agent prompts as idiom packs

2026-09-02

**Context.** Four Claude Code test-writer agents already encode each repo's conventions: the
RSpec factories and auth setup, the Vitest and Next.js mocks, the bun and RTL helpers, the Expo
router mocking. Maintaining a second, parallel description of the same conventions would drift.

**Decision.** Copy those prompts into `idioms/` (`rspec.md`, `vitest-nextjs.md`, `bun.md`,
`jest-expo.md`) and load them verbatim into the stable prompt block, selected per repo.

**Consequences.** Generated tests look like the repo's existing tests on the first try, which is
most of what makes them reviewable. The packs are copies, so a change to an agent prompt has to
be brought over deliberately. A repo without a pack falls back to imitating its nearest spec.

## 12. A local scheduled job, not a cloud routine

2026-09-03

**Context.** The plan called for `sweep` to run from a cloud routine. A whole-suite baseline on
these repos needs their databases, their Ruby and Node toolchains, and a bundle installed. None
of that exists in a cloud runner.

**Decision.** `scripts/nightly-sweep.sh` on a box that already has the dev stack, with a launchd
template for 02:30 daily. Reports and logs land in `.covergen/logs/`.

**Consequences.** The headless surface only runs where a developer environment already exists.
It is not installed anywhere yet. The job's guarantees (clean tree, local branch, never push) are
what make an unattended run safe.

## 13. Mutation rejects only when zero mutants are killed

2026-09-03

**Context.** A test that runs a line is not a test that asserts anything about it. MUTGEN's
example is a suite at 100% coverage with a 4% mutation score. But a full mutation run is far too
slow for a gate, and a strict kill ratio would reject reasonable tests.

**Decision.** Up to `max_mutants` 5 single-line mutants, restricted to the lines the candidate
newly covered, run after everything else has passed. `min_killed` is 1: a candidate is rejected
as `weak_assertions` only when it kills none. Zero mutants generated means the check is skipped,
not failed.

**Consequences.** At most 5 extra runner invocations on candidates that were otherwise about to
be accepted. The check catches the "executes it, asserts nothing" case and nothing subtler. Live: a generated
test for a React app helper killed 3 of 5. How many previously accepted tests this now
rejects has not been measured yet.

## 14. Whole-file candidates write themselves, later segments become blocks

2026-09-03

**Context.** A source file with no spec at all needs a complete new file. The gate deletes any
file it created, so only the first segment of such a target could ever be gated. The rest were
frozen, and files with no spec are exactly the files with the most uncovered code.

**Decision.** When a whole-file candidate is accepted, write it at its spec path immediately.
Every still-queued whole-file candidate for that same path is dropped and regenerated as an
appendable block against the accepted file.

**Consequences.** A spec-less target can be covered across several segments in one run. A dry run
has to undo those writes, including the directories it created. `applyAccepted` skips files
already on disk so it never writes them twice.

## 15. Frozen hashes are never regenerated

2026-09-02

**Context.** A candidate that fails the same way twice will fail a third time. Regenerating it
next run burns tokens and gate time on a known dead end, and AutoCover's Fixer freezes chronic
non-improvers for the same reason.

**Decision.** `state.json` records the sha256 of every candidate that ended in a failure status,
plus every accepted hash. Both sets are skipped on later runs. Writes are atomic so a killed
sweep does not lose what it learned. Dry runs record freezes but not accepted hashes.

**Consequences.** Repeated sweeps get cheaper and stop re-proposing the same test. Freezing is by
content hash, so a genuinely different attempt at the same lines is still allowed. A candidate
frozen because of a since-fixed bug in the tool stays frozen until the state file is edited.

## 16. Personal private repo first

2026-09-02

**Context.** The tool reads source files and test output, never application data, so it could live
in a work organization or as a personal repo. It was also unproven.

**Decision.** Build it as a private personal repo, and move it if it sticks.

**Consequences.** No org review overhead while the design was still moving. Nothing about it is
org-specific except `covergen.yaml`, which is gitignored, so relocating it later is a repo move
and not a rewrite.

## 17. Accepted tests are written when they are accepted, not at the end

2026-09-10

**Context.** A sweep gated 15 candidates over 36 minutes and several hundred thousand tokens
before the harness that launched it was killed mid-target. Accepted tests were only applied in one
batch after the last target, and the run's cleanup restored every spec it had touched, so the
candidates directory came back empty and last-run.md still described the previous run. Nothing
that run paid for survived.

**Decision.** Each accepted test is written into its spec file as soon as it is accepted. A run
journal at `.covergen/runs/<id>.json` is rewritten after every gate decision with the accepted
spec paths, their hashes and the tokens spent. SIGINT and SIGTERM are handled: the in-flight
candidate and any mutant still in a source file are rolled back synchronously, the run stops
starting new work, writes its report, and exits 130.

A signal is the only thing that leaves written tests behind. When a run reaches the end and the
combined verification fails, every spec it wrote is rolled back, nothing is recorded as accepted,
and the reason goes into `last-run.md` under "Reverted" and into the journal as
`status: reverted`. Tests that pass alone and fail together are not output worth keeping, and a
dirty checkout no one asked for would stop the next unattended sweep on that repo (owner decision,
2026-09-10).

**Consequences.** A killed run leaves a dirty checkout of tests that each passed the gate, plus
the journal naming them, instead of nothing. The combined verification is skipped on an aborted
run, so those specs are proven individually but not together, and a human reviews them before
committing. A verification failure behaves as it always did, clean checkout and a nonzero exit,
except that the run now explains itself in the report and the journal instead of only in stderr.

## 18. A test that runs the code without checking it is worse than no test

2026-09-10

**Context.** The mutation spot-check shipped with `min_killed: 1` out of up to five mutants. One
of five is close to no bar at all: a test that only proves the module loads and the function
returns something can kill a single relational mutant by accident and land. The cost of such a
test is not zero. It takes a review, it runs on every CI job forever, and it reports confidence
that is not there, which is worse than an honest gap in the coverage report.

**Decision.** The mutation bar is a ratio, `mutation.min_killed_ratio`, default 0.6, with
`mutation.min_killed` kept as an absolute floor, raised to 2. Both must be met. The floor is
clamped to the number of mutants actually generated, so a line that yields one mutant is judged on
that one instead of being rejected for a threshold it could never reach. Every survivor is named
in the PR body, and the run report leads with the mutation score before the coverage delta. The
JSON report carries `mutation.score` per run and per repo plus a per-spec line with the matcher
names each accepted test uses, so the coverage ledger can track what the suite checks and not just
what it runs.

**Consequences.** Fewer candidates are accepted per run and more tokens go to repair rounds. That
is the intended trade: the tool's output is reviewed by hand, so a smaller pile of tests that
each notice a break is worth more than a larger pile that does not. Repos where the ratio proves
too strict can set it back to `0` and keep the floor. The static half of this principle, rejecting
a candidate whose assertions are all tautological or that only asserts on the shape of a
declaration, is a separate change on top of the assertion classifier this one added.

## 19. Targets are ranked by value, not by the size of the hole

2026-09-10

**Context.** `--order gap` ranked targets by uncovered line count, which measures how red a file
is and not what a test on it would catch. It sent sweeps at declaration-heavy files, where the
biggest holes are: a schema module took a whole run and came back with a test that snapshotted
column names and killed 2 mutants of 5. The small, branchy, frequently edited code a regression
actually hides in was never reached, because it is never the biggest thing in the repo.

**Decision.** `--order value` is the default:

```
score = sqrt(uncovered) * branchWeight * churnWeight * importWeight

branchWeight = 0.05 + min(branches / uncovered, 2)
churnWeight  = 1 + min(commits in the last 180 days, 20) / 10
importWeight = 1 + min(files importing this one, 10) / 10
```

`branches` comes from a tokenizer over the uncovered lines only, comments and string literals
blanked first: control keywords, `&& || ?? ?.` and ternaries count 1, bare exits 0.5. Size enters
under a square root so it separates comparable files without deciding the ranking, and the 0.05
floor is what sinks a schema or a constant table however large it is. Churn is one
`git log --since=180.days --name-only` per repo tallied per path, and a root that is not a git
repository scores zero rather than failing. Segment selection inside a file weights by the same
density, with size left linear there because those holes compete for one file's prompt budget.
No AST and no new dependency, so the same code scores Ruby and TypeScript.

**Consequences.** Sweeps go at logic and leave declarations alone, so a run produces fewer
candidates on files where a candidate was never going to assert anything. The weights are
judgment, not measurement: `baseline --top` prints every component beside the score so the
ranking can be argued with, and `--order gap` stays for the case where the biggest hole really is
the point. Ordering now reads each target file and runs one `git log`, milliseconds against a
suite run but new work on a path that previously needed only the cached lcov.

## 20. Preflight is cheap by default, and a mutant slot means an applicable mutant

2026-09-13

**Context.** Two costs that had crept in. `preflight` ended with a smoke coverage run on the
runners that have one (pytest, go, cargo), and the cargo runner also built the tree with
`cargo test --no-run` first, so a check advertised as "offline, a few seconds" compiled a
workspace twice and measured coverage once, on every invocation. And the mutation spot-check
spent its `max_mutants` slots on attempts rather than on results: a mutant the compiler rejects
is dropped from the tally, so a file where two of five mutants did not compile was judged on
three, and a candidate where none of them compiled was accepted on coverage alone, which is
decision 13's escape hatch working exactly backwards.

**Decision.** `preflight` has two tiers. The default keeps only the cheap checks (tool versions
and presence, a test file exists, the coverage tool answers a no-op). `--deep` adds the smoke
coverage run, and `run` and `sweep` pass it themselves the first time they touch a repo, while
`<repo>/.covergen/baseline/` holds no cached baseline: after that, a baseline on disk is the same
proof and more of it. cargo's `--no-run` probe is gone, since the smoke run and the first baseline
each build the same crates. On the mutation side, `max_mutants` now counts applicable mutants:
uncompilable ones do not consume a slot, covergen keeps producing mutants until the slots are
full or the operators are exhausted (hard cap `3 x max_mutants` attempts), and `tried: 0` after
that is a `weak_assertions` rejection reading "no applicable mutants" rather than an acceptance.
`allow_no_mutants: true` per repo restores the old behavior for a tree of declaration-shaped
files.

**Consequences.** This amends decision 13: zero mutants is now a rejection, not a skip. A
candidate that covers only lines nothing can break is turned away, which is the point, at the
cost of rejecting some honest tests on genuinely inert code until a repo sets the flag. A cheap
preflight no longer proves the coverage plumbing writes lcov, so a misconfigured `--cov` or
`go.packages` now surfaces on the first baseline instead of in preflight; the first run still
catches it, one step later.
