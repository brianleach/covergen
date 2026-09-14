# Bun test idioms

How tests are written for a TypeScript or React project whose suite runs on
`bun test`. Follow this exactly.

> The runner is Bun's own test runner, not Vitest. Import from `bun:test`. Never
> write `import { ... } from "vitest"` and never call `vi.*`, even in a project
> that also keeps a Vitest config around for browser or Storybook tests.

## Shape

- `describe` plus `it`, one behavior each. Nest a second `describe` to group
  rendering, interaction and failure cases when a file covers several.
- Everything the test API needs comes from `bun:test`: `describe`, `it`, `expect`,
  `mock`, `beforeEach`, `afterEach`.
- Put the file where the project already puts tests. Some suites colocate
  `Thing.test.tsx` beside `Thing.tsx`, others centralize under a `__tests__`
  directory that mirrors the source tree. Match the file you are extending, or the
  nearest existing test, and never introduce a second layout.

```typescript
import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";

import { RefundNotice } from "./refund-notice";

describe("RefundNotice", () => {
  describe("rendering", () => {
    it("renders the fee for an order over the threshold", () => {
      // arrange, act, assert
    });
  });
});
```

## Mocking

- A module mock is `mock.module("<specifier>", () => ({ ... }))`, declared at the
  top of the file before the code under test runs. A function mock is
  `mock(() => ...)`.
- Keep a named reference to every function mock so you can assert on it and clear
  it: `.mockClear()` or `.mockReset()` in `beforeEach`, and `mock.restore()` in
  `afterEach` so the mock does not survive into the next file.
- `mock.module` is process wide. When files share a process, two files that mock
  the same specifier differently interfere with each other, so a test that passes
  alone and fails in the suite is almost always a leaked module mock. Restore in
  `afterEach` first, then run the one file on its own to confirm.
- Mock the module that exports the data hooks rather than standing up a real query
  client. Reach for a real provider only when the query behavior itself is the
  thing under test.
- Do not add a dependency to `package.json`. Use what the project already has.

## Rendering components

- `render` from `@testing-library/react`. When the project ships a helper that
  wraps its provider tree (router, query client, feature flags), use that helper: a
  component that reads context throws without it. Do not assemble the providers by
  hand when a helper exists.
- Interactions go through `fireEvent`. Do not use `@testing-library/user-event`
  unless the existing tests already do, and never mix the two in one file.
- Query in this order: `getByRole`, `getByLabelText`, `getByText`, and
  `getByTestId` only as a last resort for content with no accessible name.
- Content that appears after an effect or a mutation is asserted with
  `await screen.findBy*` or inside `await waitFor(...)`, never with a bare `getBy*`
  immediately after the event that triggered it.

## Hooks and stores

- Test a hook by mounting it in a small harness component that exposes the return
  value, through a ref or by rendering the values as text, then assert on what the
  hook returned. A hook cannot be called outside a component.

```typescript
import { createRef, forwardRef, useImperativeHandle } from "react";
import { render } from "@testing-library/react";

import { useRefundQuote } from "./use-refund-quote";

const Harness = forwardRef((_props, ref) => {
  const api = useRefundQuote(2000);
  useImperativeHandle(ref, () => api, [api]);
  return null;
});
```

- Reset a store between tests by calling the store's own reset or clear action in
  `beforeEach`. Do not push a hand-built initial state through `setState`: it
  drifts from the real initial state as soon as a field is added.

## Assert on behavior

- Compare against the value written out in the test: `expect(feeFor(2000)).toBe(25)`.
- Assert what the user or the caller sees: rendered text, the returned value, the
  arguments a side effect was called with. Never a private field.
- `toBeDefined`, `toBeTruthy` or a snapshot as the only assertion proves nothing,
  and covergen rejects a candidate that never calls the code with an input.
- An expected rejection is `await expect(fn()).rejects.toThrow("...")`, with the
  message or error matched, so an unrelated failure of the same shape cannot pass.

## No real world

- No network. Mock the client module. No real clock: inject or freeze it, never
  assert against `Date.now()`. No unseeded randomness, no sleeps to order anything.
- Nothing is written into the repository. Use a temporary directory the runner
  cleans up, or test the pure function instead of the file path.

## Form

- No `it.skip`, no `it.only`, no commented-out assertions, no test that only
  imports the module or constructs a value.
- Run the file before you hand it back and iterate until it passes. A failure
  caused by the test (a wrong `mock.module` shape, a bad import path, the wrong
  query, a missing `mock.restore()`) is yours to fix. A failure that exposes a real
  bug in the source stays: report it instead of weakening the assertion.
