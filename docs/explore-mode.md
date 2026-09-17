# Explore mode: end to end tests from a live site

A design, plus the dry-run explorer that exists today. Generation is not built.

covergen's whole gate rests on lcov: a candidate is kept when it strictly raises
line coverage. A web app behind a login has no such number for the thing that
actually breaks, which is a user flow. Explore mode replaces the measurement and
keeps the gate.

## The flow model

A **flow** is a route plus the interactive elements on it.

- **Route.** The pathname with query, hash and trailing slash dropped, and every
  segment that identifies one record (digits, a uuid, a long id) collapsed to
  `:id`. `/items/1` and `/items/2` are one flow, so a list of a thousand records
  costs one page and yields one target.
- **Elements.** Role and accessible name, the pair a Playwright spec addresses:
  `link "New item"`, `button "Save changes"`, `textbox "Card number"`. Each
  carries a `mutating` flag, true for a control inside a form and for any control
  whose name reads destructive (delete, revoke, deactivate, log out, reset).
- **Covered.** Some existing spec calls `page.goto` on the route, and every
  element on it is named by some `getByRole` in the specs. Anything less is
  uncovered, and the report says which half is missing.

That definition is deliberately loose in the forgiving direction. A spec falsely
credited with a route costs one flow that never gets generated; a route falsely
called uncovered costs a duplicate spec, which the gate still has to pass.

## Ranking

Regressions are not equal, so the value order is explicit:

```
value = (1 + 2*entry + 2*writes + 3*money + 2*auth) * sqrt(1 + elements)
```

Entry points, forms that write, money paths (`checkout`, `billing`, `invoice`,
`subscription`, `order`, `refund`) and auth paths (`login`, `signup`, `password`,
`session`, `mfa`, `api-key`) carry the weight. The element count only breaks ties,
under a square root, so a busy settings page does not outrank checkout on volume.
Every weight that fired is printed beside the row, so a ranking can be argued with.

## Credentials

The owner's session is the owner's. It never enters a prompt, a log, a generated
spec or this repository.

- The operator logs in once by hand and saves a Playwright `storageState` file
  **outside the repo**.
- `explore.storage_state_env` names the environment variable holding that path.
  covergen reads the variable, hands the path to Playwright, and logs whether a
  session was present, never where it lives and never what is in it.
- Generated specs will reference a fixture that loads the same env-named path.
  No spec ever contains an email, a password, a token or a cookie.
- `explore.base_url_env` works the same way, so a private preview URL stays out of
  the config file too.

## Read-only by default

Exploring a live site with a live session can do damage, so the crawl cannot do
any. It navigates, reads the rendered DOM and follows same-origin links. It never
clicks, fills, submits or follows a logout route, which is in `ignore_patterns` by
default. `max_pages` is a hard ceiling with no unlimited setting.

Writes are opt in per route. `explore.allow_mutations` lists the route patterns
whose mutating elements may be generated against, and the owner is expected to
point `base_url_env` at a deployment they have marked disposable before setting
it. On every other route the mutating elements are reported and excluded from the
targets, so a generation pass would exercise the page without pressing Delete.

## Config

```yaml
repos:
  - name: web-app
    root: ./web-app
    runner: vitest
    sources: ["src/**/*.ts"]
    explore:
      base_url_env: COVERGEN_EXPLORE_BASE_URL       # the variable, not the URL
      storage_state_env: COVERGEN_EXPLORE_STORAGE_STATE
      allow_mutations: ["/settings/profile"]        # default [], read-only
      max_pages: 25
      ignore_patterns: ["/logout", "/admin/**"]
      spec_glob: "e2e/**/*.spec.ts"                 # the specs that already exist
```

`spec_glob` is the one key beyond the five the design started with: the coverage
half has to know where the existing specs live.

## The gate stays a gate

Generation is not built. When it is, a candidate spec is accepted only when all of
these hold, and each failure has a name the report prints:

| Rejection | Meaning |
| --- | --- |
| `flaky` | Did not pass three times in a row against the live target. |
| `no_assertion` | Asserts nothing a regression could break: no visible state change, no network response, no URL change. |
| `action_removable` | Still passed with its main action commented out. This is the end to end analogue of the mutation spot-check, and it is the one that catches a spec that only proves the page loaded. |
| `mutation_not_allowed` | Uses a mutating element on a route outside `allow_mutations`. |
| `credential_in_spec` | Contains something shaped like an email, password, cookie or token. Refused before it is ever written. |
| `off_site` | Navigates off the base origin. |
| `duplicate_flow` | The flow is already covered by an existing spec. |

`action_removable` is the load-bearing one and the reason this is worth building:
a generated end to end spec that navigates and asserts the title passes forever
and protects nothing.

## What the PR body shows

The flow map (every route crawled, its rank and why), covered against uncovered,
and once generation exists, the specs written per flow with the pass^k and
action-removal results beside each.

## The explorer today

```
covergen explore --repo <name> --dry-run
```

Logs in with the storage state, crawls up to `max_pages` internal links read-only,
records routes and interactive elements, matches them against the `page.goto` and
`getByRole` targets in the repo's existing specs, and prints the uncovered-flow
report. It generates nothing and writes nothing.

| File | Responsibility |
| --- | --- |
| `src/explore.ts` | Flow model, route normalization, scope and ignore matching, crawl, ranking, report |
| `src/explore-html.ts` | HTML to snapshot (title, links, role and name elements) plus a static HTTP reader |
| `src/explore-browser.ts` | Chromium reader: storage state in, `page.content()` out, into the same parser |
| `src/explore-specs.ts` | Scan existing specs for `page.goto` and `getByRole` targets, index them |

`playwright-core` is a dependency; browsers are not bundled. The reader finds one
through `PLAYWRIGHT_BROWSERS_PATH`, or `COVERGEN_BROWSER_PATH` names the
executable. Because both readers feed one parser, the crawl, the matching, the
ranking and the report are unit tested against a fixture site over a temp HTTP
server with no browser at all, which is what keeps CI green.

## Known limits

- **Names are approximated, not computed.** The parser reads `aria-label`, text,
  placeholder and value; the accessibility tree resolves `<label for>` and
  `aria-labelledby` properly. Playwright's role locators are the fix, at a round
  trip per element.
- **Client-side routing produces no links.** A router that pushes state from a
  click leaves nothing in the DOM to follow, so the crawl sees only what `<a href>`
  reaches. A sitemap or an exported route table is the way in.
- **`mutating` is conservative.** A logout link in the nav marks every page as
  containing a write. That only excludes the element from the targets, but it does
  inflate the ranking.
- **Session expiry looks like coverage.** An expired storage state redirects every
  route to the login page, which crawls as one route and reports the whole app
  uncovered. A logged-in assertion on the first page is the check to add.
- **A crawl is not free and not invisible.** It hits a real server, with real
  analytics, rate limits and audit logs, as the owner.
