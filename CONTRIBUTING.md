# Contributing

Thanks for looking. covergen is small on purpose: a CLI, one runner adapter per
test runner, one idiom pack per ecosystem.

## Gates

Everything that runs in CI runs locally:

```bash
npm ci
npm run typecheck   # tsc --noEmit plus the test tsconfig
npm test            # vitest run
npm run build       # tsc into dist/
```

Those three must be green before a pull request is ready. CI runs them on Node 22
and also installs Bun, Python, Go and the Rust coverage tooling so the fixture
tests under `fixtures/` run for real instead of skipping. A fixture whose
toolchain is missing on your machine skips rather than fails, so a green local
suite can still be narrower than CI.

No model is ever called in CI, and no test in this repository calls one.

## Adding a runner

The full checklist is in the README under "Adding a runner". In short: add the
name to `RunnerName` in `src/types.ts` and `runnerNames` in `src/config.ts`,
implement the `Runner` interface in `src/runners/<name>.ts`, register it in
`src/runners/index.ts`, add `src/runners/<name>.test.ts` using the injectable
`ExecFn` the other runner tests take, and add a minimal fixture project under
`fixtures/` with one covered function and one uncovered one so `src/fixtures.test.ts`
can drive the real runner over it.

A runner shells out with `execFile` through `runCommand`, never a shell string. It
honors `commandPrefix`, writes lcov to a path it returns, and its `preflight` says
what is missing and gives the exact command that fixes it.

## Adding an idiom pack

Idiom packs live in `idioms/<runner>.md` and are loaded verbatim into the prompt.
Write them in the second person, addressed to whoever is writing the test, and keep
them generic: a pack describes an ecosystem's conventions, not one codebase. Read
`idioms/go.md`, `idioms/pytest.md` or `idioms/rust.md` first for the voice and the
length. Every rule should be one a generated test can actually be judged against:
shape, mocking, what to assert, what not to do.

## Leak check

This repository is public. `scripts/leak-check.sh` greps the tracked files, the
commit messages a branch adds, and a pull request's title and body against a
list of names that must not appear here, and fails on any hit. The list is a
regex the maintainers keep outside the repository, in `$LEAK_PATTERNS` or in
`$LEAK_PATTERNS_FILE` (default `$HOME/.config/covergen/leak-patterns`), so the
repository never carries it. CI reads it from a repository secret.

Nothing is required of you as an outside contributor: a fork has no secret, so
the check finds no pattern, prints that it is skipping, and passes. Maintainers
install the pre-push hook once:

```bash
npm run hooks:install   # git config core.hooksPath .githooks
```

The hook then runs the check against `origin/main` before every push. Run it by
hand at any time with `npm run leak-check`.

## Pull requests

- One reviewable change per pull request. Split anything larger.
- Say what you verified and paste the gate output.
- Generated tests are committed and reviewed like any other code. A test that
  only asserts `toBeDefined`, or that never calls the code with an input, is not
  worth merging.
- No em dashes anywhere: in code, comments, docs, commit messages or pull request
  bodies. Use a colon, a comma or a second sentence.
- Never commit `.env`, `covergen.yaml`, or anything containing a key. Both are
  gitignored; keep it that way. Name environment variables, never their values.
