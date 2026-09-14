# covergen, one page

## What it is

A command line tool that raises line coverage in an existing repo by generating
tests and discarding the ones that do not earn their place. It points at a
sibling checkout, finds uncovered lines, asks Claude for a candidate test per
chunk, and gates it. Supports RSpec, Vitest, bun test and Jest. Modeled on Uber
AutoCover, Meta TestGen-LLM, and CoverUp. Details in the README.

## How a test earns acceptance

A candidate is kept only if all five hold. Anything short of that gets up to 3
chat-continuation repair rounds, then is frozen and never generated again.

1. It passes a static rules check: no sleeps, no real network, no real clock, no
   skipped tests, no tautologies, no snapshot-only tests, at least one assertion.
2. It builds and passes `gate.k` consecutive runs (default 3). Passing once but
   not k times is recorded as `flaky`.
3. It covers a line that had zero hits before and loses none. Gain is measured
   against the whole suite, loss against a pre-splice run of the same spec.
4. The repo's own `validate` commands pass with the candidate in place
   (typecheck, lint). A nonzero exit sends the output into a repair round.
5. It kills at least one mutant. covergen breaks the lines the test just covered,
   up to 5 mutants, and re-runs. Killing none is rejected as `weak_assertions`.

## What it found on six real repos

Dry runs on 2026-09-02, one to four files per repo, all four runners. The repos
are private, so they are named here by stack:

| Repo | Runner | Example | File coverage |
|---|---|---|---|
| react-app | bun test | a payment-availability helper, one typecheck repair round | 50.0% to 93.8% |
| rails-api | RSpec | a service object's API client method | 94.4% to 100% |
| rails-monolith | RSpec | an order state-change service | 91.7% to 100% |
| next-app | Vitest | a prompt-building module, four accepted candidates | 87.0% to 97.4% |
| node-api | Vitest | an admin list component, new spec file | 17.2% to 100% |
| mobile-app | Jest | a map screen | 0% to 100% |

One real (not dry) run: `sweep --repo rails-api --limit 10` on 2026-09-03 targeted
10 files, generated 5 candidates, accepted all 5, and wrote three new specs plus
one extension, each taking its source file to 100%. Every accepted test in both
sets was re-run by hand and passed its repo's typecheck and lint.

## What it costs

- rails-api, 10 files: 556 seconds wall clock, with a cached whole-suite baseline.
  An uncached baseline on that repo exceeds five minutes and has a 30 minute cap.
- node-api, 1 file, 2026-09-03: 142.9 seconds, 2 candidates, 1 accepted, 7,328
  input tokens, 10,833 output, 18,227 cache read, 4,403 cache write.
- Every run prints its own token counts. There are no per-runner yield or token
  numbers yet from a ten-file sweep on the other five repos.

## What it will never do

- Run a model in CI. Generation is a local, human-initiated step.
- Open a pull request, from any mode, or push a branch. The nightly job commits
  locally and stops.
- Touch a repo with a dirty working tree, or overwrite an existing spec file.

## What a reviewer should look for

The gate proves a test runs the code and notices when it breaks. It does not
prove the test describes the behavior we want. Read for:

- Assertions that pin intended behavior, not whatever the code does today. A
  test that encodes a bug will block the fix.
- Mocks that stand in for the thing under test rather than its collaborators.
- Test names that say what is being asserted, and fixtures that match the repo.
- The `Mutants killed` column. `1/5` is a weaker signal than `5/5`.

## Three open questions

1. Where does the nightly job run? It needs the repos, their test dependencies,
   and local Postgres and Redis, so it cannot be a cloud routine. Not installed.
2. Who reviews the nightly branches? The job leaves a dated local branch per
   repo, report as the commit message. Someone reads it, pushes, opens the PR.
3. Do the lcov branches merge? Each target repo has a branch adding coverage
   output. Nothing runs against `main` until those land.
