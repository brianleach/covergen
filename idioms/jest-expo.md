# Jest and React Native idioms

How tests are written for a React Native or Expo app on Jest with React Native
Testing Library. Follow this exactly.

## Shape

- `describe` plus `test`, one behavior each, in a `.test.tsx` colocated with the
  component or screen it covers.
- Never put a test file inside the Expo Router route directory (usually `app/` or
  `src/app/`). The router bundles everything under it, so a test file there breaks
  the bundler. Screens are tested from the feature or component directory they are
  implemented in.
- Import through the project's path alias when it has one (`@/...`), matching the
  nearest existing test. When the project exports a shared render helper, import
  `render`, `screen`, `fireEvent`, `waitFor` and `cleanup` from that helper rather
  than from `@testing-library/react-native` directly: the helper is what wraps the
  providers a screen needs.
- Call `afterEach(cleanup)` explicitly unless you can see that the setup file
  already registers it. Leftover trees make the next test's queries ambiguous.

```typescript
import { cleanup, fireEvent, render, screen, waitFor } from "@/lib/test-utils";

import { LoginForm } from "./login-form";

afterEach(cleanup);

describe("LoginForm", () => {
  test("disables submit while the request is pending", async () => {
    // arrange, act, assert
  });
});
```

## Interactions

- Use `fireEvent`, never `userEvent`. On React Native, `userEvent` needs fake
  timers and hangs a suite that does not have them.
  - `fireEvent.press(element)` for a tap
  - `fireEvent.changeText(input, "text")` for text entry
  - `fireEvent(element, "blur")` for any other event by name
- Anything that appears after an effect, a query resolving, or a mutation is
  asserted with `await screen.findBy*` or inside `await waitFor(...)`. A bare
  `getBy*` right after the event is a flake.

## Queries

Prefer `getByRole`, then `getByLabelText`, then `getByText`, then `getByTestId`.
`getByTestId` is not a last resort here the way it is on the web: text matchers on
React Native collide with case transforms and with the accessibility labels a
composed pressable produces, and an end-to-end suite may already target the same
element by test ID. Use the test ID that is already on the element.

## Mocking the runtime

- Mock the router module and keep named references to the functions you assert on:

```typescript
const mockPush = jest.fn();
jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush }),
  useLocalSearchParams: () => ({ id: "123" }),
}));

beforeEach(() => mockPush.mockClear());
```

- Read the Jest setup file before mocking anything global. Native storage, gesture
  handlers, reanimated and the like are usually mocked there once for the whole
  suite; re-mocking one in a test file replaces the working mock with a worse one.
  When a test needs specific return values, spy on the already mocked module
  instead.
- Mock the feature's own data module (the file that exports its query and mutation
  hooks) so a screen renders deterministically without a query client:

```typescript
const mockUpdate = jest.fn();
jest.mock("./api", () => ({
  useProfile: () => ({ data: { name: "Jane Doe" }, isLoading: false }),
  useUpdateProfile: () => ({ mutate: mockUpdate, isPending: false }),
}));
```

- When the hook itself is the thing under test and a real client is unavoidable,
  mock the query library partially so the rest of it stays intact:

```typescript
jest.mock("@tanstack/react-query", () => {
  const actual = jest.requireActual("@tanstack/react-query");
  return {
    ...actual,
    useQuery: (opts: any) => ({ data: fixtures[opts.queryKey[1]], isLoading: false, error: null }),
    useQueryClient: () => ({ invalidateQueries: jest.fn() }),
  };
});
```

- Do not invent a provider wrapper the app does not have, and do not add a
  dependency. Use what the project already ships.

## Forms

A validating form is covered by driving it the way a user would and asserting on
the message, not on internal form state:

```typescript
test("shows a format error for an invalid email", async () => {
  render(<LoginForm />);

  fireEvent.changeText(screen.getByTestId("email-input"), "yyyyy");
  fireEvent(screen.getByTestId("email-input"), "blur");
  fireEvent.press(screen.getByTestId("login-button"));

  expect(await screen.findByText(/invalid email/i)).toBeOnTheScreen();
});
```

## Stores

Reset a global store between tests by calling its own reset action in `afterEach`,
not by writing a hand-built initial state through `setState`:

```typescript
afterEach(() => useCheckoutStore.getState().reset());

test("records an answer", () => {
  useCheckoutStore.getState().setAnswer("q1", 3);

  expect(useCheckoutStore.getState().answers.q1).toBe(3);
});
```

## What to cover

Happy path, loading and pending (`isLoading` or `isPending` driving a spinner or a
disabled button), error (the user facing copy, never a raw API error), validation,
and the empty state. Never put real customer data in a fixture.

## Assert on behavior

- Compare rendered text, or the arguments a mocked call received, against the value
  written out in the test.
- `toBeDefined`, `toBeTruthy` or a snapshot as the only assertion proves nothing,
  and covergen rejects a candidate that never calls the code with an input.
- No `test.skip`, no `test.only`, no commented-out assertions.

## No real world

No network, no real clock in an assertion, no unseeded randomness, no sleeps to
order anything. Run the file before you hand it back and iterate until it passes.
A failure caused by the test (a wrong `jest.mock` shape, a bad import path, the
wrong test ID, a bare `getBy*` on async content, a missing `afterEach(cleanup)`) is
yours to fix. A failure that exposes a real bug in the source stays: report it
instead of weakening the assertion.
