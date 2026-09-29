import type { Locator, Page } from "@playwright/test";

import {
  DESKTOP_WINDOW,
  expect,
  probe,
  test,
} from "./support/canvas-geometry.ts";
import { centreOf, fixture, nextFrames } from "./support/fixtures.ts";

// SETTINGS > LAYOUT, IN REAL CHROME (G6, G7, H2).
//
// `layout-editor-canvas.html?settings=1` mounts the REAL Settings > Layout
// panel, either alone in the window (`settingsPage`: a width is the panel's
// own) or beside the live app column with its readings and status bar
// (`settingsApp`). What is checked here is what jsdom cannot decide: where
// things land, what fits in what, which control a width draws, and real
// pointer, wheel and focus input. One test loads the REAL Settings > Providers
// panel instead (`panel=providers`), to operate its phone select for real.
//
// WHAT IS NOT CHECKED HERE, AND WHERE IT LIVES INSTEAD (all jsdom):
//  - every setting does something ("every setting changes the app column"):
//    `layout-settings-effect-sweep.test.tsx` writes each value through its real
//    setter and renders the production app column;
//  - which area a pick shows, the rail's arrow keys, the changed dots and the
//    changed area's ", changed" words on the select, a revert's focus, the
//    landing's flash mark: `layout-settings-panel.test.tsx`;
//  - every chevron opens content: `surface-section-disclosure.test.tsx`;
//  - Choose... seeds its picks with what Automatic draws:
//    `provider-limits-choose.test.tsx`; a hidden monitor's Metrics staying
//    editable (L-174): `surface-section-rows.test.tsx` and
//    `use-navigator-resource-metrics.test.ts`;
//  - the guide target's choice among hidden, inert and selected controls:
//    `guide-target.test.ts`, `guide-target-coachmark-dismiss.test.tsx`.
//
// One page load per configuration: the width, the area and the layout each
// test needs are set live (`setWindow`, the area's tab, `probe.reset()`), so a
// test never inherits what the last one left. Any uncaught error or unhandled
// rejection raised during a test fails it (the fixture enforces that).

const PANE = "[data-fixture-settings-pane]";
const ACTIVE_PANEL = `${PANE} [role="tabpanel"]:not([hidden])`;
const RAIL = `${PANE} [role="tablist"][aria-label="Layout areas"]`;

const AREAS = [
  "Presets",
  "Task tabs",
  "Sidebar",
  "Chat",
  "Composer",
  "Usage and resources",
] as const;
type AreaLabel = (typeof AREAS)[number];

/** The comparison widths (H2): a desktop pane, and one below `md`. */
const DESKTOP = { width: 900, height: 760 } as const;
const PHONE = { width: 600, height: 760 } as const;

// ── Finding things ──────────────────────────────────────────────────────────

/** An area's tab in the rail; its name carries ", changed" for a changed area. */
function areaTab(page: Page, label: AreaLabel): Locator {
  return page.locator(PANE).getByRole("tab", { name: new RegExp(`^${label}`) });
}

function areaSelect(page: Page): Locator {
  return page.locator(PANE).getByRole("combobox", { name: "Layout area" });
}

function activePanel(page: Page): Locator {
  return page.locator(ACTIVE_PANEL);
}

/**
 * Back to the fixture's own layout, the pane at its own height, nothing
 * focused and no list open, with `label` picked in the rail. It takes the
 * desktop window first: a phone width draws no rail to pick from.
 */
async function prepareSettings(
  canvas: {
    readonly page: Page;
    readonly setWindow: (
      width: number,
      height: number,
      devicePixelRatio: number,
    ) => Promise<void>;
  },
  label: AreaLabel,
): Promise<void> {
  const { page, setWindow } = canvas;
  await setWindow(DESKTOP_WINDOW.width, DESKTOP_WINDOW.height, 1);
  await page.keyboard.press("Escape");
  await probe(page, "reset()");
  await page.evaluate((pane) => {
    const node = document.querySelector<HTMLElement>(pane);
    if (node !== null) node.style.height = "";
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    // Every area stays mounted, hidden, and remembers which rows were opened,
    // so a disclosure a previous test opened is closed here.
    for (const grab of document.querySelectorAll<HTMLElement>(
      `${pane} [data-sortable-id] > [data-row-line] [aria-expanded="true"]`,
    )) {
      grab.click();
    }
  }, PANE);
  await areaTab(page, label).click();
  await expect(areaTab(page, label)).toHaveAttribute("aria-selected", "true");
  await nextFrames(page, 2);
}

