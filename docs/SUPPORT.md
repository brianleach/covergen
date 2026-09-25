# covergen support matrix

What covergen can be pointed at today, with the evidence behind each row. Every
claim here is backed either by a committed fixture under `fixtures/`, which
`npm test` runs, or by a read-only dry run against a real repository, described
by shape rather than by name.

Audited 2026-09-09. The runner matrix below was re-checked against
`src/runners/` on 2026-09-14, against the seven shipped runners. The
real-repository rows further down still date from the 2026-09-09 audit.

## What a repo has to provide

covergen never instruments anything itself. It runs the repo's own test runner
and reads the lcov the runner writes, so the repo has to be able to produce
lcov before covergen is useful:

| Runner | What the repo must have | Who installs it |
| --- | --- | --- |
| vitest | `@vitest/coverage-v8` or `@vitest/coverage-istanbul` in `node_modules`, under the package or the workspace root | the repo |
| bun | nothing; `bun test --coverage-reporter=lcov` is built in | nobody |
| jest | nothing beyond jest itself; lcov is a built-in reporter | nobody |
| rspec | `simplecov` and `simplecov-lcov` in the bundle, plus the `spec_helper` opt-in that `covergen preflight` prints | the repo |
| pytest | `pytest-cov`, which writes lcov natively. No opt-in in the repo's own test setup | the repo |
| go | nothing; `go test -coverprofile` is built in and covergen converts the block profile itself | nobody |
| node-test | `tsx`; Node 22 writes lcov with its built-in reporter | the repo |
| cargo | `cargo-llvm-cov`, plus the LLVM tools it drives: the `llvm-tools-preview` rustup component, or `LLVM_COV` and `LLVM_PROFDATA` pointing at a system llvm | the machine, not the repo |

`covergen preflight --repo <name>` answers this question in under a second and
is the first thing to run against any new repo.

## Runner matrix

| Runner | Language | Monorepo | Verified by | Status | Known gap |
| --- | --- | --- | --- | --- | --- |
| vitest | TypeScript, ESM | yes | `fixtures/vitest-esm-lib`, plus dry runs on a Vitest monorepo whose workspace root carries the coverage provider | works | component targets need a DOM environment, see below |
| jest | JavaScript, CommonJS | not exercised | `fixtures/jest-cjs` | works | fixture is plain CJS with no babel config; a repo with a transform pipeline is unproven here |
| bun | TypeScript, ESM | not exercised | `fixtures/bun-lib` | works | no whole-project baseline: `bun test` reports only files a test loaded, so a source file with no test at all is missing from the map rather than reported at 0% |
| rspec | Ruby | not exercised | `fixtures/rspec-min`, skipped on any machine without bundler and an installed bundle | unproven in this environment | needs the `spec_helper` opt-in; the snippet preflight prints uses SimpleCov's `rails` profile, which a plain Ruby library must adapt |
| pytest | Python | not exercised | `fixtures/pytest-min`, skipped wherever the configured interpreter has no pytest-cov | works | coverage cannot be narrowed to one file, so a gate run measures the whole `--cov` package; no real repository tried yet |
| go | Go | not exercised | `fixtures/go-min`, skipped wherever `go version` does not answer | works | coverage is statements-based, projected onto lines; tests are selected by package rather than by file, so a gate run measures the target's whole package; no real repository tried yet |
| node-test | TypeScript on node:test via tsx | not exercised | `fixtures/node-test-min`, skipped on Node older than 22 | works | no whole-project baseline: Node reports only files a test loaded; coverage include flags need Node 22.5.0, older Node 22 filters the lcov instead |
| cargo | Rust | workspaces, by `cargo metadata` | `fixtures/rust-min`, skipped wherever cargo-llvm-cov or the LLVM tools are absent | works | tests live in the source file, so the runner strips `#[cfg(test)]` lines out of the lcov to keep the gate honest; tests are selected by crate rather than by file; no real workspace tried yet |

`fixtures/covergen.fixtures.yaml` is the config those fixtures run under. Each
fixture is one covered function and one deliberately uncovered one, and
`src/fixtures.test.ts` drives the real runner over it: preflight, a whole
project coverage run, lcov parsing, and segment extraction. A fixture whose
toolchain is absent is skipped rather than failed, so the suite stays green on a
machine without, say, Ruby.

## Verified on real repositories

Read-only dry runs, no writes to any target. Repositories are described by shape.

