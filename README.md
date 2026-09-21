# covergen

[![ci](https://github.com/brianleach/covergen/actions/workflows/ci.yml/badge.svg)](https://github.com/brianleach/covergen/actions/workflows/ci.yml)

Coverage-gated LLM test generation. covergen points at a sibling repo, finds
uncovered lines, asks Claude for candidate tests, and keeps only the candidates
that build, pass `gate.k` times in a row, strictly raise line coverage, pass the
repo's own validate commands, and kill at least one mutant on the lines they
just covered. Everything else is discarded automatically. No model ever runs in
CI: generated tests are committed and reviewed like any other code. The design
follows the published work on Uber AutoCover (ICSE-SEIP 2026), Meta TestGen-LLM,
and CoverUp. Architecture notes are in `CLAUDE.md`, design notes in
[docs/DESIGN.md](docs/DESIGN.md). Which stacks it runs on today, with the
evidence, is in [docs/SUPPORT.md](docs/SUPPORT.md).

## Install

```bash
npm i -g covergen
covergen --help
```

Node 22 or newer. Then, from the repo you want covered:

```bash
curl -o covergen.yaml https://raw.githubusercontent.com/brianleach/covergen/main/covergen.example.yaml
$EDITOR covergen.yaml                    # point the repo entries at your checkouts
echo 'ANTHROPIC_API_KEY=sk-ant-...' > .env   # only for generator: api, never committed
covergen preflight --repo <name>
```

covergen generates on your Claude Code subscription by default, so the key is
needed only with `generator: api` (see "Choosing a generator"). `preflight` is
offline and says what each runner still needs before covergen can read coverage. The seven idiom packs ship inside the package, so an
`idiom_pack: ./idioms/rspec.md` entry works without a copy of this repo: a pack of
that name next to your own config wins, and covergen falls back to the bundled one.

Contributors work from a checkout instead, with `npm run dev`. That is the Quick
start below.

## Quick start

```bash
npm install
cp covergen.example.yaml covergen.yaml   # point at sibling repos
cp .env.example .env                     # Anthropic key, only for generator: api
npm run dev -- run --repo rails-api --file app/services/foo.rb
```

`npm run dev` is `tsx src/cli.ts`. For the compiled CLI, `npm run build` then
`npm start -- run --repo rails-api --file app/services/foo.rb`.

To try covergen without wiring up another repo, run it on its own source.
`covergen.covergen.example.yaml` is a working config with `root: .`, the vitest
runner, `sources: ["src/**/*.ts"]`, and this repo's own `npm run typecheck` and
`npm test` as the validate commands:

```bash
npm run dev -- preflight --repo covergen --config covergen.covergen.example.yaml
npm run dev -- baseline  --repo covergen --config covergen.covergen.example.yaml
npm run dev -- run --repo covergen --config covergen.covergen.example.yaml --file src/git.ts
```

`preflight` and `baseline` are offline: they never call a model, so they work
before you have any credentials. `run` does call one. The config sets no `idiom_pack`
because every pack in `idioms/` is framework-specific and this project is plain
`environment: node`.

## Commands

Global options, valid before any subcommand:

| Option | Meaning |
|---|---|
| `--config <path>` | Path to covergen.yaml. Default `./covergen.yaml` |
| `--log-level <level>` | `trace`, `debug`, `info`, `warn`, `error`, `fatal` or `silent` |

```
covergen run       --repo <name> --file <rel...> [--dry-run] [--fast] [--refresh-baseline]
covergen sweep     (--repo <name> | --all) [--pr] [--changed-since <ref>] [--limit <n>] [--dry-run]
                   [--max-tokens <n>] [--max-minutes <n>] [--report <path>] [--refresh-baseline]
covergen preflight --repo <name> [--deep]
covergen baseline  --repo <name> [--top <n>]
covergen audit     --repo <name> [--limit <n>] [--report <path>] [--deep] [--pr]
                   [--min-savings-ms <n>]
covergen pr        --from <journal> [--pr-max-lines <n>]
```

`run` generates tests for the source files you name.

| Flag | Meaning |
|---|---|
| `--repo <name>` | Required. A repo name from covergen.yaml |
| `--file <rel...>` | Required. One or more source files, relative to the repo's cwd |
| `--dry-run` | Gate everything but do not write spec files |
| `--fast` | Baseline only the target's existing spec instead of the whole suite |
| `--refresh-baseline` | Ignore the cached whole-suite baseline |

`sweep` generates across a repo instead of a named list.

| Flag | Meaning |
|---|---|
| `--repo <name>` | A repo name from covergen.yaml. Required unless `--all` is given |
| `--all` | Every repo in covergen.yaml, in config order. See "Unattended sweeps" |
| `--pr` | Commit the accepted tests on a `covergen/` branch and open a draft PR |
| `--changed-since <ref>` | Only files changed since this git ref, filtered by the repo's `sources` globs |
| `--limit <n>` | Maximum source files to target, per repo. Default 10 |
| `--order <mode>` | Target order before `--limit`: `value` (default, branch-weighted), `gap` (most uncovered lines first) or `glob` |
| `--pr-max-lines <n>` | Lines of accepted spec one draft PR may hold, overriding `sweep.pr_max_lines`. A larger run opens several PRs. `0` opens one |
| `--max-tokens <n>` | Run-wide token ceiling, overriding `sweep.max_tokens_per_run` |
| `--max-minutes <n>` | Run-wide wall-clock ceiling, overriding `sweep.max_minutes` |
| `--report <path>` | Write a JSON report of the run to this path |
| `--dry-run` | Gate everything but do not write spec files |
| `--refresh-baseline` | Ignore the cached whole-suite baseline |

`preflight` checks that the repo's runner and coverage reporter are usable and
prints a fix hint when they are not. It has two tiers. By default it runs only
the cheap checks: tool versions, the tools being present at all, a test file
existing, and the coverage tool answering a no-op, all of which take seconds and
no build. `--deep` adds the smoke coverage run, a real coverage pass that selects
no test, which is the only thing that proves the coverage plumbing writes lcov
where covergen expects it. `run` and `sweep` choose the tier themselves: deep the
first time they touch a repo, cheap once `<repo>/.covergen/baseline/` holds a
cached baseline, because a baseline on disk is that same proof and more of it.

`baseline` runs the suite with coverage and
prints the highest-value targets with the components of each score (uncovered
lines, branch density, churn, importers); `--top <n>` sets how many rows to
print, default 30.

### audit

`audit` points the same gate at the tests the repo already has. On its own it
writes a report and changes nothing: no test is edited or deleted, no PR is
opened, and no model is called. `--pr` is the go-ahead that turns the report into
a deletion proposal, the same rule `sweep --pr` follows.

| Flag | Meaning |
|---|---|
| `--repo <name>` | Required. A repo name from covergen.yaml |
| `--limit <n>` | Audit at most this many spec files, cheapest-value first. `0` (the default) audits every one |
| `--report <path>` | Write the JSON report to this path. The markdown always goes to `<repo>/.covergen/audit.md` |
| `--deep` | Plant bugs against every case, not only the ones the static pass flagged |
| `--pr` | Cut the cases that catch nothing and cover nothing unique, and open a draft PR proposing it |
| `--min-savings-ms <n>` | Leave a case alone unless cutting it gives back at least this many ms per run |

The unit of judgment is the test case (an `it`/`test` block, a Go `TestXxx`, a
pytest function), not the file; file totals are derived from it. vitest, jest,
go and pytest can name a single case, so those four are audited case by case.
bun, cargo and rspec cannot yet, so for them the spec file is the unit and the
report says so.

Three passes, cheapest first:

1. **Static**, free, over every case. The rules registry decides: a case with no
   assertion, only assertions that pass whatever the code did, or only a pinned
   declaration is flagged.
2. **Dynamic**, bounded. Every case in a spec file that holds a flagged one runs
   alone with coverage, bugs are planted on the source lines it covers
   (`mutation.max_mutants` of them), and the case is re-run against each. `--deep`
   widens this to every spec file. The whole run stops at `sweep.max_minutes`.
3. **Cost**, from the wall time those runs already measured, per spec file.

The verdicts:

| Verdict | Means |
|---|---|
| `keeps` | Nothing fired. The case caught at least one planted bug, or nothing could be planted and it reads fine |
| `weak_static` | It runs code and checks nothing: no assertion, a tautology, or a pinned declaration |
| `weak_dynamic` | Bugs were planted on the lines it covers and it caught none of them |
| `redundant` | `weak_dynamic`, and every line it covers is covered by something else in the suite too |

A case no bug could be planted against is never judged dynamically, the same way
the gate's spot-check has no opinion when no operator applies. Redundancy is
measured by subtracting the whole spec file from the suite's coverage, which
under-reports rather than over-reports it: a line two spec files both cover
counts as this file's own.

`--pr` removes only a case whose verdict is `redundant`, or one that is both
`weak_static` and `weak_dynamic`. Two rules bound that, and neither has an
override:

- a case that catches even one planted bug is never proposed, whatever its
  coverage.
- a case that is the only coverage of any line is never proposed, whatever it
  asserts. The PR lists it as a case to repair instead.

The cut is textual, at the block the case opens on, and a file left with no
cases is deleted whole. The suite then runs in full with coverage, and unless it
passes with the same lines covered, every file is put back and nothing is
opened. The draft PR carries the evidence per case: the verdict, the planted
bugs it did not catch, the lines nothing else covers (always zero), and the
seconds each full run gets back. A human reviews it like any other code change.

Exit codes: `0` at least one test was accepted, `2` nothing was accepted (a
normal outcome, not an error), `1` something broke, `130` a signal stopped the run
(see "Killing a run"). `preflight` exits `0` on OK and `1` on FAIL. `audit` exits
`0` when it flagged at least one case and `2` when it flagged none. `run` and
`sweep` print a PR body to stdout and also write it to
`<repo>/.covergen/last-run.md`.

## Configuration

covergen.yaml is validated with Zod. Copy `covergen.example.yaml` to
`covergen.yaml` (gitignored) and edit the paths. Repo roots resolve relative to
the config file. So do idiom pack paths, except that a path with no file at it
falls back to the pack of the same name bundled with covergen.

### Top-level keys

| Key | Default | Meaning |
|---|---|---|
| `generator` | `claude-code` | `claude-code` spends a Claude subscription, `api` the metered key. See below |
| `claude_code.binary` | `claude` | Claude Code binary for the `claude-code` generator |
| `claude_code.concurrency` | `1` | In-flight candidates on the subscription backend |
| `claude_code.max_tokens_per_sweep` | `2000000` | Tokens a subscription run may spend before it stops calling. `0` disables |
| `claude_code.timeout_ms` | `600000` | Ceiling on one headless turn |
| `anthropic.api_key_env` | `ANTHROPIC_API_KEY` | Name of the variable holding the key |
| `anthropic.generator_model` | `claude-opus-5` | Model that writes candidates |
| `anthropic.repair_model` | `claude-sonnet-5` | Model that runs the repair rounds |
| `anthropic.max_tokens` | `16384` | Per-reply cap. A truncated reply is a loud error |
| `gate.k` | `3` | Consecutive passing runs required (pass^k) |
| `gate.timeout_ms` | `300000` | Per-run timeout inside the gate. A run that hits it has its whole process group killed, SIGTERM then SIGKILL, so an orphaned test worker cannot stall the sweep |
| `gate.baseline_timeout_ms` | `1800000` | Ceiling for the whole-suite baseline |
| `gate.max_repair_rounds` | `3` | Chat-continuation repairs before a candidate is given up on |
| `mutation.enabled` | `true` | Spot-check accepted tests by breaking the lines they cover |
| `mutation.max_mutants` | `5` | Applicable mutants per candidate, bounded so the gate stays cheap. Mutants the compiler rejects do not fill a slot; at most `3 x max_mutants` are written and run to fill them |
| `mutation.min_killed` | `2` | Absolute floor, clamped to the mutants actually generated. Fewer killed rejects the candidate as `weak_assertions` |
| `mutation.min_killed_ratio` | `0.6` | Share of the mutants tried that must be killed. `0` leaves only the floor |
| `mutation.timeout_ms` | `300000` | Per-mutant run timeout |
| `sweep.max_tokens_per_run` | `0` | Tokens one run may spend across every repo in it. `0` disables |
| `sweep.max_minutes` | `300` | Wall-clock minutes before a run stops starting new work. `0` disables |
| `sweep.pr_max_lines` | `600` | Lines of accepted spec one draft PR may hold. A larger run is split into part PRs. `0` opens one PR however large |
| `sweep.pr_max_lines_per_file` | `500` | Lines one spec file may reach before the run stops adding segments to it and leaves the rest for the next run. `0` disables |
| `segments.max_lines` | `50` | Largest uncovered chunk sent as one candidate (CoverUp's cap) |
| `segments.max_per_file` | `8` | Most segments taken from one source file |
| `state_dir` | `.covergen` | Directory inside each target repo for state and scratch |
| `repos` | required | One entry per target repo, at least one |
| `refresh_base` | `true` | Fast-forward each checkout to its default branch before an unattended run. Only ever a fast-forward: a dirty checkout, or a branch holding commits of its own, is left alone. `false` uses each checkout exactly as it is found |

### Per-repo keys

| Key | Required | Meaning |
|---|---|---|
| `name` | yes | The name you pass to `--repo` |
| `root` | yes | Path to the repo, resolved relative to covergen.yaml |
| `runner` | yes | `rspec`, `vitest`, `bun`, `jest`, `pytest`, `go` or `cargo`. An entry with `sweep: false` may name a runner this build does not have: it loads with a one-line warning instead of failing the whole config |
| `cwd` | no, default `.` | Working directory inside `root`, for example `apps/web` in a monorepo |
| `sources` | yes | Globs for source files eligible for generation |
| `spec_template` | no | Where the spec for a source file lives. See below |
| `idiom_pack` | no | Markdown loaded verbatim into the stable prompt block |
| `generator` | no | `api` or `claude-code` for this repo only, overriding the top-level setting |
| `sweep` | no, default `true` | `false` leaves the repo out of `sweep --all`. `--repo <name>` still works |
| `command_prefix` | no | Wraps every runner command, for example `["rbenv","exec"]` or `["docker","compose","exec","-T","api"]` |
| `validate` | no, default `[]` | Commands run in `cwd` after the coverage gate passes, with the candidate still spliced in |
| `disable_rules` | no, default `[]` | Rule ids from `src/rules.ts` to switch off for this repo, e.g. `[behavioral-evidence]`. An unknown id is a config error |
| `pytest` | no | pytest only. `command` (default `["python","-m","pytest"]`), `package` (the `--cov` target, default derived from `sources`) and `test_glob` (default `tests/**/test_*.py`) |
| `go` | no | go only. `command` (default `["go","test"]`), `packages` (default `["./..."]`), `race` (default `true`, applied to the gate runs only) and `build_tags` |
| `cargo` | no | cargo only. `command` (default `["cargo","llvm-cov"]`), `packages` (crates to test, each passed as `-p <crate>`; default `[]`, the whole workspace) and `test_args`, extra arguments passed to the test harness after `--` |
| `allow_no_mutants` | no, default `false` | Accept candidates the mutation spot-check found nothing applicable to mutate on, instead of rejecting them as `weak_assertions` |

`validate` is a list of argv arrays, for example
`[["bun","run","type-check"],["bunx","eslint","--max-warnings=0","src/__tests__"]]`.
Any nonzero exit rejects the candidate as `build_failed` and sends the command's
output into the repair loop, so typecheck and lint failures get fixed rather than
merged.

### spec_template

`spec_template` turns a source path into the conventional spec path. The
placeholders are `{dir}` (the source directory relative to cwd), `{dir_sans_app}`
and `{dir_sans_src}` (the same with a leading `app/` or `src/` stripped),
`{base}` (file name without extension) and `{ext}` (the extension, with the dot).
Defaults per runner:

| Runner | Default template |
|---|---|
| rspec | `spec/{dir_sans_app}/{base}_spec.rb` |
| vitest | `{dir}/{base}.test{ext}` |
| bun | `src/__tests__/{dir_sans_src}/{base}.test{ext}` |
| jest | `{dir}/__tests__/{base}.test{ext}` |
| pytest | `tests/{dir_sans_src}/test_{base}.py` |
| go | `{dir}/{base}_test.go` |
| cargo | `{dir}/{base}{ext}`, the source file itself |

### The mutation block

This step is mutation testing: covergen plants small, deliberate bugs in the
lines the candidate covers and checks that the test notices. Once a candidate
has passed pass^k, gained coverage, lost nothing, and passed
`validate`, covergen edits the source lines the candidate newly covered, one
edit per mutant, up to `mutation.max_mutants`. The operators are relational,
boolean, logical, condition, numeric, return and predicate, applied to `.rb`,
`.py`, `.go`, `.rs` and `.ts`, `.tsx`, `.js`, `.jsx` files; other extensions
produce no mutants. Python
gets its own variants where the syntax differs (`True`/`False`, `and`/`or`, an
`if` header negated in place instead of Ruby's `unless`), and Go gets comparison
flips, `&&`/`||`, `true`/`false`, integer off-by-one and a `return err` to
`return nil` swap, the `nil` direction taken only where the file has a plain
`return err` so the name is in scope. Rust gets comparison flips, `&&`/`||`,
`true`/`false` and a negated `if` header, and neither the numeric nor the return
operator, because an incremented typed literal and a substituted return value are
both compile errors rather than test results. Every edit stays inside
one line so indentation holds, and a mutant the language could not parse, or that
failed `go build` or `cargo build`, counts
as not applicable rather than killed. The
candidate is re-run against each mutated source. A mutant that makes the test
fail is killed, which is the outcome we want.

Two thresholds decide, and both must be met. `mutation.min_killed` is an absolute
floor, clamped to the number of mutants that actually existed so a line with one
mutant is judged on that one rather than rejected for a bar it could never reach.
`mutation.min_killed_ratio` is the share that must die, so the floor does not
become the whole bar when there are five mutants. Missing either rejects the
candidate as `weak_assertions`, and the PR body names every survivor: those lines
say exactly which change to the code the test would have let through.

`mutation.max_mutants` counts applicable mutants, not attempts. A mutant the
compiler rejects is not a result, so it does not consume a slot: covergen keeps
producing mutants until `max_mutants` of them actually ran or the operators run
out of edits for those lines, bounded by a hard cap of `3 x max_mutants`
attempts. If nothing applicable is left after that, the spot-check reports
`tried: 0` and the candidate is rejected as `weak_assertions` with "no bug could
be planted" rather than accepted on coverage alone: nothing on the lines it
covered can be broken in a way the test could notice, which is the outcome the
spot-check exists to catch. A repo of declaration-shaped files where that is
normal sets `allow_no_mutants: true` on its entry to accept them instead.

### Fast mode

`--fast` baselines only the target's existing spec instead of the whole suite.
It is much faster and fine for a single file, but a line some other spec already
covers then counts as a gain.

### Baseline cache and --refresh-baseline

A whole-suite baseline is slow and depends only on the tree, so it is cached at
`<repo>/.covergen/baseline/<fingerprint>-<entry>.lcov`, where the fingerprint is
HEAD plus the names and contents of dirty working-tree files. Any content change
to the tree produces a new fingerprint and a new baseline. The cache lives under
the entry's `root` and the entry key namespaces it, hashing `cwd` relative to
root plus the runner, the command prefix and the source globs, so two entries
sharing one monorepo root with different `cwd` never read each other's coverage;
on load, a cached baseline that mentions fewer than half of the entry's own
source files is treated as someone else's and the suite runs again.
`--refresh-baseline` ignores the cache and runs the suite again. Fast mode does
not use the cache.

### Choosing a generator

`generator: claude-code` is the default: covergen runs `claude -p` on the
machine's own Claude Code login, so the tokens come out of a Claude
subscription. `generator: api` is the backup, for when the subscription window
is exhausted or unavailable: it calls the Messages API with your key and bills
per token. Set either globally, per repo, or per invocation with
`COVERGEN_GENERATOR=api`. A preflight failure never switches billing for you: it
stops and names the backup.

**Behavior change in this version.** A config that does not mention `generator`
used to call the metered API and now spends a subscription. Add `generator: api`
to keep the old behavior.

The trade-offs are real in both directions:

- The subscription window is shared with every interactive session and scheduled
  job on that account, so a long sweep competes with your own typing.
- There is no dollar figure. A subscription run reports tokens and says so, and
  the runaway guard is `claude_code.max_tokens_per_sweep`, after which the
  backend refuses to call again.
- It is slower per candidate: `claude_code.concurrency` defaults to 1 in-flight
  candidate, against unlimited fan-out on the API backend.
- `anthropic.repair_model` is ignored, because a repair resumes the session that
  generated the candidate. Both run on `anthropic.generator_model`.

`preflight` checks the backend too: the binary must be on PATH and `claude auth
status` must report a login, and nothing about the credentials is read or
printed. The child runs with no tools, no MCP servers, no settings files and in
an empty scratch directory, so a target repo's hooks and `CLAUDE.md` never reach
it. It also runs with `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT` and
`ANTHROPIC_API_KEY` stripped from its environment, so it works from inside an
agent session and never quietly falls back to API billing. Resuming a session by
id needs Claude Code 2.1.223 or newer.

### Where the key lives

The Anthropic key is read from a `.env` file next to `covergen.yaml`, parsed into
a private map, and handed straight to the Anthropic client. It is never put in
`process.env`, because the test runners inherit that environment and some suites
call the real API when they see a key. A variable already set in the
shell wins over the `.env` value. When no key is found, covergen warns at startup
and `run` and `sweep` fail at generation.

## Per-repo requirements

Every runner must emit lcov. `preflight` tells you what is missing.

- **RSpec**: `bundle exec rspec --version` must work, a `Gemfile.lock` must exist
  in the repo cwd or root, and it must contain `simplecov-lcov`. Add it with
  `bundle add simplecov-lcov --group test` and paste the spec_helper snippet that
  preflight prints, which installs the lcov formatter when covergen sets
  `COVERAGE` and `SIMPLECOV_LCOV`. Set `command_prefix` (for example
  `["docker","compose","exec","-T","api"]`) when the suite runs in a container,
  or `["rbenv","exec"]` for a pinned Ruby.
- **Vitest**: `@vitest/coverage-v8` or `@vitest/coverage-istanbul` must be
  installed under the repo cwd or root. Dynamic-route paths are handled: the
  per-file coverage include is a glob, so covergen escapes segments like
  `[id]` before passing them, and targets under such a directory report
  coverage normally.
- **bun test**: `bun --version` must work. Nothing else is needed; lcov is
  requested on the command line.
- **Jest**: `node_modules/jest` must exist under the repo cwd or root. lcov is
  requested on the command line.
- **Go**: `go version` must report 1.22 or newer, `go vet` must build the
  configured `go.packages`, at least one `_test.go` file must exist under them,
  and a deep preflight ends with a real coverage run that selects no test, because
  a wrong package set is otherwise silent. See "The Go runner" below.
- **Rust**: `cargo llvm-cov --version` must answer, and a deep preflight ends with
  a real coverage run that selects no test. That last step is the one that
  matters: `--version` succeeds without the
  LLVM tools and only the real run fails. See "The Rust runner" below.
- **pytest**: the interpreter and `pytest` must answer `--version`, `pytest-cov`
  must be registered (`python -m pip install pytest pytest-cov`), and something
  must match `pytest.test_glob`. A deep preflight ends with a real coverage run that
  selects no tests, because a wrong `--cov` target is otherwise silent: it reports
  nothing, and then every candidate is rejected for adding no coverage. Set
  `pytest.command` for `uv` or `poetry`, `pytest.package` when the importable
  package is not the static prefix of `sources`. Coverage cannot be narrowed to
  one file here, so a run always measures the whole package.

Add `.covergen/` to your global gitignore. It holds per-repo state, the last run
report, and scratch coverage output.

### The Go runner

`go test -coverprofile` writes Go's own block profile rather than lcov, so
covergen converts it in process: no `gcov2lcov`, no extra tool in the repo. Each
`file:startLine.col,endLine.col numStmts count` block becomes a hit count on
every line it spans, and a line touched by more than one block takes the highest
count. **The figures are therefore statements-based**: a `func` signature line
counts as covered when the function ran, and a line carrying no statement is not
reported at all. It is the same number `go test -cover` prints, projected onto
lines, and it is comparable run to run, which is what the gate needs.

Three more things differ from the other runners:

- **Tests are selected by package, never by file.** A gate run over
  `foo_test.go` runs the package that file lives in. `-coverpkg` stays the
  configured `go.packages` whatever is being run, so a one-package gate run is
  comparable to the whole-suite baseline, and the delta is narrowed to the target
  file afterwards.
- **`gofmt` is a gate.** A candidate that is not gofmt formatted is rejected as
  `build_failed` before the suite runs, and the `gofmt -d` diff goes into the
  repair loop. Go projects treat unformatted code as a failure and so does this.
- **`-race` is on, for the gate runs only.** pass^k cannot see a data race: k
  runs on one idle machine all pass, and the same test fails the first time it
  shares a runner, which is a flake in the repo's CI rather than a rejection here.
  The detector is the only check that turns that into a failure at gate time, so
  the gate runs pay for it and the baselines, which measure coverage, do not. Set
  `go.race: false` per repo when the instrumented build is too slow to bear.

`sources` wants the shape below, because Go keeps its tests beside the code and
they would otherwise be offered as generation targets:

```yaml
repos:
  - name: daemon
    runner: go
    sources: ["**/*.go"]
    exclude: ["**/*_test.go"]
    go:
      packages: ["./..."]      # what is tested and what -coverpkg measures
      race: true               # -race on the gate runs, not on the baseline
      build_tags: ["integration"]
```

### The Rust runner

`cargo llvm-cov --lcov --output-path <file>` writes lcov directly, so there is no
conversion step. Install it with:

```bash
cargo install cargo-llvm-cov
rustup component add llvm-tools-preview
```

On a distro-packaged cargo with no rustup, install the `llvm` package instead and
point the driver at it: `LLVM_COV=/usr/bin/llvm-cov
LLVM_PROFDATA=/usr/bin/llvm-profdata`. Preflight prints both routes, because
`cargo llvm-cov --version` answers with neither of them in place.

Four things differ from the other runners:

- **Tests live in the source file.** The default `spec_template` is the source path
  itself, and a candidate is appended as a `#[cfg(test)] mod tests` block, because
  that is the only way to reach a crate's private items. Set
  `spec_template: "tests/{base}.rs"` for a library whose convention is integration
  tests against the public API.
- **Test lines are stripped out of the lcov.** llvm-cov reports a `#[cfg(test)]`
  module as coverage of the file it sits in, so a candidate would otherwise "cover"
  its own test body and pass the gate on that alone. The runner removes every line
  inside a `#[cfg(test)]` region before anything reads the report, which is why the
  numbers here describe the code and not the tests.
- **Tests are selected by crate, never by file.** A gate run over a spec resolves
  the owning package through `cargo metadata` and runs `-p <package>`; a whole-suite
  run uses the crates in `cargo.packages`, each as `-p <crate>`, and `--workspace`
  only when that list is empty. Setting it is how a workspace with a red test in a
  crate nobody sweeps keeps its baseline: without it the baseline runs that crate,
  and a failing test there used to be the whole run's problem. A failing test the
  baseline does hit is now a warning naming the crate, not a dead run, and the
  baseline pass adds `--no-fail-fast` so one failure does not hide the crates
  behind it. `wholeProject` needs no flag: llvm-cov reports everything
  compiled into the test binaries, loaded by a test or not.
- **Mutants are limited to what still compiles.** Comparison flips, boolean swaps,
  `&&`/`||` swaps and a negated `if` header are applied; incremented integer
  literals are not, because `255u8 + 1` is a deny-by-default overflow lint rather
  than a test result, and `return` values are not, because Rust has no universal
  empty value to substitute. A mutant rustc rejects anyway (a comparison flip inside
  a generic) counts as not applicable, not as killed.

`rustfmt` is not enforced the way `gofmt` is for Go. Add it as a validate command
when the repo expects it:

```yaml
repos:
  - name: engine
    runner: cargo
    sources: ["crates/**/src/**/*.rs"]
    validate: [["cargo", "fmt", "--check"], ["cargo", "clippy", "--", "-D", "warnings"]]
    cargo:
      packages: ["engine-core", "engine-cli"]
      test_args: ["--test-threads=1"]
```

## Reading a run

`run` and `sweep` print a markdown report. It opens with the mutation score,
above the coverage numbers, because a test that raises coverage without noticing
a broken line is the thing this tool exists to avoid:

```
Tests that catch regressions: caught 7 of 9 planted bugs (78%).
```

The accepted-tests table has these columns:

| Column | What it holds |
|---|---|
| Spec | The spec file the test was written into, relative to the repo cwd |
| Symbol | The enclosing function or class covergen aimed at, or `path:line` when it could not detect one |
| Lines newly covered | How many source lines went from zero hits to nonzero, with the first eight line numbers |
| Before | Line coverage of the source file before the test |
| After | Before plus the measured gain |
| Planted bugs caught | `killed/tried`, or `n/a` when the spot-check was off or no operator applied |
| Assertions | The matcher names the test uses, so a row of `toBeDefined` is visible without opening the file |

Rejected candidates are grouped by status, largest group first, each entry
naming the symbol, the spec path, and the first line of the last error. A
candidate rejected for weak assertions also lists every mutant it survived, one
line each, which is the concrete answer to what the test failed to notice. The
report ends with token usage (input, output, cache read, cache write) and a note
telling the reviewer to check that the assertions describe intended behavior and
not just current behavior.

### Why a test gets rejected

Every reason a candidate can be turned away, in the order the pipeline applies
them. The first nine are rules in `src/rules.ts`, checked on the text before
anything is run, and they apply again to every repaired candidate. A repo can turn
any of them off with `disable_rules`.

| Reason | The test is rejected because it |
|---|---|
| `no-sleep` | Sleeps or waits on a timer instead of driving time directly |
| `no-deadline-poll` | Polls a fixed number of times with a sleep between attempts and no wall-clock deadline or context timeout. pass^k on one machine cannot see it: the test passes k times alone and fails the first time it shares a runner |
| `no-os-specific` | Assumes one operating system (a `/proc` or `/sys` path, a `syscall` constant, the Keychain, a hardcoded path limit, or a `runtime.GOOS` branch that skips nothing) without a guard that skips. Go, vitest, jest, bun and pytest |
| `no-real-network` | Makes a real HTTP call with no stub anywhere in the file |
| `no-real-clock` | Reads the real clock without freezing time first |
| `no-skipped-tests` | Contains a skipped, pending, todo or x-prefixed example |
| `no-tautology` | Asserts a literal against itself, so it cannot fail |
| `no-snapshot-only` | Has a snapshot as its only assertion, which records behavior rather than specifying it |
| `behavioral-evidence` | Never calls the code under test with an input (`declaration_snapshot`), or asserts only with matchers that pass whatever the code did (`tautological`) |
| `build_failed` | Did not compile or load, or failed a `validate` command |
| `test_failed` | Ran and failed, after its repair rounds |
| `flaky` | Passed at least once but not `gate.k` times in a row |
| `no_coverage_gain` | Covered no new line, or lost one another spec had |
| `weak_assertions` | Kept passing while the lines it covers were broken, missing `mutation.min_killed` or `mutation.min_killed_ratio`, or covered only lines no operator could break at all ("no bug could be planted", unless the entry sets `allow_no_mutants`) |

The rejection that matters most is the last one. A test that raises coverage
without noticing a broken line is worse than no test: it costs a review, it costs
a CI slot on every run forever, and it reports confidence that is not there.

### Candidate statuses

| Status | Meaning | What to do |
|---|---|---|
| `generated` | Written by the model, not yet gated | Nothing; a run should not end here |
| `rule_violation` | Tripped a rule in `src/rules.ts` before the gate ran | Read the reason. If the rule was wrong, fix the rule, not the test |
| `build_failed` | Did not compile or load, or a `validate` command exited nonzero | Read the error; usually a bad import or a lint rule the idiom pack does not mention |
| `test_failed` | Ran and failed after the repair rounds | Usually the model misread the code. Check the segment in the report |
| `flaky` | Passed at least once but not `gate.k` times in a row | Real flakiness in the code or the suite. Worth investigating on its own |
| `no_coverage_gain` | Passed but covered no new lines, lost lines, or produced no lcov | Often means another spec already covers those lines |
| `tautological` | Every assertion is a weak matcher: `toBeDefined`, `toBeTruthy`, `not.toThrow`, a snapshot, a value compared to itself | Assert the value the code returns. `toBeFalsy`, `toBeNull` and `be_nil` are not weak and are never rejected for it |
| `declaration_snapshot` | Never called the code under test with an input, so it pins a declaration rather than behavior | Call one exported function with a real argument. Both verdicts share one repair round with `weak_assertions` |
| `os_specific` | Reaches for something only one operating system has, with no platform guard that skips | Use the portable equivalent (`t.TempDir()` for files), or guard it with `if runtime.GOOS != "linux" { t.Skip(...) }` |
| `weak_assertions` | Passed and gained coverage but missed the mutation floor or ratio | The test runs the code without asserting on it. The PR body names the planted bugs it let through |
| `accepted` | Passed everything and was written into the spec file | Review it like any other code |
| `frozen` | The same test text was already tried in an earlier run, or is already accepted | Nothing. Frozen hashes are skipped so no tokens are spent on them |

Every status except `generated`, `accepted` and `frozen` freezes the candidate's
hash, so a chronic non-improver is never generated again.

### What lands in .covergen/

Inside each target repo, at `<repo root>/.covergen/` (or whatever `state_dir` says):

| Path | Contents |
|---|---|
| `state.json` | Version, frozen hashes, accepted hashes, and the last 20 run summaries. Written atomically |
| `candidates/<status>-<hash>.<ext>` | Every candidate's final code, accepted or not, named by status and the first 12 characters of its hash |
| `last-run.md` | The report from the most recent run, same text that went to stdout |
| `runs/<id>.json` | One journal per run: the accepted spec paths and hashes, tokens so far, and how the run ended (`finished`, `aborted`, `reverted`, with the reason). Rewritten after every gate decision |
| `baseline/<fingerprint>-<entry>.lcov` | Cached whole-suite baselines, keyed by HEAD plus dirty file contents plus the entry's cwd, runner and source globs |
| `coverage/<stamp>/` | Scratch coverage output, one directory per runner invocation |

Each candidate file starts with comment header lines (`#` for Ruby, `//`
otherwise): `status`, `spec`, `source` with the line range and symbol,
`attempts`, `newly covered` when a delta exists, and `last error` when there was
one. `candidates/` is cleared at the start of each run.

The nightly script writes its own logs and reports to `.covergen/logs/` inside
this covergen checkout, not inside the target repos.

## Adding a repo

1. Add an entry to `covergen.yaml` with `name`, `root`, `runner` and `sources`.
   Set `cwd` if the suite runs from a subdirectory. Set `command_prefix` if the
   suite needs a version manager or a container.
2. Run `covergen preflight --repo <name>` and do whatever it asks. Every runner
   must be able to write an lcov file; that is the one hard requirement.
3. Point `idiom_pack` at a markdown file describing how tests are written in that
   repo. The packs in `idioms/` cover rspec, vitest on Next.js, bun test, and
   Jest on Expo, pytest and Go, and they ship inside the installed package, so
   `./idioms/rspec.md` resolves to the bundled pack when your own config
   directory has no such file. A repo without a pack still works, it just gets
   less guidance.
4. Set `spec_template` if the repo does not follow the runner's default layout.
5. Add `validate` commands so the repo's own typecheck and lint gate every
   candidate.
6. Run `covergen baseline --repo <name>` to see where the coverage holes are,
   then `covergen run --repo <name> --file <one file> --dry-run`.

## Adding a runner

1. Add the name to `RunnerName` in `src/types.ts` and to `runnerNames` in
   `src/config.ts`, and give it a default `spec_template`. A language whose tests
   live in the source file (Rust) points that template at the source path and
   filters its own test lines out of the lcov, as `src/runners/cargo.ts` does.
2. Implement the `Runner` interface in `src/runners/<name>.ts`: `name`,
   `preflight(repo)`, `run(repo, opts)` and `specPathFor(repo, relSource)`.
   Follow the existing runners: shell out through `runCommand` with an argv
   array, never a shell string, and honor `repo.commandPrefix` via `withPrefix`.
3. lcov is the contract. Ask the runner for a per-run directory from
   `coverageOutDir(repo)`, tell the tool to write lcov there, and return the
   resolved path as `lcovPath` on the `RunResult`. A missing lcov is not a test
   failure: keep the exit code and leave `lcovPath` undefined so the caller can
   report it. Honor `opts.wholeProject`: when it is set the lcov must list every
   file the repo's coverage config matches, including files no test loaded, because
   that is how a file with no spec at all becomes a target. When it is not set,
   report only what the run touched.
4. `preflight` must throw an Error whose message names the repo or cwd, says what
   is missing, and gives the exact command that fixes it. The RSpec runner also
   prints the spec_helper snippet the repo has to adopt. Preflight should be
   cheap: a version check and a file existence check, not a test run.
5. Register the runner in `src/runners/index.ts` and export its factory.
6. Add `src/runners/<name>.test.ts` alongside, using the injectable `ExecFn` the
   other runner tests use.

## Unattended sweeps

`covergen sweep --all` runs every repo in covergen.yaml, in config order, under
one pair of run-wide ceilings. It is the mode a cron job or a launchd timer
runs: no session watches it, so the stop conditions and the report matter more
than the output on stdout.

```bash
covergen sweep --all --limit 5 --max-minutes 240 --report .covergen/logs/sweep.json
```

A repo with `sweep: false` in its config entry is left out. A repo that fails
preflight, times out on its baseline, or matches no sources is logged and
skipped with a reason: one bad repo never ends the run.

### The two ceilings

| Ceiling | Config key | Default | What it counts |
|---|---|---|---|
| `--max-tokens <n>` | `sweep.max_tokens_per_run` | `0`, off | Tokens across every repo in the run |
| `--max-minutes <n>` | `sweep.max_minutes` | `300` | Wall clock from the start of the run |

Both are enforced on both generators, which is the difference from
`claude_code.max_tokens_per_sweep`: that one guards a single pipeline run on the
subscription backend, these guard the whole night on either backend. They apply
to `run` and to a single-repo `sweep` as well, so one invocation cannot outspend
the ceiling either.

When a ceiling is reached the candidate in flight finishes, and every remaining
target and repo is skipped. The run report, the printed summary, and the PR body
of every emitted report all say so, so a short night is never mistaken for a
clean one.

Pick the token ceiling with the subscription in mind: that usage window is shared
with every interactive session and scheduled job on the account, so a sweep
allowed to spend all of it overnight leaves your own morning session with none.

### Draft PRs

`--pr` turns each repo that accepted a test into a draft PR, which is what makes
the mode worth running unattended: the morning finds PRs, not dirty checkouts.

Per repo, covergen branches `covergen/<yyyymmdd>-<random>` from the repo's
default branch (read from `origin/HEAD`, `main` when there is none), commits the
spec files it wrote and nothing else, pushes with an explicit
`HEAD:refs/heads/<branch>` refspec, and runs `gh pr create --draft` with the same
report `sweep` prints. The branch name is asserted to start with `covergen/`
immediately before the push, so a default branch is never the target. The
checkout is put back on the branch it started on afterwards.

Two refusals are deliberate:

- **A dirty checkout is skipped**, before the run rather than after. The commit
  names the paths covergen wrote, so an edit that was already there would either
  be swept into the PR or block the commit. Commit or stash first. covergen's own
  state directory does not count as dirty.
- **`--dry-run --pr` opens nothing.** A dry run writes no spec file, so there is
  nothing to commit; the report says so per repo rather than implying a PR exists.

`gh` must be on PATH and authenticated for the target remote. `--pr` also works
with `--repo <name>` for one repo.

### Splitting a big night into part PRs

A PR nobody can review is a PR nobody merges, so the size of the review, not the
size of the run, decides how many PRs a repo gets. When a repo's accepted spec
files add up to more than `sweep.pr_max_lines` (600 by default,
`--pr-max-lines <n>` to override), covergen packs them greedily in accepted order
and opens one draft PR per group, titled `... (part k of n)`.

Every part is branched on its own from the commit the run was proved on (see
"The base a run is proved on"). They are not stacked:
any part can merge alone, and the parts can merge in any order. Each body lists
its own spec files with their line counts and links the other parts, and the
report records every URL under `repos[].prUrls`.

A file larger than the whole budget gets a part to itself rather than being
split, because a spec file is only reviewable whole. `sweep.pr_max_lines_per_file`
(500) is what keeps that rare: once a spec reaches it the run stops adding
segments to that file and leaves the rest for the next run.
`segments.max_per_file` bounds how many candidates a source file gets, not how
many lines they add, so the two ceilings do different jobs.

Pick `--limit` by the number of PRs you are willing to read, not the number of
files. A logic-only sweep accepts roughly one test per 90 lines of spec, so about
six or seven accepted tests fill one 600-line PR. `--limit 5` is usually one PR,
`--limit 10` is one or two, and `--limit 25` is a morning of reviewing. The
nightly examples below use `--limit 5` for that reason.

### The run report

`--report <path>` writes one JSON file per run: start and end times, the ceiling
that stopped it if one did, and per repo the targets attempted, tests accepted,
rejected candidates by reason, tokens spent, and the reason nothing ran when
nothing did. The same thing goes to stdout at the end, one line per repo.

Two of those fields are the quality record, and they are stable names meant to be
read by whatever keeps the coverage ledger:

| Field | Meaning |
|---|---|
| `mutation` | Run-wide `{ killed, tried, score }`. `score` is killed over tried, rounded to three decimals, or `null` when nothing was mutated |
| `repos[].mutation` | The same three fields for one repo |
| `repos[].acceptedSpecs[]` | One entry per accepted test: `spec`, `symbol`, `newlyCovered`, `mutantsKilled`, `mutantsTried`, and `assertions`, the matcher names the test uses |

`mutation.score` is the number to track over time. Coverage says how much of the
code the suite runs; the mutation score says how much of it the suite actually
checks.

Exit codes are the usual ones: `0` when at least one test was accepted, `2` when
none was, `1` for a config error or a ceiling that is not a whole number, `130`
when a signal stopped the sweep.

### The base a run is proved on

A test is only proven against the commit it ran on, so an unattended run does two
things about that commit.

Before the run, each checkout is fast-forwarded to its default branch
(`refresh_base: true`). This is only ever a fast-forward. A checkout with
uncommitted changes, or on a branch holding commits that are not on the default
branch, is left exactly where it is and the report says why. Nothing here
discards a commit, and nothing here is fatal: a checkout that cannot be
refreshed is used as it is.

At PR time, the branch is cut from that same commit rather than from the default
branch re-resolved hours later. Two things go wrong when it is not. The branch
carries tests that were never run against their own base, and a checkout holding
modified files cannot be moved to the newer commit at all, which is how a night
of accepted tests once ended with no PR. When the default branch moved during the
run, the PR body says so: "Base moved by N commits during the run." The PR merges
as it is; nothing is rebased. When the branch still cannot be cut from that
commit, it is cut from HEAD instead and the body says that too, because a PR with
a note on it beats proven tests left on disk.

The report carries both per repo: `repos[].baseSha` is the commit the run was
proved on, `repos[].baseRefresh` is what happened to the checkout before it.

### Not generating for a file twice

Covergen reads coverage, and an unmerged PR does not change coverage. Two
consecutive nights will otherwise pick the same uncovered file, spend the same
tokens on it, and open a second PR that collides with the first.

So with `--pr`, every open PR on a `covergen/` branch is read before targeting
and the files those PRs write are taken off the list. A repo whose matched
sources are all covered that way is skipped for the night with reason
`open_pr_backlog`, and the run summary names the count. Merge or close the
backlog and the next run picks the files up again. `gh` answering with anything
else excludes nothing, which is the behavior from before this existed.

### Killing a run

A long sweep often outlives the patience of whatever launched it. SIGINT and
SIGTERM are handled rather than fatal:

- every test already accepted stays in its spec file, because each one is written
  as it is accepted rather than in a batch at the end, and cleanup never takes an
  accepted test back;
- the candidate at the gate when the signal landed is rolled back, along with any
  mutant the spot-check had written into a source file;
- the run stops starting new work, writes `last-run.md`, the JSON report and its
  journal, and exits `130`. With `--pr` it still opens the draft PR for what it
  accepted; `sweep --all` stops rather than starting the next repo.

That leaves a dirty checkout of tests that each passed the gate, and
`.covergen/runs/<id>.json` naming exactly which files those are. They were proven
one at a time but never together, so review them before committing. A second
signal is taken literally and kills the process at once.

A crash leaves the same thing behind, for the same reason: an unexpected error
mid-run does not un-accept the tests already written, so the journal is closed
as `status: aborted` with the error as its reason rather than left reading
`running`.

A signal or a crash is the only thing that leaves written tests behind. A run
that reaches the end and finds that its accepted specs pass alone but fail
together rolls back every spec it wrote, leaving the checkout as it found it. It
exits non-zero, records nothing as accepted, and writes the reason into
`last-run.md` under "Reverted" and into the journal as `status: reverted`.

### Opening the PR a killed run never opened

```
covergen pr --from .covergen/runs/<id>.json
```

Reads the journal, looks its repo up in covergen.yaml, and opens the draft PR
for exactly the specs it names. Nothing is regenerated and no gate is re-run:
those tests already passed one, and the point of this command is not paying for
them twice.

It refuses rather than guesses. A spec the journal names that is gone, or whose
contents no longer hash to what the run recorded, stops the command with that
file named, because a PR built on an edited spec would claim a gate result the
code in it never earned. Put the file back, or run covergen again.

A journal that was never closed, which is what a run killed before crashes were
journalled leaves, is warned about rather than refused: the other thing it can
mean is a covergen run still using that checkout.

The branch is cut from the journal's `baseSha`, the commit those tests were
proven on, and the PR splits into parts under `sweep.pr_max_lines` the way a
sweep's does. The run never reached the step that proves the accepted specs pass
together, so the body says so and asks for one suite run before merging.

### A cron line

```cron
0 2 * * * cd /path/to/covergen && /usr/local/bin/covergen sweep --all --pr --limit 5 --max-minutes 240 --report .covergen/logs/sweep-$(date +\%Y\%m\%d).json >> .covergen/logs/sweep.log 2>&1
```

Whole-suite baselines need each repo's database and toolchain, so this is a
local job on the machine that can run those suites, not a cloud routine. Percent
signs are escaped because cron eats them.

## Scheduled local runs

Whole-suite baselines need the repos' databases and toolchains, so the headless
mode is a local job, not a cloud routine.

```
scripts/nightly-sweep.sh [repo ...]     # every repo in covergen.yaml by default
COVERGEN_LIMIT=10 COVERGEN_DRY_RUN=1 scripts/nightly-sweep.sh rails-api
```

For each repo with a clean working tree it checks out `covergen/nightly/<date>`,
runs `sweep`, commits the accepted tests with the report as the commit message,
and switches back to the branch it started on. Repos with a dirty tree are
skipped. When nothing is accepted or the run fails, the branch is deleted. It
never pushes and never opens a PR. Reports and logs land in `.covergen/logs/`.
`COVERGEN_BRANCH_PREFIX` changes the branch prefix.
`scripts/com.covergen.nightly.plist` is a launchd template for 02:30 daily; edit
the two paths before installing it.

What to do with the branch it leaves:

1. Read `.covergen/logs/<date>-<repo>.md`, which is also the commit message.
   Check the accepted table, then read the tests themselves.
2. Push the branch by hand once you are satisfied. The job does not push.
3. Open the PR by hand. This script never opens one; `sweep --all --pr` is the
   path that does.

## What covergen optimizes for

Coverage is the instrument, not the goal. The goal is a suite that fails when the
code breaks, so covergen would rather add five tests that catch planted bugs
than fifty that pad a percentage. That principle decides what it aims at. Targets are ranked
by `--order value`:

```
score = sqrt(uncovered) * branchWeight * churnWeight * importWeight
```

`branchWeight` is the branch density of the uncovered text, `churnWeight` counts
commits in the last 180 days, `importWeight` counts the files importing this one.
Size sits under a square root, so it separates comparable files instead of
deciding the ranking: a small dense module outranks a large moderately branchy
one, and a flat schema or constant table scores near zero however red it is,
because a test over it executes lines and asserts nothing anyone would miss.
Segment selection inside a file weights by branch density the same way, and the
mutation spot-check enforces the principle at the other end. `covergen baseline
--repo <name> --top 20` prints the ranking with its components, so the file at
the top can be argued with, and `--order gap` is still there when the biggest
hole really is the point. Reasoning: decision 19 in
[docs/DECISIONS.md](docs/DECISIONS.md).

## What gets accepted

A candidate test is kept only if it builds, passes `gate.k` times in a row,
covers at least one line that was uncovered before, loses none, passes every
`validate` command, and catches both `mutation.min_killed` planted bugs and
`mutation.min_killed_ratio` of the ones tried when the spot-check produced any. Rules in `src/rules.ts` reject sleeps, real network,
real clocks, skipped tests, tautologies, snapshot-only tests, and tests with no
assertion at all, before the gate runs. Failures get up to `max_repair_rounds`
chat-continuation repairs, then the candidate is frozen and never regenerated.
Each accepted test raises the bar for the next one in the same run, so two tests
for the same lines cannot both land.

Coverage gain is measured against the whole suite. Coverage loss is measured
against a run of the same spec file alone, taken before the splice, because the
gate runs one spec file at a time and lines other specs cover would otherwise
look lost.

## Troubleshooting

**`rspec preflight failed in <cwd>: bundle exec rspec --version exited N`**
The bundle is not installed or not reachable. Run `bundle install` in the target
repo, or set `command_prefix` if the suite runs inside a container or needs a
pinned Ruby (`["rbenv","exec"]`).

**`rspec preflight failed: no Gemfile.lock at <paths>`**
Run `bundle install` in the target repo.

**`rspec preflight failed: simplecov-lcov is not in <lockfile>`**
Run `bundle add simplecov-lcov --group test`, then paste the spec_helper snippet
preflight prints into `spec/spec_helper.rb` or `rails_helper.rb`, at the very
top, before any app code is required.

**`vitest preflight failed: no coverage provider installed for <repo>`**
Run `npm i -D @vitest/coverage-v8` (or install
`@vitest/coverage-istanbul`) in the repo cwd or root. Pin the provider to the
same major as the repo's vitest, or vitest warns about mixed versions.

**`bun preflight failed in <cwd>: bun --version exited N`**
Install bun, or set `command_prefix` if the suite runs inside a container.

**`jest preflight failed: jest is not installed for <repo>`**
Run `npm i -D jest`. The message lists both paths that were checked.

**`baseline run produced no lcov for <repo> (exit N)`**
The suite ran but wrote no lcov file. The message is followed by the last 40
lines of the runner's output, which is usually enough to see why. The `baseline`
command reports the same condition as `no lcov produced for <repo>` with the last
30 lines. Common causes: the coverage reporter is not wired up (re-run
`preflight`), or the suite died before writing coverage.

**A suite that calls the real API when a key is present**
Some suites hit the real Anthropic API when they see a key in the
environment, which times them out and produces no lcov. covergen keeps the key
out of `process.env` for exactly this reason. If you see this, check that the key
is not exported in your shell or the repo's own `.env`.

**Jest paths with parentheses**
Jest treats positional arguments as regexes, so a path like
`src/app/(app)/x.test.tsx` matches nothing. covergen passes files with
`--runTestsByPath`. If you invoke Jest yourself while debugging, do the same.

**`model reply truncated at max_tokens=<n>`**
The candidate was cut off mid-file. Raise `anthropic.max_tokens` in
covergen.yaml. The default is 16384; a smaller value silently truncated component
tests before this was made a loud error.

## Results so far

Dry runs on 2026-09-02 against six private repos, one target stack per runner,
one to four target files each, across all four runners that existed then. Seven
ship today; the three added since are covered by fixtures rather than by a dry run
against a real repository, which `docs/SUPPORT.md` records row by row. Repo names
are generic here; the stack and the measured coverage change are the parts that
matter:

| Repo | Runner | Example | File coverage |
|---|---|---|---|
| react-app | bun test | a payment-availability helper, one typecheck repair round | 50.0% to 93.8% |
| rails-api | RSpec | a service object's API client method | 94.4% to 100% |
| rails-monolith | RSpec | an order state-change service | 91.7% to 100% |
| next-app | Vitest | a prompt-building module, four accepted candidates | 87.0% to 97.4% |
| node-api | Vitest | an admin list component, new spec file | 17.2% to 100% |
| mobile-app | Jest | a map screen | 0% to 100% |

Every accepted test was re-run by hand and passed its repo's typecheck and lint.

### Demo batch, a real run

`covergen sweep --repo rails-api --limit 10` on 2026-09-03: 10 files targeted, 5
candidates generated, 5 accepted, 556 s including a cached whole-suite baseline.
The tests were written, uncommitted, into a scratch worktree of the target repo.

| Spec | Coverage of the source file |
|---|---|
| a model spec (new) | 75.0% to 100% |
| a model concern spec (new) | 78.3% to 100% |
| a second model concern spec (new) | 73.7% to 100% |
| a service spec (extended) | 94.4% to 100% |

Two Layout/IndentationConsistency offenses were autocorrected by hand
afterwards. The rubocop `validate` step added the same day catches these before
acceptance.

## Development

```bash
npm run dev -- run --repo rails-api --file app/services/foo.rb   # tsx src/cli.ts
npm test           # vitest run
npm run test:watch # vitest
npm run typecheck  # tsc --noEmit plus the test tsconfig
npm run build      # tsc into dist/
npm start -- --help
```

TypeScript, Node 22, ESM with NodeNext, so relative imports end in `.js`.
commander for the CLI, Zod plus YAML for config, pino for logging, Vitest for
tests, `@anthropic-ai/sdk` for generation. There is no database; per-repo state
lives in `<repo>/.covergen/`.

Tests are `*.test.ts` beside the source file they cover, 33 of them today.
`src/types.ts` is the contract between pipeline stages: change it deliberately
and update every consumer. Other conventions from `CLAUDE.md`:

- Lean. No abstractions for hypothetical futures.
- Never run a model in CI.
- Never open a PR without an explicit go-ahead. `sweep --pr` and `pr --from` are
  the only two, and the only paths that push; every other run leaves the work in
  the checkout.
- The Anthropic key never enters `process.env`.
- Runners shell out with `execFile`, honor `commandPrefix`, and always write lcov
  to a path they return.
- No em dashes in any written output.