/** Every collapsed row of the picked area, opened, so its whole body is drawn. */
async function openAllDisclosures(page: Page): Promise<void> {
  await activePanel(page).evaluate((panel) => {
    for (const grab of panel.querySelectorAll<HTMLElement>(
      '[data-sortable-id] > [data-row-line] [aria-expanded="false"]',
    )) {
      grab.click();
    }
  });
  await nextFrames(page, 2);
}

// ── The panel fits ──────────────────────────────────────────────────────────

interface FitReport {
  readonly pageOverflow: boolean;
  readonly header: ReadonlyArray<string>;
  readonly card: ReadonlyArray<string>;
  readonly ellipsized: ReadonlyArray<string>;
  readonly rail: boolean;
  readonly select: boolean;
}

/**
 * The header's and the card's overflow, each ellipsized text and which of the
 * rail and the select the width draws. A preset's miniature is a picture of the
 * app, scaled down: its text is drawn as texture, not read, so it is exempt.
 */
async function readPanelFit(page: Page): Promise<FitReport> {
  return page.evaluate(() => {
    const shell = document.querySelector("[data-settings-panel-shell]");
    const header = shell?.querySelector("header");
    const card = shell?.querySelector("[data-settings-panel-body]");
    const railNav = shell?.querySelector('nav[aria-label="Layout areas"]');
    if (!shell || !header || !card || !railNav) {
      throw new Error(
        "the settings panel's shell, header, card or rail is missing",
      );
    }
    const visible = (node: Element): boolean =>
      node.getClientRects().length > 0 &&
      getComputedStyle(node).visibility !== "hidden";
    const named = (node: Element): string =>
      (node.getAttribute("aria-label") ?? node.textContent).trim().slice(0, 50);
    const wide = (root: Element, limit: DOMRect): string[] =>
      [root, ...root.querySelectorAll("*")]
        .filter(visible)
        .filter((node) => {
          const box = node.getBoundingClientRect();
          return box.width > 0 && box.right > limit.right + 0.5;
        })
        .map(named);
    const ellipsized = [...shell.querySelectorAll("*")]
      .filter((node) => node.closest("[data-layout-depiction]") === null)
      .filter(visible)
      .filter(
        (node) =>
          getComputedStyle(node).textOverflow === "ellipsis" &&
          node.scrollWidth > node.clientWidth + 0.5,
      )
      .map((node) => node.textContent.trim().slice(0, 50));
    const scrolling = document.scrollingElement;
    return {
      pageOverflow:
        scrolling !== null && scrolling.scrollWidth > window.innerWidth,
      header: wide(header, header.getBoundingClientRect()),
      card: wide(card, card.getBoundingClientRect()),
      ellipsized,
      rail: visible(railNav),
      select: [...shell.querySelectorAll('[aria-label="Layout area"]')].some(
        visible,
      ),
    };
  });
}

const FIT_CASES: ReadonlyArray<{
  readonly size: typeof DESKTOP | typeof PHONE;
  readonly what: string;
  readonly area: AreaLabel;
}> = [
  { size: DESKTOP, what: "900px", area: "Presets" },
  { size: DESKTOP, what: "900px", area: "Usage and resources" },
  { size: PHONE, what: "600px", area: "Presets" },
];

test.describe("the page alone at a desktop width and a phone width", () => {
  for (const { size, what, area } of FIT_CASES) {
    test(`nothing overflows the header or the card, and the width draws the right area control (${what}, ${area})`, async ({
      settingsPage,
    }) => {
      const { page, setWindow } = settingsPage;
      await prepareSettings(settingsPage, area);
      await setWindow(size.width, size.height, 1);
      const label = `panel fit (${what}, ${area})`;

      const fit = await readPanelFit(page);

      expect(fit.pageOverflow, `${label}: the page scrolls sideways`).toBe(
        false,
      );
      expect(fit.header, `${label}: overflows the header`).toEqual([]);
      expect(fit.card, `${label}: overflows the card`).toEqual([]);
      expect(fit.ellipsized, `${label}: ellipsized text`).toEqual([]);
      const desktop = size === DESKTOP;
      expect(fit.rail, `${label}: the rail is drawn`).toBe(desktop);
      expect(fit.select, `${label}: the select is drawn`).toBe(!desktop);
    });
  }
});

