# Playwright end to end idioms

How end to end specs are written for a web app on Playwright Test. Follow this
exactly.

## Shape

- One spec file per flow. Import `test` and `expect` from `@playwright/test` and
  nothing else from Playwright.
- Load the saved session with `test.use({ storageState: process.env.NAME })`,
  where NAME is the environment variable the prompt gives. Never write the path
  itself, and never log in through the form.
- Navigate with relative paths only: `await page.goto("/settings/profile")`. The
  base URL comes from the Playwright config, never from the spec.
- One `test()` per file, named for what the user achieves, not for the page.

## Locators

- Role locators first: `page.getByRole("button", { name: "Save" })`. Use the
  role and accessible name the prompt lists for each element.
- Then `getByLabel`, `getByPlaceholder` and `getByText`.
- No CSS or XPath selector unless no role, label or text fits, and then say why
  in a one-line comment.

## Waiting and assertions

- Web-first assertions only, which retry until they pass:
  `await expect(locator).toBeVisible()`, `await expect(page).toHaveURL(/\/items/)`,
  `await expect(locator).toHaveText("Saved")`,
  `await expect(input).toHaveValue("new name")`.
- Never `page.waitForTimeout`, never a fixed sleep, never a polling loop.
- Assert the effect of the main action: the row that appeared, the message that
  showed, the URL it moved to, the value that persisted after a reload. Asserting
  the page title or that the page loaded protects nothing.

## Writes

- Press a mutating control (submit, save, delete, archive, pay) only when the
  prompt says the route is writable. Otherwise exercise the flow without it.
- Anything a flow creates gets unique test data with a run-scoped suffix, for
  example `` const name = `e2e item ${Date.now().toString(36)}` ``, so repeated
  runs never collide.
- Never press a destructive control on data the spec did not create.

## Credentials

- No email, password, token, cookie or API key literal anywhere in the spec. The
  session is the storage state, and nothing else.

## Example

```typescript
import { expect, test } from "@playwright/test";

test.use({ storageState: process.env.E2E_STORAGE_STATE });

test("renaming a project shows the new name in the list", async ({ page }) => {
  const name = `e2e project ${Date.now().toString(36)}`;
  await page.goto("/projects");
  await page.getByRole("button", { name: "New project" }).click();
  await page.getByRole("textbox", { name: "Project name" }).fill(name);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("link", { name })).toBeVisible();
});
```
