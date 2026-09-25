# fixtures

One tiny repository per runner covergen claims to support. Each has exactly one
covered function and one deliberately uncovered one, so a coverage run has a
known right answer. The two `audit-*` fixtures are the exception: their point is
the tests rather than the sources, so `covergen audit` has a known right answer
too. There is no network access and no install step: every
fixture resolves its runner from this checkout's own `node_modules`, which is
why `covergen.fixtures.yaml` gives each of them `root: ..` and a `cwd` inside
`fixtures/`.

`src/fixtures.test.ts` drives them as part of `npm test`: preflight, a whole
project coverage run, lcov parsing, and segment extraction, stopping one step
short of generation so no fixture ever needs an Anthropic key. A fixture whose
toolchain is not installed is skipped rather than failed.

| Fixture | Runner | Needs |
| --- | --- | --- |
| `vitest-esm-lib` | vitest | `@vitest/coverage-v8` from this repo |
| `bun-lib` | bun | `bun` on PATH |
| `jest-cjs` | jest | `jest` from this repo |
| `rspec-min` | rspec | `bundle install` inside the fixture (rspec, simplecov, simplecov-lcov) |
| `pytest-min` | pytest | `pytest` and `pytest-cov` importable by the interpreter in its `pytest.command` |
| `go-min` | go | `go` on PATH (1.22 or newer), which brings `gofmt` with it |
| `node-test-min` | node-test | Node 22 or newer; `tsx` from this repo |
| `audit-vitest` | vitest | `@vitest/coverage-v8` from this repo. Deliberately bad tests: one case of every shape `covergen audit` has a verdict for |
| `audit-go` | go | `go` on PATH. One `TestXxx` that calls the code and asserts nothing |
| `rust-min` | cargo | `cargo llvm-cov` on PATH, plus the LLVM tools: `rustup component add llvm-tools-preview`, or `LLVM_COV` and `LLVM_PROFDATA` pointing at the system binaries |

Run one by hand:

```bash
npx tsx src/cli.ts --config fixtures/covergen.fixtures.yaml preflight --repo vitest-esm-lib
npx tsx src/cli.ts --config fixtures/covergen.fixtures.yaml baseline --repo vitest-esm-lib
```

The results these produce are the evidence behind `docs/SUPPORT.md`.