// ── A setup guide's focus return ────────────────────────────────────────────

// A setup guide hands focus back to its step's target on Escape and on its
// dismiss button, through `focusGuideTarget`. The Layout page's target holds
// both the phone select and the desktop rail, so the control it lands on must be
// the one this width draws - and on a desktop the PICKED area's tab. Which
// control the guide prefers among hidden, inert and selected ones is jsdom's
// (`guide-target.test.ts`); that the width really hides one of them is not.
test.describe("a setup guide's focus return lands on the control this width draws", () => {
  test("on a desktop, the picked area's tab", async ({ settingsPage }) => {
    const { page, setWindow } = settingsPage;
    await prepareSettings(settingsPage, "Composer");
    await setWindow(DESKTOP.width, DESKTOP.height, 1);
    // Clicked twice: the second click moves no focus, which leaves Radix's tab
    // list treating its next focus as a click's and keeping it itself.
    await areaTab(page, "Chat").click();
    await areaTab(page, "Chat").click();
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    });

    const moved = await probe(page, "focusGuideTarget('[data-layout-areas]')");

    expect(moved, "the guide reports it moved focus").toBe(true);
    await expect(areaTab(page, "Chat")).toBeFocused();
    await expect(areaTab(page, "Chat")).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  test("on a phone, the Layout area select", async ({ settingsPage }) => {
    const { page, setWindow } = settingsPage;
    await prepareSettings(settingsPage, "Chat");
    await setWindow(PHONE.width, PHONE.height, 1);
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    });

    const moved = await probe(page, "focusGuideTarget('[data-layout-areas]')");

    expect(moved, "the guide reports it moved focus").toBe(true);
    await expect(areaSelect(page)).toBeFocused();
  });
});

// ── A short desktop pane ────────────────────────────────────────────────────

// The desktop Settings modal in a wide, short window (review H2 #2): the rail is
// taller than the card leaves it, so it scrolls, and every area can be wheeled
// or scrolled into view and picked with the pointer. Its rows keep their height
// rather than squeezing to fit.
const SHORT_WINDOW = { width: 1440, height: 450 } as const;

async function prepareShortPane(
  canvas: Parameters<typeof prepareSettings>[0],
): Promise<void> {
  await prepareSettings(canvas, "Presets");
  await canvas.setWindow(SHORT_WINDOW.width, SHORT_WINDOW.height, 1);
  // The modal's pane is 80vh less the frame's title bar (about 45px); the
  // fixture's pane fills the window, so it is cut to that.
  await canvas.page.evaluate((pane) => {
    const node = document.querySelector<HTMLElement>(pane);
    if (node !== null) node.style.height = "calc(80vh - 45px)";
  }, PANE);
  await nextFrames(canvas.page, 2);
}

/** Whether a tab is inside both the card and the rail, and is what a click on its centre hits. */
async function tabIsReachable(tab: Locator): Promise<boolean> {
  return tab.evaluate((node) => {
    const card = document.querySelector("[data-settings-panel-body]");
    const rail = node.closest('[role="tablist"]');
    if (card === null || rail === null) return false;
    const within = (box: DOMRect): boolean => {
      const own = node.getBoundingClientRect();
      return own.top >= box.top - 0.5 && own.bottom <= box.bottom + 0.5;
    };
    const own = node.getBoundingClientRect();
    const hit = document
      .elementFromPoint(own.left + own.width / 2, own.top + own.height / 2)
      ?.closest('[role="tab"]');
    return (
      within(card.getBoundingClientRect()) &&
      within(rail.getBoundingClientRect()) &&
      hit === node
    );
  });
}