| Shape | Result |
| --- | --- |
| Vitest monorepo, coverage provider at the workspace root, `environment: node` | preflight OK; whole-project baseline parsed 38 files and 545 lines; a target produced 6 segments and a resolved spec path; the run stops at generation without an Anthropic key |
| Vitest monorepo web package, no coverage provider installed anywhere | preflight fails with the install hint. Nothing else runs |
| Vitest single package with a vendored submodule, no coverage provider | preflight fails with the install hint |
| Vitest single package app, no coverage provider | preflight fails with the install hint |
| Repo with no tests at all | preflight fails with the same "no coverage provider" message. Accurate but misleading: the repo has no test runner either, and preflight does not say so |
| Repo whose suite runs on `node:test` through `tsx` | not configurable: `runner` accepts only the seven names above, and the config error is a raw schema dump |

The pattern is worth stating plainly: for Vitest repos, the coverage provider is
the gate. Four of the five repositories tried were one `npm i -D
@vitest/coverage-v8` away from working, and none of them failed for any deeper
reason.

## Component tests need a DOM environment

A Vitest package that runs `environment: "node"` with neither `jsdom` nor
`happy-dom` installed cannot execute a component test, however good the
generated test is. Nothing used to detect that, and component targets picked in
that state spent a full generation plus every repair round before being
rejected.

`covergen preflight` now prints a `WARN` line when a package's source globs
match `.tsx` or `.jsx` while the environment is node and no DOM environment is
installed, and the pipeline logs the same warning at the start of a run. The fix
is either to install a DOM environment or to narrow the targets:

```yaml
repos:
  - name: web
    runner: vitest
    sources: ["src/**/*.ts", "src/**/*.tsx"]
    exclude: ["**/*.tsx"]      # subtracted from sources, wins over them
```

`exclude` is honored by sweep target discovery and by `--changed-since`
filtering. An explicitly named `run --file` is still respected: naming a file is
a deliberate act.

## Cost

Runs report dollars as well as tokens. Prices are dollars per million tokens and
default to the list prices for the models covergen ships with, with cache reads
at 0.1x input and cache writes at 1.25x input. Override any of them, or add a
model that has no default, in `covergen.yaml`:

```yaml
price_per_mtok:
  claude-opus-5:
    input: 5
    output: 25
    cache_read: 0.5
    cache_write: 6.25
```

A model with no price entry is reported as `unpriced` and the run total is
marked as a floor rather than silently under-reported.

## Target selection

`covergen sweep` orders candidate files by uncovered lines, most first, before
applying `--limit`. Glob order is alphabetical, which is arbitrary with respect
to value: a limited sweep can spend itself inside one directory while the
largest holes in the repo are never considered. `--order glob` restores the old
behavior. The ordering uses the same whole-suite baseline the run itself needs,
and that baseline is cached by tree state, so it costs nothing extra.

## Not supported

A coverage-to-lcov path exists for every language below. The gap is never the
coverage data; it is the runner adapter (a `Runner` in `src/runners/`, about
100 lines) plus an idiom pack in `idioms/` so generated tests match the
ecosystem's conventions.

| Language or runner | lcov path that already exists | What is missing |
| --- | --- | --- |
| Java, Kotlin (JUnit) | JaCoCo XML plus a converter | runner adapter, JUnit idiom pack, build-tool detection for Maven and Gradle |
| C#, .NET | coverlet emits lcov natively | runner adapter, xUnit or NUnit idiom pack |
| PHP (PHPUnit) | Clover XML plus a converter | runner adapter, PHPUnit idiom pack |
| Elixir (ExUnit) | `excoveralls` lcov reporter | runner adapter, idiom pack |
| `node:test` | `c8` or `node --experimental-test-coverage` with an lcov reporter | runner adapter, idiom pack |
| End-to-end runners (Playwright, Cypress) | instrumented builds can emit lcov | out of scope by design: the gate reruns one spec file many times, which an end-to-end suite cannot absorb |

There is no generic `exec` runner. Adding one is the cheapest way to widen the
matrix, because most of the rows above differ only in the argv and the path the
lcov lands at.

## Reproducing this

```bash
npm ci
npm test                                    # includes every available fixture
npx tsx src/cli.ts --config fixtures/covergen.fixtures.yaml preflight --repo vitest-esm-lib
npx tsx src/cli.ts --config fixtures/covergen.fixtures.yaml baseline --repo vitest-esm-lib
```

`preflight` and `baseline` need no Anthropic key. `run` and `sweep` reach
generation and stop there without one, after paying for the baseline, so use
them with `--dry-run` only when a key is configured.
