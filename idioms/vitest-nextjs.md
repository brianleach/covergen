# Vitest and Next.js idioms

How tests are written for Next.js App Router code on Vitest with React Testing
Library. Follow this exactly.

## Shape

- `describe` plus `test`, one behavior each, colocated with the source file:
  `Component.tsx` gets `Component.test.tsx`, `route.ts` gets `route.test.ts`,
  `actions.ts` gets `actions.test.ts`, `page.tsx` gets `page.test.tsx`. Some suites
  use `it`; match whichever the file you are extending uses and stay consistent
  within the file.
- Import `render` and `screen` from `@testing-library/react` directly. Reach for a
  project render helper only when the component needs the provider tree that helper
  wraps.
- Interactions go through `fireEvent`. Do not use `@testing-library/user-event`
  unless the existing tests already do.
- Query in this order: `getByRole`, `getByLabelText`, `getByPlaceholderText`,
  `getByText`, and `getByTestId` last.

## App Router mental model, read this before writing

- A Client Component (`"use client"`) renders with RTL like any React component.
- A Server Component is an `async` function. Do not mount it through a provider.
  Import it, call it, and render what it returned:
  `const { default: Page } = await import("./page"); render(await Page(props));`.
  Mock everything it awaits. In current Next.js, `params` and `searchParams` are
  promises, so pass `Promise.resolve({ ... })`.
- Route handlers and Server Actions are plain async functions. Call them directly
  and assert on the returned `Response` plus the mocked side effects. Never try to
  render one.

## Mocking the framework

```typescript
// next/navigation: redirect and notFound must throw, so they halt the function
// the way they do in production.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/current-path",
  useSearchParams: () => new URLSearchParams("?q=test"),
  redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); }),
  notFound: vi.fn(() => { throw new Error("NOT_FOUND"); }),
}));

// next/headers
vi.mock("next/headers", () => ({
  cookies: () => ({ get: vi.fn().mockReturnValue({ value: "token" }) }),
  headers: () => new Headers({ "x-forwarded-for": "127.0.0.1" }),
}));

// next/cache, so revalidation in a Server Action can be asserted
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));
```

- Mock the project's own environment module rather than writing to `process.env`. A
  validated env module throws at import time on a missing variable, which fails the
  file before a single test runs.
- To assert on a mocked export, import it back inside the test and read it through
  `vi.mocked(...)`: `const { sendEmail } = await import("@/lib/mailer");`.
- `beforeEach(() => vi.clearAllMocks())` in any file that asserts call counts.

## Client Component

```typescript
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { SearchBar } from "./SearchBar";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  useSearchParams: () => new URLSearchParams(),
}));

describe("SearchBar", () => {
  beforeEach(() => vi.clearAllMocks());

  test("submits the query to the router", () => {
    render(<SearchBar />);

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "widgets" } });
    fireEvent.click(screen.getByRole("button", { name: /search/i }));

    expect(push).toHaveBeenCalledWith("/search?q=widgets");
  });
});
```

## Async Server Component

```typescript
import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

vi.mock("@/lib/content", () => ({ fetchArticle: vi.fn() }));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => { throw new Error("NOT_FOUND"); }),
}));

describe("ArticlePage", () => {
  test("renders the fetched article", async () => {
    const { fetchArticle } = await import("@/lib/content");
    vi.mocked(fetchArticle).mockResolvedValue({ title: "Rate limits" });

    const { default: Page } = await import("./page");
    render(await Page({ params: Promise.resolve({ slug: "rate-limits" }) }));

    expect(screen.getByRole("heading")).toHaveTextContent("Rate limits");
  });

  test("calls notFound when the article is missing", async () => {
    const { fetchArticle } = await import("@/lib/content");
    vi.mocked(fetchArticle).mockResolvedValue(null);

    const { default: Page } = await import("./page");

    await expect(Page({ params: Promise.resolve({ slug: "missing" }) })).rejects.toThrow("NOT_FOUND");
  });
});
```

## Route handler

Build the request with the plain web `Request`, not `NextRequest`, and call the
exported method directly.

```typescript
import { describe, expect, test, vi } from "vitest";

import { POST } from "./route";

vi.mock("@/lib/database", () => ({ query: vi.fn() }));

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/products", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/products", () => {
  test("returns 400 for an invalid body", async () => {
    const response = await POST(makeRequest({ name: "" }));

    expect(response.status).toBe(400);
  });
});
```

Assert on `response.status` and on `await response.json()`, not on the internals of
the handler.

## Server Action

```typescript
import { describe, expect, test, vi } from "vitest";

import { updateProfile } from "./actions";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/database", () => ({ updateUser: vi.fn() }));

describe("updateProfile", () => {
  test("persists the change and revalidates", async () => {
    const { revalidatePath } = await import("next/cache");
    const { updateUser } = await import("@/lib/database");
    const formData = new FormData();
    formData.set("name", "Jane");

    await updateProfile(formData);

    expect(updateUser).toHaveBeenCalledWith(expect.objectContaining({ name: "Jane" }));
    expect(revalidatePath).toHaveBeenCalledWith("/profile");
  });
});
```

## Feature flags

Mock the module the code under test imports the flag from: the project's own
server side helper for a Server Component, the flag library's hook for a Client
Component. Cover both branches of the flag, and cover the fallback when the flag
client fails to initialize, because that path is a real production state and it is
usually uncovered.

## What to cover

Happy path, the empty or `notFound` case, the error and unauthorized responses
(400, 401), both sides of a flag, and the side effects: `revalidatePath` and
`redirect` called with the right arguments.

## Assert on behavior

- Compare against the value written out in the test. `toBeDefined`, `toBeTruthy` or
  a snapshot as the only assertion proves nothing, and covergen rejects a candidate
  that never calls the code with an input.
- No network, no real clock in an assertion, no unseeded randomness, no sleeps.
- No `test.skip`, no `test.only`, no commented-out assertions.
- Run the file before you hand it back and iterate until it passes. A failure caused
  by the test (a wrong mock shape, a missing `vi.mock`, a bad import path, an
  un-awaited Server Component) is yours to fix. A failure that exposes a real bug in
  the source stays: report it instead of weakening the assertion.