test.describe("a short desktop pane (1440x450)", () => {
  test("keeps every area row its height rather than squeezing it", async ({
    settingsPage,
  }) => {
    const { page } = settingsPage;
    await prepareShortPane(settingsPage);

    const shape = await page.locator(RAIL).evaluate((rail) => ({
      room: rail.parentElement?.clientHeight ?? 0,
      content: rail.scrollHeight,
      heights: [...rail.querySelectorAll('[role="tab"]')].map((tab) =>
        Math.round(tab.getBoundingClientRect().height),
      ),
    }));

    expect(
      new Set(shape.heights).size,
      `the rows differ in height: ${JSON.stringify(shape.heights)}`,
    ).toBe(1);
    expect(
      shape.heights[0],
      `the rows are squeezed: ${JSON.stringify(shape.heights)}`,
    ).toBeGreaterThanOrEqual(28);
    // Without this the rows would pass by fitting, and prove nothing.
    expect(
      shape.content,
      `the rail fits (${shape.content} in ${shape.room}), so this case proves nothing`,
    ).toBeGreaterThan(shape.room);
  });

  test("a wheel over the rail brings the last area into view", async ({
    settingsPage,
  }) => {
    const { page } = settingsPage;
    await prepareShortPane(settingsPage);
    const last = page.locator(`${RAIL} [role="tab"]`).last();
    expect(
      await tabIsReachable(last),
      "the last area is already reachable, so the wheel proves nothing",
    ).toBe(false);
    const box = await page.locator(RAIL).boundingBox();
    if (box === null) throw new Error("the rail has no box");

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 600);

    await expect
      .poll(async () => tabIsReachable(last), {
        message: "a wheel over the rail does not bring Status bar into view",
      })
      .toBe(true);
  });

  for (const label of AREAS) {
    test(`${label} can be scrolled into view and picked with the pointer`, async ({
      settingsPage,
    }) => {
      const { page } = settingsPage;
      await prepareShortPane(settingsPage);
      const tab = areaTab(page, label);

      await tab.scrollIntoViewIfNeeded();
      expect(
        await tabIsReachable(tab),
        `${label} cannot be scrolled into view`,
      ).toBe(true);
      await tab.click();

      await expect(activePanel(page)).toHaveAttribute("aria-label", label);
    });
  }
});

// ── Below `md` the rail is a select ─────────────────────────────────────────

// Operated as a person would: opened with the pointer, an item picked (review H2
// #4). What the trigger and the open list SAY about changed areas is the
// markup's, and jsdom's (`layout-settings-panel.test.tsx`). Providers draws the
// same `SettingsMasterSelect` component but wires its own pick, and its jsdom
// test mocks Radix Select, so its pick is operated for real in the next block.
test.describe("below md, the area select", () => {
  test("opens with the pointer and picks an area, which then shows", async ({
    settingsPage,
  }) => {
    const { page, setWindow } = settingsPage;
    await prepareSettings(settingsPage, "Presets");
    await setWindow(PHONE.width, PHONE.height, 1);
    const select = areaSelect(page);

    await select.click();
    await expect(page.getByRole("listbox")).toBeVisible();
    await page.getByRole("option", { name: /^Chat/ }).click();

    await expect(page.getByRole("listbox")).toHaveCount(0);
    await expect(select).toContainText("Chat");
    await expect(activePanel(page)).toHaveAttribute("aria-label", "Chat");
  });

  test("closes its open list on Escape, and holds nothing on the page afterwards", async ({
    settingsPage,
  }) => {
    const { page, setWindow } = settingsPage;
    await prepareSettings(settingsPage, "Presets");
    await setWindow(PHONE.width, PHONE.height, 1);

    await areaSelect(page).click();
    await expect(page.getByRole("listbox")).toBeVisible();
    await page.keyboard.press("Escape");

    // Until its exit animation ends the list's layer stays mounted, holding
    // the page's pointer events and the top of the Escape stack.
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await expect(
      page.locator("[data-radix-popper-content-wrapper]"),
    ).toHaveCount(0);
    await expect(activePanel(page)).toHaveAttribute("aria-label", "Presets");
  });
});

// The fixture holds ONE settings panel per load (`?panel=`, read once at module
// load, with no live switch on the probe), so the Providers page cannot be
// reached by navigating the shared `settingsPage`: it is its own load, in its
// own context, so nothing it leaves reaches the tests above and below.
const PROVIDERS_PAGE_QUERY =
  "settings=1&pane=full&panel=providers&account=1&hosts=1&readings=both";

/** The Providers page's phone select, by the name the page gives it. */
function providerSelect(page: Page): Locator {
  return page
    .locator(PANE)
    .getByRole("combobox", { name: "Provider", exact: true });
}

interface ProviderPick {
  readonly label: string | null;
  readonly title: string | null;
}

/**
 * The provider the page shows: the closed select's label, and the detail
 * pane's title (the first title drawn, since the desktop rail's column is
 * hidden at this width).
 */
