# Browser tests

Real-browser regressions for the GUI, run by [Playwright Test](https://playwright.dev/docs/intro)
against the fixture pages in `src/__tests__/browser/`. They exist for claims
jsdom cannot decide: **layout** (real boxes, overflow, scroll ranges, anchor
positioning, media queries), **paint** (rendered pixels, contrast,
anti-aliasing) and **input** (hit testing, focus modality, native wheel
scrolling, pointer capture). A claim that state, DOM structure or timers can
decide belongs in a Vitest (jsdom) test next to the component, not here.

```bash
bun run test:browser                                   # every spec
bun run test:browser browser-tests/hover-card.spec.ts  # one file
bun run test:browser --ui                              # Playwright's UI mode
```

CI runs them in `.github/workflows/browser-regressions.yml`, sharded across
parallel jobs, on every PR and push that touches what they depend on (the
workflow's `changes` job lists it). Its `browser regressions` job is a
required check on `main`, so a red shard blocks a merge. A failed shard
uploads the Playwright report, with a trace for each failed test.

## How the pieces fit

- `playwright.config.ts` starts ONE Vite dev server for the whole run with
  `vite.browser-tests.config.ts` (the app's config, which also compiles
  Tailwind for the fixtures), and drives the machine's own Google Chrome
  (`channel: "chrome"`; `CHROME_BIN` overrides it). Nothing downloads a
  browser.
- Each test gets a fresh browser context and page. Load a fixture with
  `page.goto(fixture("name"))` from `support/fixtures.ts`.
- `BROWSER_TESTS_PORT` gives a run its own server (and its own Vite cache),
  and `--output=<dir>` its own results directory, so two runs in one checkout
  or two worktrees can go at once. Without `--output` they share
  `test-results/`, which Playwright empties at the start of every run.
- `support/fixtures.ts` holds the helpers every spec may use: `fixture`,
  `centreOf`, `nextFrames` (the wait for "laid out and painted") and
  `chromeLaunchOptions` (extra Chrome flags that keep `CHROME_BIN`).

## Writing a test

- **Wait for a condition, never for time.** Use `expect(locator).toHave…`,
  `expect.poll`, or `page.waitForFunction`. A fixed sleep is either too short
  on a loaded runner or wasted everywhere else. When a negative claim needs a
  window ("nothing happens"), wait for the positive event that proves the
  gesture landed, then assert the negative.
- **Real input by coordinates when hit testing is the claim.** `page.mouse` and
  `page.keyboard` dispatch trusted input through Chrome. A locator `.click()`
  first waits until the element itself is the hit target, which is wrong when
  the test is about what sits on top of it: use `centreOf(locator)` and
  `page.mouse.click(x, y)`.
- **Emulation**: set the viewport and device scale with `test.use` or
  `page.setViewportSize`, and media with `page.emulateMedia`. For a mid-test
  device-pixel-ratio switch, or any other DevTools command, open
  `page.context().newCDPSession(page)`. Chrome flags (a fine hovering pointer,
  for instance) go through `test.use({ launchOptions:
chromeLaunchOptions([...]) })`; assert the premise they create positively
  before relying on it.
- **One load per configuration.** A fixture that exposes a probe (for example
  `window.__layoutCanvasProbe`) switches variants live: prefer that to a fresh
  page load per variant. The heavy fixtures boot most of the app from
  unbundled modules, so every load costs seconds. The layout editor specs
  share one page across a file's tests (`sharedPage` in
  `support/layout-editor/pages.ts`), reset it through the probe before each
  test, and turn tracing off, which a context shared across tests cannot
  survive. The reset is the canvas probe's `restoreLoadState`: everything a
  test can change live, the seeded tabs' order and active tab included, goes
  back there, so a new live setter needs its undo there too. Otherwise a test's
  result depends on the tests that ran before it on the page.
- **One test per claim**, named for the claim. Playwright shards and
  parallelises by test, so a long phase list split into tests finishes sooner
  and reports each red separately.
- **Measure production, not the fixture.** A fixture that reimplements a
  production decision (a spacing rule, a grouping wrapper) makes the test
  prove the copy. Import the production component or function instead.
