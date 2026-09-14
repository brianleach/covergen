# covergen: repo guide for Claude Code

Coverage-gated LLM test generation CLI in TypeScript. Points at a sibling repo,
finds uncovered code, asks Claude for candidate tests, and keeps only the ones
that build, pass k times in a row, and strictly raise line coverage. Modeled on
Uber AutoCover, Meta TestGen-LLM, and CoverUp; design notes in
`docs/DESIGN.md`, decisions in `docs/DECISIONS.md`, source dossier in `docs/research/`.

## Stack

- TypeScript, Node 22, ESM (`"type": "module"`, NodeNext, so relative imports end in `.js`).
- commander for the CLI, Zod + YAML config, pino logging, Vitest for tests.
- `@anthropic-ai/sdk` for generation. No database; per-repo state in `<repo>/.covergen/`.

## Pipeline (data flow)

```
cli: covergen run --repo X --file path   |   covergen sweep --repo X --changed-since REF
  -> config.ts      load covergen.yaml, resolve RepoConfig
  -> runners/*.ts   preflight, baseline run with coverage -> lcov.info
  -> lcov.ts        parse lcov -> CoverageMap; diff two maps -> CoverageDelta
  -> segments.ts    uncovered lines -> Segment[] (<= max_lines, enclosing symbol)
  -> prompt.ts      PromptBlocks: stable (idiom pack + rules) / semiStable (file + nearest spec) / volatile (segment)
  -> generate.ts    Claude call per segment -> Candidate[], sha256 dedup
  -> gate.ts        splice candidate into the real spec (restored in finally), run k times, diff coverage,
                    run repo.validate commands, then mutate the newly covered source lines and re-run
                    -> GateResult. Gain vs suite baseline, loss vs spec-alone baseline
  -> repair.ts      on failure continue the chat with the error, max_repair_rounds
  -> emit.ts        combine accepted tests, verify the final specs together, write them, PR body markdown
```

`src/types.ts` is the contract between stages. Change it deliberately and update every consumer.

## File map

| File | Responsibility |
| --- | --- |
| `src/types.ts` | Canonical shapes: RepoConfig, CoverageMap, Segment, Candidate, Runner, GateResult |
| `src/config.ts` | Zod schema, YAML load, spec path templates |
| `src/lcov.ts` | lcov.info parse, merge, diff |
| `src/segments.ts` | Cluster uncovered lines into prompt-sized segments |
| `src/runners/index.ts` | `getRunner(name)` |
| `src/runners/{rspec,vitest,bun,jest,pytest,go,cargo}.ts` | One `Runner` per test runner, all emit lcov (the go runner converts Go's block profile itself, and the cargo runner drives cargo-llvm-cov and strips `#[cfg(test)]` lines out of the result) |
| `src/prompt.ts` | Prompt block assembly, idiom pack loader, rules list |
| `src/generate.ts` | Anthropic calls with prompt caching, candidate parsing, dedup |
| `src/gate.ts` | Scratch splice, pass^k, coverage delta, mutation spot-check, verdict |
| `src/mutate.ts` | Bounded single-line source mutants for the spot-check |
| `src/repair.ts` | Chat-continuation repair loop |
| `src/emit.ts` | Write accepted tests, revert on failure, PR body |
| `src/pipeline.ts` | Orchestrates one run end to end, writes RunSummary |
| `src/cli.ts` | commander entrypoint |
| `idioms/*.md` | Per-runner idiom packs, loaded verbatim into the stable prompt block |

## Conventions

- Lean. No abstractions for hypothetical futures. Tests are `*.test.ts` beside source.
- Never run a model in CI. Generated tests are committed and reviewed like any code.
- Never open a PR without an explicit go-ahead. `sweep --pr` is that go-ahead and the only path that pushes or opens one; every other run leaves the work in the checkout.
- The Anthropic key never enters process.env. It goes from .env to the client via PipelineArgs.apiKey.
- Acceptance is per test case: passes k times AND newlyCovered.length > 0 AND lost.length === 0 AND every repo.validate command exits 0 AND, when the mutation spot-check is enabled and produced mutants, at least min_killed of them made the test fail.
- Repaired candidates pass the same rules registry as initial candidates. Final combined spec files pass k times and validate before the run succeeds.
- Runners shell out with `execFile` (no shell string interpolation), honor `commandPrefix`, and always write lcov to a path they return.
- No em dashes in any written output.
- This repo is public. Never reference other repositories, companies, or products by name in code, docs, examples, tests, commit messages, or PR text. `scripts/leak-check.sh` enforces a private list; run it before pushing.

## Commands

```bash
npm run dev -- run --repo rails-api --file app/services/foo.rb
npm test
npm run typecheck
npm run build && npm start -- --help
```