async function readProviderPick(page: Page): Promise<ProviderPick> {
  return page.evaluate(() => {
    const trigger = document.querySelector(
      '[data-fixture-settings-pane] [role="combobox"][aria-label="Provider"]',
    );
    const visible = (node: Element): boolean =>
      node.getClientRects().length > 0;
    const titles = [
      ...document.querySelectorAll(
        "[data-settings-panel-body] div.font-medium.text-foreground",
      ),
    ]
      .filter(visible)
      .map((node) => node.textContent.trim());
    return {
      label: trigger?.querySelector(".truncate")?.textContent.trim() ?? null,
      title: titles[0] ?? null,
    };
  });
}

test.describe("below md, the Providers page's provider select", () => {
  test("opens with the pointer and picks another provider, which then shows", async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({
      baseURL,
      viewport: PHONE,
      deviceScaleFactor: 1,
    });
    try {
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => {
        errors.push(error.message);
      });
      await page.goto(
        `${fixture("layout-editor-canvas")}?${PROVIDERS_PAGE_QUERY}`,
      );
      await page.waitForFunction("window.__layoutCanvasProbe?.ready === true");
      const select = providerSelect(page);
      await expect(select, "the provider select is never drawn").toBeVisible();
      const current = (await readProviderPick(page)).label;
      if (current === null) {
        throw new Error(
          "narrow select, Providers: the select shows no provider",
        );
      }

      const trigger = await centreOf(select);
      await page.mouse.click(trigger.x, trigger.y);
      await expect(
        page.getByRole("listbox"),
        "select Provider does not open",
      ).toBeVisible();
      const names = await page
        .locator('[role="listbox"] [role="option"] .truncate')
        .allTextContents();
      const next = names
        .map((name) => name.trim())
        .find((name) => name !== current);
      if (next === undefined) {
        throw new Error("narrow select, Providers: only one provider to pick");
      }
      const option = page.getByRole("option", { name: next, exact: true });
      await expect(
        option,
        `select Provider has no option ${next}`,
      ).toBeVisible();
      const target = await centreOf(option);
      await page.mouse.click(target.x, target.y);

      // Until its exit animation ends the list's layer stays mounted, holding
      // the page's pointer events and the top of the Escape stack.
      await expect(
        page.getByRole("listbox"),
        `select Provider: picking ${next} leaves it open`,
      ).toHaveCount(0);
      await expect(
        page.locator("[data-radix-popper-content-wrapper]"),
        `select Provider: picking ${next} leaves it open`,
      ).toHaveCount(0);
      await expect
        .poll(async () => readProviderPick(page), {
          message: `narrow select, Providers picked ${next}`,
        })
        .toEqual({ label: next, title: next });
      expect(
        errors,
        "the Providers page raised an uncaught error or an unhandled rejection during the test",
      ).toEqual([]);
    } finally {
      await context.close();
    }
  });
});

// ── Areas: the body scrolls, and nothing else does ──────────────────────────

interface AreaGeometry {
  readonly pane: number;
  readonly body: number;
  readonly overflows: boolean;
  readonly railTop: number;
  readonly headerTop: number;
}

/** An area's scroll box and its place against the rail and its own header. */
async function readAreaGeometry(page: Page): Promise<AreaGeometry> {
  return page.evaluate(() => {
    const pane = document.querySelector("[data-fixture-settings-pane]");
    const panel = pane?.querySelector('[role="tabpanel"]:not([hidden])');
    const body = panel?.querySelector("[data-layout-area-body]");
    const rail = pane?.querySelector('[aria-label="Layout areas"]');
    if (!pane || !panel || !body || !rail) {
      throw new Error("the settings pane, its area or its rail is missing");
    }
    return {
      pane: pane.scrollTop,
      body: body.scrollTop,
      overflows: body.scrollHeight > body.clientHeight + 1,
      railTop: rail.getBoundingClientRect().top,
      headerTop: panel.getBoundingClientRect().top,
    };
  });
}

test("the longest area scrolled to its end moves its body and nothing else", async ({
  settingsPage,
}) => {
  const { page } = settingsPage;
  await prepareSettings(settingsPage, "Usage and resources");
  await openAllDisclosures(page);
  const rest = await readAreaGeometry(page);
  expect(
    rest.overflows,
    "Status bar's body does not overflow, so pinning proves nothing",
  ).toBe(true);

  await activePanel(page)
    .locator("[data-layout-area-body]")
    .evaluate((body) => {
      body.scrollTop = body.scrollHeight;
    });
  await nextFrames(page, 2);
  const scrolled = await readAreaGeometry(page);

  expect(scrolled.body, "the area's body did not scroll").toBeGreaterThan(0);
  expect(scrolled.pane, "the settings pane itself scrolled").toBe(0);
  expect(
    Math.abs(scrolled.railTop - rest.railTop),
    "the rail moved with the body",
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(scrolled.headerTop - rest.headerTop),
    "the area's header moved with the body",
  ).toBeLessThanOrEqual(1);
});

// ── Landing ─────────────────────────────────────────────────────────────────

// A Settings search result and the editor door's deep link each pick the area
// their row lives in, from another one, and land the row IN VIEW of that area's
// scrolling body. That the area is picked and the row marked is jsdom's; the
// place the row ends up needs a layout engine. A short window, with the
// destination area's every row opened, makes the scroll NECESSARY: each case
// first shows its row out of view, so a landing that scrolled nothing fails
// rather than passing because the row was already there.
const LANDING_WINDOW = { width: 1400, height: 500 } as const;

const LANDINGS: ReadonlyArray<{
  readonly kind: string;
  readonly method: "revealSetting" | "landOnRegion";
  readonly target: string;
  readonly area: AreaLabel;
  readonly row: string;
}> = [
  {
    // "Readings on agent rows", the Sidebar's last row: below the fold.
    kind: "search result",
    method: "revealSetting",
    target: "layout-resource-readings",
    area: "Sidebar",
    row: '[data-settings-anchor="layout-resource-readings"]',
  },
  {
    kind: "deep link",
    method: "landOnRegion",
    target: "contextUsage",
    area: "Chat",
    row: '[data-sortable-id="contextUsage"]',
  },
  {
    kind: "deep link",
    method: "landOnRegion",
    target: "resourceMonitor",
    area: "Usage and resources",
    row: '[data-sortable-id="resourceMonitor"]',
  },
];

interface Landing {
  readonly area: string | null;
  readonly found: boolean;
  readonly inView: boolean;
  readonly scrollTop: number;
}

async function readLanding(page: Page, rowSelector: string): Promise<Landing> {
  return page.evaluate((selector) => {
    const panel = document.querySelector(
      '[data-fixture-settings-pane] [role="tabpanel"]:not([hidden])',
    );
    const row = panel?.querySelector(selector);
    const body = panel?.querySelector("[data-layout-area-body]");
    const area = panel?.getAttribute("aria-label") ?? null;
    if (!row || !body) {
      return { area, found: false, inView: false, scrollTop: 0 };
    }
    const at = row.getBoundingClientRect();
    const box = body.getBoundingClientRect();
    return {
      area,
      found: true,
      inView: at.top >= box.top - 1 && at.top < box.bottom,
      scrollTop: body.scrollTop,
    };
  }, rowSelector);
}

test.describe("a landing puts its row in view in the area it picked", () => {
  for (const { kind, method, target, area, row } of LANDINGS) {
    test(`${kind} to ${target}`, async ({ settingsPage }) => {
      const { page, setWindow } = settingsPage;
      await prepareSettings(settingsPage, area);
      await setWindow(LANDING_WINDOW.width, LANDING_WINDOW.height, 1);
      await openAllDisclosures(page);
      await activePanel(page)
        .locator("[data-layout-area-body]")
        .evaluate((body) => {
          body.scrollTop = 0;
        });
      const resting = await readLanding(page, row);
      expect(resting.found, `${target}: the row is not in ${area}`).toBe(true);
      expect(
        resting.inView,
        `${target} is already in view at rest, so a landing proves nothing`,
      ).toBe(false);
      await areaTab(page, "Presets").click();
      await expect(activePanel(page)).toHaveAttribute("aria-label", "Presets");

      await probe(page, `${method}(${JSON.stringify(target)})`);

      // The area is picked and the row drawn first; then the smooth scroll
      // that centres it runs to its end, and only then is the place judged.
      await expect
        .poll(async () => (await readLanding(page, row)).found, {
          message: `${kind} to ${target}: the row never rendered`,
        })
        .toBe(true);
      let previous = -1;
      await expect
        .poll(
          async () => {
            const { scrollTop } = await readLanding(page, row);
            const idle = scrollTop === previous;
            previous = scrollTop;
            return idle;
          },
          {
            intervals: [100],
            message: "the landing's scroll never came to rest",
          },
        )
        .toBe(true);
      const landed = await readLanding(page, row);

      expect(landed.area, `${kind} to ${target}: the area shown`).toBe(area);
      expect(
        landed.inView,
        `${kind} to ${target}: the row is not in view of the ${area} body`,
      ).toBe(true);
    });
  }
});

// ── Header fit ──────────────────────────────────────────────────────────────

// Header readings take a bounded share of the header and never push its
// controls out: a 900px app column, both readings in the header, and Codex and
// Claude Code each drawing every window they have. The tabs and every header
// control stay inside the header, the tabs keep real room, and no reading or
// label is drawn cut.
const APP_WINDOW = { width: 1476, height: 900 } as const;

interface HeaderFit {
  readonly header: number;
  readonly tabs: number | null;
  readonly outside: ReadonlyArray<string>;
  readonly cut: ReadonlyArray<string>;
  readonly shown: ReadonlyArray<string>;
  readonly ellipsized: ReadonlyArray<string>;
}

/**
 * The header's geometry: every visible control outside it, the tab strip's
 * width, and each reading shown whole or cut - cut meaning outside its line,
 * or overflowing its own box or a descendant's.
 */
async function readHeaderFit(page: Page): Promise<HeaderFit> {
  return page.evaluate(() => {
    const header = document.querySelector('[data-testid="app-header"]');
    if (header === null) throw new Error("there is no app header");
    const bounds = header.getBoundingClientRect();
    const visible = (node: Element): boolean =>
      node.getClientRects().length > 0 &&
      getComputedStyle(node).visibility !== "hidden";
    const named = (node: Element): string =>
      (
        node.getAttribute("aria-label") ??
        node.getAttribute("data-testid") ??
        node.textContent
      )
        .trim()
        .slice(0, 60);
    // The tab strip scrolls its own tabs, so it is judged by its own box and
    // the tabs inside it are not.
    const outside = [...header.querySelectorAll('button, [role="tablist"]')]
      .filter(
        (node) =>
          node.matches('[role="tablist"]') ||
          node.closest('[role="tablist"]') === null,
      )
      .filter(visible)
      .filter((node) => {
        const box = node.getBoundingClientRect();
        return box.right > bounds.right + 0.5 || box.left < bounds.left - 0.5;
      })
      .map(named);
    const tablist = header.querySelector('[role="tablist"]');
    // A box drawn narrower than its content: the reading or any laid-out
    // descendant (an inline box has no clientWidth to compare).
    const overflows = (node: Element): boolean =>
      [node, ...node.querySelectorAll("*")].some(
        (part) =>
          part.clientWidth > 0 &&
          getComputedStyle(part).display !== "inline" &&
          part.scrollWidth > part.clientWidth + 0.5,
      );
    const cut: string[] = [];
    const shown: string[] = [];
    for (const reading of header.querySelectorAll(
      '[data-testid^="status-bar-provider-segment-"], [data-testid^="status-bar-resource-metric-"]',
    )) {
      const line = reading.parentElement?.getBoundingClientRect();
      if (!visible(reading) || line === undefined) continue;
      const box = reading.getBoundingClientRect();
      const inside =
        box.left >= line.left - 0.5 &&
        box.right <= line.right + 0.5 &&
        box.top >= line.top - 0.5 &&
        box.bottom <= line.bottom + 0.5;
      const outsideLine =
        box.top >= line.bottom - 0.5 ||
        box.right <= line.left + 0.5 ||
        box.left >= line.right - 0.5;
      if (outsideLine) continue;
      if (!inside || overflows(reading)) cut.push(reading.textContent.trim());
      else shown.push(reading.textContent.trim());
    }
    // Text a control draws cut to an ellipsis. The tab strip's own tab titles
    // are exempt: a tab shortens its title by design, like any browser's.
    const ellipsized = [...header.querySelectorAll("*")]
      .filter((node) => node.closest('[role="tablist"]') === null)
      .filter(visible)
      .filter(
        (node) =>
          getComputedStyle(node).textOverflow === "ellipsis" &&
          node.scrollWidth > node.clientWidth + 0.5,
      )
      .map((node) => node.textContent.trim().slice(0, 60));
    return {
      header: Math.round(bounds.width),
      tabs:
        tablist === null
          ? null
          : Math.round(tablist.getBoundingClientRect().width),
      outside,
      cut,
      shown,
      ellipsized,
    };
  });
}

/** Every window each fixture provider offers, ticked under Choose... */
async function chooseEveryProviderWindow(page: Page): Promise<void> {
  const panel = activePanel(page);
  for (const id of ["codex", "claude-code"]) {
    await panel
      .locator(`[data-sortable-id="${id}"]`)
      .getByRole("radio", { name: "Choose..." })
      .click();
  }
  await openAllDisclosures(page);
  // One box a pass: a click re-renders the row it sits in.
  const unticked = panel
    .locator('[data-sortable-id="codex"], [data-sortable-id="claude-code"]')
    .locator('[role="checkbox"][aria-checked="false"]');
  for (let pass = 0; pass < 8; pass += 1) {
    if ((await unticked.count()) === 0) break;
    await unticked.first().click();
  }
}

/** The header's rendered markup, twice in a row the same: nothing mid-transition. */
async function waitUntilHeaderSettled(page: Page): Promise<void> {
  let previous = "";
  await expect
    .poll(
      async () => {
        const next = await page
          .locator('[data-testid="app-header"]')
          .evaluate((node) => node.outerHTML);
        const settled = next === previous;
        previous = next;
        return settled;
      },
      { intervals: [100], message: "the header never stopped changing" },
    )
    .toBe(true);
}

const HEADER_VARIANTS: ReadonlyArray<{
  readonly label: string;
  /** Both readings on the right, where they share the cluster beside the header's own controls. */
  readonly bothRight: boolean;
}> = [
  // Both readings where the fixture puts them: usage left, resources right.
  { label: "split", bothRight: false },
  { label: "both right", bothRight: true },
];

test.describe("the header readings in a 900px app column", () => {
  for (const { label, bothRight } of HEADER_VARIANTS) {
    test(`keep every header control, and every reading whole (${label})`, async ({
      settingsApp,
    }) => {
      const { page, setWindow } = settingsApp;
      await prepareSettings(settingsApp, "Usage and resources");
      // The settings pane is 36rem, so this leaves the app column 900px wide.
      await setWindow(APP_WINDOW.width, APP_WINDOW.height, 1);
      await openAllDisclosures(page);
      if (bothRight) {
        await activePanel(page)
          .getByRole("radiogroup", { name: "Usage limits side" })
          .getByRole("radio", { name: "Right" })
          .click();
      }
      await chooseEveryProviderWindow(page);
      await waitUntilHeaderSettled(page);
      const windows = await page.evaluate(
        "Object.values(window.__layoutCanvasProbe.snapshot().arrangement.providerLimits).reduce((sum, entry) => sum + entry.limitKeys.length, 0)",
      );
      expect(
        windows,
        `header fit (${label}): fewer than 4 windows selected, so this is not the crowded header`,
      ).toBeGreaterThanOrEqual(4);

      const fit = await readHeaderFit(page);

      test.info().annotations.push({
        type: `header fit (${label})`,
        description: `tabs ${String(fit.tabs)}px of ${fit.header}px; readings shown ${JSON.stringify(fit.shown)}`,
      });
      expect(
        fit.shown,
        `header fit (${label}): no reading is drawn, so this measures nothing`,
      ).not.toEqual([]);
      expect(fit.outside, `header fit (${label}): leaves the header`).toEqual(
        [],
      );
      expect(
        fit.tabs ?? 0,
        `header fit (${label}): the tab strip keeps ${String(fit.tabs)}px of a ${fit.header}px header`,
      ).toBeGreaterThanOrEqual(fit.header * 0.25);
      expect(fit.cut, `header fit (${label}): a reading is cut`).toEqual([]);
      expect(
        fit.ellipsized,
        `header fit (${label}): a control draws ellipsized text`,
      ).toEqual([]);
    });
  }
});

// ── Page errors ─────────────────────────────────────────────────────────────

// Any uncaught error or unhandled rejection a test raises fails that test (the
// fixture's `settingsPage` and `settingsApp` enforce it). What they cannot see
// is the boot, which runs before the first test: these read what it raised.
test.describe("booting the fixture raises no page error", () => {
  test("Settings > Layout alone in the window", ({ settingsPage }) => {
    expect(settingsPage.bootErrors).toEqual([]);
  });

  test("Settings > Layout beside the app column", ({ settingsApp }) => {
    expect(settingsApp.bootErrors).toEqual([]);
  });
});
