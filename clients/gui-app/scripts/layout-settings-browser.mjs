// SETTINGS ▸ LAYOUT, IN REAL CHROME (G6, G7).
//
// Run it from `clients/gui-app`:
//
//     node scripts/layout-settings-browser.mjs [--out DIR]
//
// It serves `src/__tests__/browser/layout-editor-canvas.html?settings=1`,
// which mounts the REAL Settings ▸ Layout panel beside the live app column
// (the real header with its tab strip and readings, the sample workspace's
// rail, transcript, dock and composer, and the real status bar), and checks
// things jsdom cannot decide:
//
//   1. Areas (H2): the page is Settings ▸ Providers' master-detail - a rail
//      of areas beside the picked one. The rail and the area's header stay put
//      while its body scrolls; a newly picked area starts at its top; a search
//      result and the editor door's deep link each land their row in view;
//      and nothing overflows the header or the card at either width.
//      Below `md` the area select - and Providers' provider select, the same
//      component - is operated for real, and a changed area carries a dot its
//      changed row's ↺ by keyboard clears, leaving focus in the area; a short
//      desktop pane scrolls its rail; and a setup guide's focus return lands
//      on the area control the width draws. Which area a pick shows, the
//      rail's arrow keys and the dot's own logic are jsdom's
//      (`layout-settings-panel.test.tsx`).
//   2. Disclosures: every row that draws a chevron opens something with
//      content, and every row that opens nothing draws no chevron.
//   3. Every setting does something: each option of each segmented control,
//      each switch, each checkbox and each ordered list is operated in turn,
//      from the shipped layout, and the app column (never the panel) must
//      render differently afterwards. A setting nothing reads is exactly a
//      setting whose operation leaves the product unchanged.
//   4. G7 / L-174: the resource monitor and the agent rows' readings are
//      two switches, each changing only its own surface, and the rows draw
//      the monitor's own Metrics choice.
//
// `--out DIR` writes a screenshot of each checked view and G7 step into DIR.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { createServer as createTcpServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  findChrome,
  launchChromeWithDevTools,
  terminateProcessTree,
} from "./chrome-launcher.mjs";
import { openTabSession } from "./cdp-client.mjs";

const VIEWPORT = { width: 1920, height: 1080 };
const FIXTURE_PATH = "/src/__tests__/browser/layout-editor-canvas.html";
// Readings in the tab strip, so the Usage limits and Resource monitor
// settings are read there (G6), and signed in, so they have data.
const VARIANTS = [
  {
    key: "sample",
    query:
      "settings=1&surface=sample&header=app&readings=both&account=1&hosts=1",
  },
  {
    key: "epic",
    query: "settings=1&surface=epic&header=app&readings=both&account=1&hosts=1",
  },
];
const TABS = [
  "Presets",
  "Task tabs",
  "Sidebar",
  "Chat",
  "Composer",
  "Usage and resources",
];
/**
 * Controls that only take effect once another is on, and the switch that
 * turns it on first - the setup a person would do, named by its label.
 */
const PREREQUISITES = [
  {
    control: /^contextUsage check /,
    first: "contextUsage Pin breakdown",
  },
];
/**
 * Setups that reveal or enable controls the shipped layout does not offer:
 * the side strip's View, and a provider's window checkboxes under Choose.
 * Each setup is operated first, and every control it reveals is then swept
 * from that state, one at a time, exactly as the base controls are.
 */
const SETUPS = [
  { tab: "Task tabs", steps: ["- Tab placement: Left"] },
  { tab: "Usage and resources", steps: ["codex Limits: Choose..."] },
  { tab: "Usage and resources", steps: ["claude-code Limits: Choose..."] },
];
/**
 * Operations that change a setting and, by design, nothing on screen, each
 * with the ruling that says so. Anything else that changes nothing fails.
 */
const EXPECTED_SILENT = [
  {
    control: /: Choose/,
    why: "Choose seeds its picks with what Automatic draws, so the picture does not move until a pick changes",
  },
  {
    control: /Limits: Automatic/,
    why: "back from Choose..., whose picks were seeded with the window Automatic draws, so the picture is the same",
  },
  {
    control:
      /^(openrouter|kilocode|grok|huggingface|opencode|cursor) .* display: Hidden$/,
    why: "the fixture signs in Codex and Claude Code only, so this provider draws no reading to hide",
  },
  {
    control: /^model Reasoning control: /,
    why: "the footer it styles is inside the model picker, which is closed here; the row pictures both options, and the editor opens its sample picker while Model is selected (L-173)",
  },
  {
    control: /^(railPullRequests|railComments) /,
    why: "their Auto rule finds no pull requests or comments in the fixture, so the panel is not drawn either way",
  },
];

const PANEL = `document.querySelector('[data-fixture-settings-pane] [role="tabpanel"]:not([hidden])')`;

/**
 * Every operable control in the visible tab, keyed by what a person would
 * call it - the row it sits in, its group's name and its own - so the key
 * survives a reset re-rendering the tab and a prerequisite adding rows above
 * it. The unchecked options of each radio group, each switch, each checkbox,
 * each stack link, and the first movable row of each ordered list (moved
 * down one).
 */
const CONTROLS = `(() => {
  const panel = ${PANEL};
  const rowOf = (node) => node.closest('[data-sortable-id]')?.getAttribute('data-sortable-id') ?? '-';
  const nameOf = (node) => (node.getAttribute('aria-label') ?? node.closest('label')?.textContent ?? node.textContent).trim();
  const out = [];
  for (const group of panel.querySelectorAll('[role="radiogroup"]')) {
    for (const option of group.querySelectorAll('[role="radio"]')) {
      if (option.getAttribute('aria-checked') === 'true') continue;
      out.push({ key: rowOf(group) + ' ' + group.getAttribute('aria-label') + ': ' + nameOf(option), node: option });
    }
  }
  for (const node of panel.querySelectorAll('[role="switch"]')) {
    out.push({ key: rowOf(node) + ' ' + nameOf(node), node });
  }
  for (const node of panel.querySelectorAll('[role="checkbox"]')) {
    const text = node.closest('label')?.textContent ?? document.querySelector('label[for="' + node.id + '"]')?.textContent ?? '';
    out.push({ key: rowOf(node) + ' check ' + text.trim(), node });
  }
  for (const node of panel.querySelectorAll('[data-stack-slot] button')) {
    out.push({ key: rowOf(node) + ' ' + nameOf(node), node });
  }
  // The first movable row of each list moved down one, and the second moved up
  // one: the two drawn rows trade places whatever the list's length, and one
  // of them can meet a boundary the list refuses without hiding the setting.
  for (const list of panel.querySelectorAll('[role="group"][aria-label]')) {
    const rows = [...list.querySelectorAll('[data-sortable-id]')].filter(
      (candidate) => candidate.closest('[role="group"]') === list && candidate.querySelector(':scope > [data-row-line] [data-row-grip]') !== null,
    );
    rows.slice(0, 2).forEach((row, index) => {
      out.push({ key: 'order ' + list.getAttribute('aria-label') + ': ' + row.getAttribute('data-sortable-id') + (index === 0 ? ' down' : ' up'), node: row.querySelector(':scope > [data-row-line] [data-row-grab]'), order: index === 0 ? 'ArrowDown' : 'ArrowUp' });
    });
  }
  return out.filter((entry) => entry.node !== null && !entry.node.disabled && !entry.node.hasAttribute('data-disabled') && entry.node.closest('[inert]') === null);
})()`;

const STORED = "JSON.stringify(window.__layoutCanvasProbe.snapshot())";

/** An area's scroll box and its place against the rail and its own header. */
const AREA_GEOMETRY = `(() => {
  const pane = document.querySelector('[data-fixture-settings-pane]');
  const panel = pane.querySelector('[role="tabpanel"]:not([hidden])');
  const body = panel.querySelector('[data-layout-area-body]');
  const rail = pane.querySelector('[aria-label="Layout areas"]');
  return {
    pane: pane.scrollTop,
    body: body.scrollTop,
    overflows: body.scrollHeight > body.clientHeight + 1,
    railTop: rail.getBoundingClientRect().top,
    headerTop: panel.getBoundingClientRect().top,
    bodyTop: body.getBoundingClientRect().top,
  };
})()`;

/** The page's area list (H2): a vertical tab list in the pane's rail. */
const AREA_TAB =
  '[data-fixture-settings-pane] [aria-label="Layout areas"] [role="tab"]';
/** An area's name as the rail draws it, without the changed dot's words. */
const AREA_NAME =
  "((node) => node.querySelector('.truncate').textContent.trim())";

/** The page alone in the pane, as `checkPanelFit` and the H2 fixes load it. */
const PAGE_QUERY = "settings=1&pane=full&account=1&hosts=1&readings=both";

/**
 * No select list open. Base keeps a select's list mounted after its first
 * open, `hidden` and `data-closed` once it has closed (a hidden layer holds no
 * pointer events), so "open" is a positioner that is not hidden.
 */
const SELECT_CLOSED = `document.querySelector('[data-slot="select-positioner"]:not([hidden]) [role="listbox"]') === null`;

/** A select's trigger, by the name the page gives it. */
const SELECT_TRIGGER = (label) =>
  `document.querySelector('[data-fixture-settings-pane] [role="combobox"][aria-label="${label}"]')`;

/** The comparison widths (H2): a desktop pane, and one below `md`. */
const SHOT_SIZES = [
  ["normal", { width: 900, height: 760 }],
  ["narrow", { width: 600, height: 760 }],
];

/**
 * The header's geometry: every visible control outside it, the tab strip's
 * width, and each reading shown whole or cut - cut meaning outside its line,
 * or overflowing its own box or a descendant's.
 */
const HEADER_FIT_PROBE = `(() => {
  const header = document.querySelector('[data-testid="app-header"]');
  if (header === null) return null;
  const h = header.getBoundingClientRect();
  const visible = (node) => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
  const label = (node) => (node.getAttribute('aria-label') ?? node.getAttribute('data-testid') ?? node.textContent).trim().slice(0, 60);
  // The tab strip scrolls its own tabs, so it is judged by its own box and
  // the tabs inside it are not.
  const outside = [...header.querySelectorAll('button, [role="tablist"]')]
    .filter((node) => node.matches('[role="tablist"]') || node.closest('[role="tablist"]') === null)
    .filter(visible)
    .filter((node) => { const r = node.getBoundingClientRect(); return r.right > h.right + 0.5 || r.left < h.left - 0.5; })
    .map(label);
  const tablist = header.querySelector('[role="tablist"]');
  // A box drawn narrower than its content: the reading or any laid-out
  // descendant (an inline box has no clientWidth to compare).
  const overflows = (node) => [node, ...node.querySelectorAll('*')].some(
    (part) => part.clientWidth > 0 && getComputedStyle(part).display !== 'inline' && part.scrollWidth > part.clientWidth + 0.5,
  );
  const cut = [];
  const shown = [];
  for (const reading of header.querySelectorAll('[data-testid^="status-bar-provider-segment-"], [data-testid^="status-bar-resource-metric-"]')) {
    if (!visible(reading)) continue;
    const line = reading.parentElement.getBoundingClientRect();
    const r = reading.getBoundingClientRect();
    const inside = r.left >= line.left - 0.5 && r.right <= line.right + 0.5 && r.top >= line.top - 0.5 && r.bottom <= line.bottom + 0.5;
    const outsideLine = r.top >= line.bottom - 0.5 || r.right <= line.left + 0.5 || r.left >= line.right - 0.5;
    if (outsideLine) continue;
    if (!inside || overflows(reading)) cut.push(reading.textContent.trim());
    else shown.push(reading.textContent.trim());
  }
  // Text a control draws cut to an ellipsis. The tab strip's own tab titles
  // are exempt: a tab shortens its title by design, like any browser's.
  const ellipsized = [...header.querySelectorAll('*')]
    .filter((node) => node.closest('[role="tablist"]') === null && visible(node))
    .filter((node) => getComputedStyle(node).textOverflow === 'ellipsis' && node.scrollWidth > node.clientWidth + 0.5)
    .map((node) => node.textContent.trim().slice(0, 60));
  return { header: Math.round(h.width), tabs: tablist === null ? null : Math.round(tablist.getBoundingClientRect().width), outside, cut, shown, ellipsized };
})()`;

/**
 * `LAYOUT_SETTINGS_ONLY=tabs,fit,short,narrow,header,choose,sweep,g7` runs only the named
 * checks - for a mutation run, where the full sweep is minutes of waiting on a
 * check that is not the one being proved.
 */
const ONLY = process.env.LAYOUT_SETTINGS_ONLY?.split(",") ?? null;
const runs = (check) => ONLY === null || ONLY.includes(check);

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outDir = outIndex === -1 ? null : path.resolve(args[outIndex + 1]);

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const chromePath = await findChrome("the Settings ▸ Layout regression");
const vitePort = await freePort();
let chrome;
let chromeProfilePath;
let client;
let viteProcess;
const failures = [];
/** The viewport the current tab should have; a fresh tab re-applies it. */
let viewport = VIEWPORT;
/** Fixture loads retried after a stalled boot; see `loadFixture`. */
let stalledBootRetries = 0;
/** Uncaught exceptions and error-level log entries, for a page that never renders. */
const pageExceptions = [];

try {
  if (outDir !== null) await mkdir(outDir, { recursive: true });
  const origin = `http://127.0.0.1:${vitePort}`;
  viteProcess = await spawnVite(vitePort);
  let viteError = "";
  viteProcess.stderr.setEncoding("utf8");
  viteProcess.stderr.on("data", (chunk) => {
    viteError += chunk;
  });
  await waitForHttp(
    `${origin}${FIXTURE_PATH}`,
    viteProcess,
    () => viteError,
    "Vite",
  );

  const launched = await launchChromeWithDevTools(
    chromePath,
    "traycer-layout-settings-",
    [],
  );
  chrome = launched.chrome;
  chromeProfilePath = launched.profilePath;
  const devtoolsUrl = launched.devtoolsHttpUrl;
  await waitForHttp(
    new URL("/json/version", devtoolsUrl).href,
    chrome,
    launched.readError,
    "Chrome DevTools",
  );
  client = await openTabSession(devtoolsUrl);
  // Registered on the session, so they follow every fresh tab.
  client.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
    pageExceptions.push(
      exceptionDetails.exception?.description ?? exceptionDetails.text,
    );
  });
  client.on("Log.entryAdded", ({ entry }) => {
    if (entry.level === "error") pageExceptions.push(entry.text);
  });
  // The HMR socket stays open: with file watching off (`spawnVite`) it carries
  // only the dependency optimizer's own reloads, which the warm-up boot below
  // waits out.
  await prepareTab(client);

  // Which operations changed the app, across both windows: a sidebar-side
  // pick changes the task window and not the sample one, and a setting passes
  // when it changes the product ANYWHERE.
  // A cold dependency cache: the first boot discovers the page's deps, and
  // the optimizer may reload it once while it settles. Boot it, wait that out,
  // and only then start the checks.
  await loadFixture(
    client,
    `${origin}${FIXTURE_PATH}?${VARIANTS[0].query}`,
    "[data-fixture-settings-pane] [role=tablist]",
  );
  await delay(3_000);
  if (runs("fit")) await checkPanelFit(client, origin);
  if (runs("short")) await checkShortPane(client, origin);
  if (runs("narrow")) await checkNarrowSelectors(client, origin);
  const effects = new Map();
  const PAGE_ONLY = ["fit", "short", "narrow"];
  for (const variant of VARIANTS) {
    if (ONLY !== null && ONLY.every((check) => PAGE_ONLY.includes(check)))
      break;
    await loadFixture(
      client,
      `${origin}${FIXTURE_PATH}?${variant.query}`,
      "[data-fixture-settings-pane] [role=tablist]",
    );
    await settle(client);
    await checkErrors(client, variant.key);
    if (variant.key === "sample") {
      if (runs("tabs")) {
        await checkAreas(client);
        await checkLanding(client);
        await checkDisclosures(client);
      }
      if (runs("choose")) await checkChooseSeedsSelection(client);
      if (runs("header")) await checkHeaderFit(client);
    }
    if (runs("sweep")) {
      for (const [name, changed, stored] of await operateEverySetting(client)) {
        const seen = effects.get(name) ?? { changed: false, stored: false };
        effects.set(name, {
          changed: seen.changed || changed,
          stored: seen.stored || stored,
        });
      }
    }
    if (variant.key === "epic" && runs("g7")) await checkAgentRows(client);
    await checkErrors(client, variant.key);
  }

  const silent = [...effects].filter(([, effect]) => !effect.changed);
  console.log(
    `settings operated: ${effects.size}, changed the app: ${effects.size - silent.length}`,
  );
  for (const [name, effect] of silent) {
    // Matched against the operated control alone, never a setup step before it.
    const expected = EXPECTED_SILENT.find((entry) =>
      entry.control.test(name.split(" ▸ ").at(-1)),
    );
    if (expected !== undefined) {
      console.log(`  silent by design: ${name} (${expected.why})`);
    } else {
      failures.push(
        `no visible effect: ${name}${effect.stored ? "" : " (and nothing was stored)"}`,
      );
    }
  }
  if (runs("sweep"))
    assert.ok(
      effects.size > 60,
      `only ${effects.size} settings were found to operate`,
    );

  if (stalledBootRetries > 1)
    failures.push(
      `${stalledBootRetries} fixture loads stalled and were retried in a fresh tab; one is tolerated, a repeat is a regression (see loadFixture)`,
    );
  if (failures.length > 0) {
    console.error(
      `\n${failures.length} failure(s):\n- ${failures.join("\n- ")}`,
    );
    process.exitCode = 1;
  } else {
    console.log("layout settings browser regression: OK");
  }
} finally {
  await client?.close();
  viteProcess?.kill("SIGTERM");
  if (chrome !== undefined) {
    try {
      await terminateProcessTree(chrome);
    } catch (error) {
      console.error("Chrome termination failed:", error);
      process.exitCode = 1;
    }
  }
  if (chromeProfilePath !== undefined) {
    await rm(chromeProfilePath, {
      recursive: true,
      force: true,
      maxRetries: 3,
    });
  }
}

/**
 * Loads the fixture in a fresh tab (`openTabSession`), so every load gets its
 * own renderer. One tab navigated from load to load keeps one renderer, which
 * grows until it stops booting the fixture or refuses new loads
 * (net::ERR_INSUFFICIENT_RESOURCES, the CI failure of this driver) or is
 * killed outright (tickets/12).
 *
 * Reloads when Vite's dependency optimizer re-ran under the load (a 504
 * "Outdated Optimize Dep"): another driver's `--force` server rewrites the
 * shared cache, and the page it half-loaded never recovers. A stalled boot is
 * retried ONCE, in another fresh tab, loudly and counted: the run fails on a
 * second one, so a repeat surfaces instead of hiding behind the retry.
 */
async function loadFixture(client, url, readySelector) {
  let retriedStall = false;
  for (let attempt = 1; ; attempt += 1) {
    pageExceptions.length = 0;
    await client.freshTab();
    await prepareTab(client);
    try {
      await navigate(client, url);
      await waitFor(
        client,
        "the fixture probe",
        `window.__layoutCanvasProbe?.ready === true && document.querySelector(${JSON.stringify(readySelector)}) !== null`,
      );
      return;
    } catch (error) {
      const outdated = pageExceptions.some((text) =>
        text.includes("Outdated Optimize Dep"),
      );
      if (outdated && attempt < 3) {
        console.log(
          `reloading: Vite re-optimized its dependencies (attempt ${attempt})`,
        );
        continue;
      }
      if (retriedStall || !(error instanceof Error) || !stalledBoot(error))
        throw error;
      retriedStall = true;
      stalledBootRetries += 1;
      console.error(
        `\n  WARNING ${url}: the fixture's boot stalled in a fresh tab (${error.message.split("\n")[0]}; renderer ${client.crashed() ? "gone" : "alive"}); retrying once in another fresh tab (retry ${stalledBootRetries}, a second one fails the run).\n`,
      );
    }
  }
}

/** A dead renderer, an unanswered command, or a page that never rendered. */
function stalledBoot(error) {
  const message = error.message;
  if (message.startsWith("The renderer was killed")) return true;
  if (/^CDP \S+ got no answer within \d+ms/.test(message)) return true;
  if (message.startsWith("Timed out waiting for the navigation")) return true;
  return (
    message.startsWith("Timed out waiting for the fixture probe") &&
    message.includes('"rootEmpty": true')
  );
}

/** The tab's own state, which a fresh tab starts without. */
async function prepareTab(client) {
  await client.send("Runtime.enable");
  await client.send("Page.enable");
  await client.send("Log.enable");
  await client.send("Emulation.setDeviceMetricsOverride", {
    ...viewport,
    deviceScaleFactor: 1,
    mobile: false,
  });
}

async function checkAreas(client) {
  // Pinned: the longest area scrolled to its end moves its body and nothing
  // else - not the rail, not its header, not the settings pane.
  await clickTab(client, "Usage and resources");
  await openAllDisclosures(client);
  const rest = await evaluate(client, AREA_GEOMETRY);
  await evaluate(
    client,
    `(() => { const body = ${PANEL}.querySelector('[data-layout-area-body]'); body.scrollTop = body.scrollHeight; })()`,
  );
  await settle(client);
  const scrolled = await evaluate(client, AREA_GEOMETRY);
  if (!rest.overflows)
    failures.push(
      "Status bar's body does not overflow, so pinning proves nothing",
    );
  if (
    scrolled.body === 0 ||
    scrolled.pane !== 0 ||
    Math.abs(scrolled.railTop - rest.railTop) > 1 ||
    Math.abs(scrolled.headerTop - rest.headerTop) > 1
  ) {
    failures.push(
      `area body scroll moved more than the body: ${JSON.stringify({ rest, scrolled })}`,
    );
  }
  await screenshotPane(client, "area-body-scrolled");
  // A newly picked area starts at its top, and so does the one left scrolled
  // when it is picked again.
  for (const label of ["Chat", "Usage and resources"]) {
    await clickTab(client, label);
    const top = await evaluate(client, AREA_GEOMETRY);
    if (top.body !== 0 || top.pane !== 0)
      failures.push(
        `${label} opened scrolled (body ${top.body}px, pane ${top.pane}px)`,
      );
  }
}

/**
 * A Settings search result and the editor door's deep link each pick the
 * area their row lives in, from another one, and land on the row: visible in
 * the area's body and marked.
 */
async function checkLanding(client) {
  const cases = [
    [
      "search",
      "revealSetting",
      "layout-sidebar-side",
      "Sidebar",
      '[data-settings-anchor="layout-sidebar-side"]',
    ],
    [
      "deep link",
      "landOnRegion",
      "contextUsage",
      "Chat",
      '[data-sortable-id="contextUsage"]',
    ],
    [
      "deep link",
      "landOnRegion",
      "resourceMonitor",
      "Usage and resources",
      '[data-sortable-id="resourceMonitor"]',
    ],
  ];
  for (const [kind, method, target, area, selector] of cases) {
    await evaluate(client, "window.__layoutCanvasProbe.reset()");
    await clickTab(client, "Presets");
    await evaluate(
      client,
      `window.__layoutCanvasProbe.${method}(${JSON.stringify(target)})`,
    );
    const deadline = Date.now() + 3_000;
    let state = null;
    while (Date.now() < deadline) {
      await settle(client);
      state = await evaluate(
        client,
        `(() => {
           const panel = ${PANEL};
           const row = panel?.querySelector(${JSON.stringify(selector)});
           const body = panel?.querySelector('[data-layout-area-body]');
           if (!row || !body) return { area: panel?.getAttribute('aria-label') ?? null, found: false };
           const r = row.getBoundingClientRect();
           const b = body.getBoundingClientRect();
           return {
             area: panel.getAttribute('aria-label'),
             found: true,
             inView: r.top >= b.top - 1 && r.top < b.bottom,
             flashed: row.hasAttribute('data-settings-anchor-flash') || row.querySelector('[data-settings-anchor-flash]') !== null || row.closest('[data-settings-anchor-flash]') !== null,
           };
         })()`,
      );
      if (state.area === area && state.found && state.inView && state.flashed)
        break;
    }
    if (
      !(state.area === area && state.found && state.inView && state.flashed)
    ) {
      failures.push(
        `${kind} to ${target}: expected ${area} with the row in view and marked, got ${JSON.stringify(state)}`,
      );
    }
    await screenshotPane(client, `landing-${slug(kind)}-${slug(target)}`);
  }
  await evaluate(client, "window.__layoutCanvasProbe.reset()");
}

/**
 * The page alone at a desktop width and a phone width: nothing in the header
 * or the card is wider than its box, the header's action stays in the header,
 * and the rail or the select - whichever the width draws - is the one shown.
 */
async function checkPanelFit(client, origin) {
  for (const [size, viewport] of SHOT_SIZES) {
    await setViewport(client, viewport);
    await loadFixture(
      client,
      `${origin}${FIXTURE_PATH}?settings=1&pane=full&panel=layout&account=1&hosts=1&readings=both`,
      "[data-settings-panel-shell]",
    );
    for (const area of ["Presets", "Usage and resources"]) {
      if (size === "normal") await clickTab(client, area);
      const m = await evaluate(
        client,
        `(() => {
           const shell = document.querySelector('[data-settings-panel-shell]');
           const header = shell.querySelector('header');
           const card = shell.querySelector('[data-settings-panel-body]');
           const h = header.getBoundingClientRect();
           const c = card.getBoundingClientRect();
           const visible = (node) => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
           const wide = (root) => [root, ...root.querySelectorAll('*')].filter(visible).filter((node) => {
             const r = node.getBoundingClientRect();
             return r.width > 0 && (r.right > c.right + 0.5 && root === card || r.right > h.right + 0.5 && root === header);
           }).map((node) => (node.getAttribute('aria-label') ?? node.textContent).trim().slice(0, 50));
           // A preset's miniature is a picture of the app, scaled down: its
           // text is drawn to be seen as texture, not read.
           const ellipsized = [...shell.querySelectorAll('*')].filter((node) => node.closest('[data-layout-depiction]') === null).filter(visible).filter((node) => getComputedStyle(node).textOverflow === 'ellipsis' && node.scrollWidth > node.clientWidth + 0.5).map((node) => node.textContent.trim().slice(0, 50));
           return {
             pageOverflow: document.scrollingElement.scrollWidth > window.innerWidth,
             header: wide(header),
             card: wide(card),
             ellipsized,
             rail: visible(shell.querySelector('nav[aria-label="Layout areas"]')),
             select: [...shell.querySelectorAll('[aria-label="Layout area"]')].some(visible),
           };
         })()`,
      );
      const label = `panel fit (${size}, ${area})`;
      if (m.pageOverflow) failures.push(`${label}: the page scrolls sideways`);
      for (const node of m.header)
        failures.push(`${label}: ${node} overflows the header`);
      for (const node of m.card)
        failures.push(`${label}: ${node} overflows the card`);
      for (const text of m.ellipsized)
        failures.push(`${label}: ${text} is ellipsized`);
      const railExpected = size === "normal";
      if (m.rail !== railExpected || m.select === railExpected)
        failures.push(`${label}: rail ${m.rail}, select ${m.select}`);
      if (size === "narrow") break;
    }
    await checkGuideFocus(client, size);
  }
  await setViewport(client, VIEWPORT);
}

/**
 * A setup guide hands focus back to its step's target on Escape and on its
 * dismiss button, through `focusGuideTarget`. The Layout page's target holds
 * both the phone select and the desktop rail, so the control it lands on must
 * be the one this width draws, and on a desktop the PICKED area's tab.
 */
async function checkGuideFocus(client, size) {
  await evaluate(client, "window.__layoutCanvasProbe.reset()");
  if (size === "narrow") {
    await pickFromSelect(client, "Layout area", "Chat");
  } else {
    // Pressed twice: the second press moves no focus, which leaves Radix's
    // tab list treating its next focus as a click's and keeping it itself.
    const point = await evaluate(
      client,
      `(() => { const r = [...document.querySelectorAll(${JSON.stringify(AREA_TAB)})].find((node) => ${AREA_NAME}(node) === 'Chat').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
    );
    await clickPoint(client, point);
    await clickPoint(client, point);
  }
  await evaluate(client, "document.activeElement?.blur()");
  const moved = await evaluate(
    client,
    `window.__layoutCanvasProbe.focusGuideTarget('[data-layout-areas]')`,
  );
  const focused = await evaluate(
    client,
    `(() => {
       const node = document.activeElement;
       if (node?.matches(${JSON.stringify(AREA_TAB)})) return 'tab ' + ${AREA_NAME}(node) + ' ' + node.getAttribute('aria-selected');
       if (node?.matches('[role="combobox"]')) return 'select ' + node.getAttribute('aria-label');
       return node?.tagName + ' role=' + node?.getAttribute('role') + ' label=' + node?.getAttribute('aria-label');
     })()`,
  );
  const expected = size === "narrow" ? "select Layout area" : "tab Chat true";
  if (!moved || focused !== expected)
    failures.push(
      `guide focus (${size}): expected ${expected}, got ${focused} (reported ${moved})`,
    );
}

/**
 * The desktop Settings modal in a wide, short window (review H2 #2): the rail
 * is taller than the card leaves it, so it scrolls, and every area can be
 * wheeled or scrolled into view and picked with the pointer. Its rows keep
 * their height rather than squeezing to fit.
 */
async function checkShortPane(client, origin) {
  await setViewport(client, { width: 1440, height: 450 });
  await loadFixture(
    client,
    `${origin}${FIXTURE_PATH}?${PAGE_QUERY}&panel=layout`,
    "[data-settings-panel-shell]",
  );
  // The modal's pane is 80vh less the frame's title bar (about 45px); the
  // fixture's pane fills the window, so it is cut to that.
  await evaluate(
    client,
    "document.querySelector('[data-fixture-settings-pane]').style.height = 'calc(80vh - 45px)'",
  );
  await settle(client);
  const RAIL = `document.querySelector('[data-fixture-settings-pane] [role="tablist"][aria-label="Layout areas"]')`;
  const shape = await evaluate(
    client,
    `(() => {
       const rail = ${RAIL};
       const heights = [...rail.querySelectorAll('[role="tab"]')].map((tab) => Math.round(tab.getBoundingClientRect().height));
       return { room: rail.parentElement.clientHeight, content: rail.scrollHeight, heights };
     })()`,
  );
  if (shape.content <= shape.room)
    failures.push(
      `short pane: the rail fits (${shape.content} in ${shape.room}), so this case proves nothing`,
    );
  if (new Set(shape.heights).size !== 1 || shape.heights[0] < 28)
    failures.push(
      `short pane: the rows are squeezed: ${JSON.stringify(shape.heights)}`,
    );

  // A wheel over the rail brings the last area into view.
  const center = await evaluate(
    client,
    `(() => { const r = ${RAIL}.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
  );
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    ...center,
    deltaX: 0,
    deltaY: 600,
  });
  await settle(client);
  const INSIDE = `((tab) => {
    const card = document.querySelector('[data-settings-panel-body]').getBoundingClientRect();
    const rail = ${RAIL}.getBoundingClientRect();
    const r = tab.getBoundingClientRect();
    const within = (box) => r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5;
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('[role="tab"]');
    return within(card) && within(rail) && hit === tab;
  })`;
  const lastShown = await evaluate(
    client,
    `${INSIDE}([...${RAIL}.querySelectorAll('[role="tab"]')].at(-1))`,
  );
  if (!lastShown)
    failures.push(
      "short pane: a wheel over the rail does not bring Status bar into view",
    );

  for (const label of TABS) {
    const point = await evaluate(
      client,
      `(() => {
         const tab = [...${RAIL}.querySelectorAll('[role="tab"]')].find((node) => ${AREA_NAME}(node) === ${JSON.stringify(label)});
         tab.scrollIntoView({ block: 'nearest' });
         if (!${INSIDE}(tab)) return null;
         const r = tab.getBoundingClientRect();
         return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
       })()`,
    );
    if (point === null) {
      failures.push(`short pane: ${label} cannot be scrolled into view`);
      continue;
    }
    await clickPoint(client, point);
    const panel = await evaluate(
      client,
      `${PANEL}?.getAttribute('aria-label') ?? null`,
    );
    if (panel !== label)
      failures.push(`short pane: clicking ${label} shows ${panel}`);
  }
  await screenshotPage(client, "short-pane-status-bar");
  await setViewport(client, VIEWPORT);
}

/**
 * Below `md` the rail is a select (review H2 #4), operated as a person
 * would: opened, an item picked. On Layout the pick shows its area, and a
 * changed area says so in the trigger and in its option, before the changed
 * row's ↺ and not after. On Providers the same component picks the provider it names.
 */
async function checkNarrowSelectors(client, origin) {
  const [, narrow] = SHOT_SIZES.find(([size]) => size === "narrow");
  await setViewport(client, narrow);
  await loadFixture(
    client,
    `${origin}${FIXTURE_PATH}?${PAGE_QUERY}&panel=layout`,
    "[data-settings-panel-shell]",
  );
  await evaluate(client, "window.__layoutCanvasProbe.reset()");
  const changedOptions = async () => {
    await openSelect(client, "Layout area");
    const names = await evaluate(
      client,
      `[...document.querySelectorAll('[data-slot="select-positioner"]:not([hidden]) [role="listbox"] [role="option"]')].filter((node) => node.textContent.includes(', changed') && node.querySelector('[data-testid="area-changed-dot"]') !== null).map((node) => node.querySelector('.truncate').textContent.trim())`,
    );
    await screenshotPage(client, `narrow-select-open-${names.length}`);
    await closeSelect(client);
    return names;
  };
  const baseline = await changedOptions();
  if (baseline.includes("Chat"))
    failures.push("narrow select: Chat is marked before any edit");
  const read = () =>
    evaluate(
      client,
      `(() => {
         const trigger = ${SELECT_TRIGGER("Layout area")};
         return {
           label: trigger?.querySelector('.truncate')?.textContent.trim() ?? null,
           dot: trigger?.querySelector('[data-testid="area-changed-dot"]') !== null,
           said: trigger?.textContent.includes(', changed') ?? false,
           panel: ${PANEL}?.getAttribute('aria-label') ?? null,
         };
       })()`,
    );
  const expect = (label, want, got) => {
    if (JSON.stringify(got) !== JSON.stringify(want))
      failures.push(
        `narrow select, ${label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`,
      );
  };
  await pickFromSelect(client, "Layout area", "Chat");
  expect(
    "picked Chat",
    { label: "Chat", dot: false, said: false, panel: "Chat" },
    await read(),
  );
  if (
    (await operateAndWait(client, "minimap Minimap display: Hidden")) !== true
  )
    failures.push("narrow select: hiding the minimap stored nothing");
  expect(
    "Chat changed",
    { label: "Chat", dot: true, said: true, panel: "Chat" },
    await read(),
  );
  // The open list says which areas changed, in words as well as the dot.
  expect(
    "changed options",
    [...baseline, "Chat"].sort(),
    (await changedOptions()).sort(),
  );
  await revertRowByKeyboard(client, "Minimap", "Chat", "narrow-revert-minimap");
  expect(
    "after the Minimap ↺",
    { label: "Chat", dot: false, said: false, panel: "Chat" },
    await read(),
  );
  expect("options after the Minimap ↺", baseline, await changedOptions());

  await loadFixture(
    client,
    `${origin}${FIXTURE_PATH}?${PAGE_QUERY}&panel=providers`,
    "[data-settings-panel-shell]",
  );
  await waitFor(
    client,
    "the provider select",
    `${SELECT_TRIGGER("Provider")} !== null`,
  );
  const current = await evaluate(
    client,
    `${SELECT_TRIGGER("Provider")}.querySelector('.truncate').textContent.trim()`,
  );
  await openSelect(client, "Provider");
  const optionNames = await evaluate(
    client,
    `[...document.querySelectorAll('[data-slot="select-positioner"]:not([hidden]) [role="listbox"] [role="option"] .truncate')].map((node) => node.textContent.trim())`,
  );
  const next = optionNames.find((name) => name !== current) ?? null;
  await closeSelect(client);
  if (next === null) {
    failures.push("narrow select, Providers: only one provider to pick");
  } else {
    await pickFromSelect(client, "Provider", next);
    const shown = await evaluate(
      client,
      `(() => {
         const visible = (node) => node.getClientRects().length > 0;
         return {
           label: ${SELECT_TRIGGER("Provider")}.querySelector('.truncate').textContent.trim(),
           title: [...document.querySelectorAll('[data-settings-panel-body] div.font-medium.text-foreground')].filter(visible).map((node) => node.textContent.trim())[0] ?? null,
         };
       })()`,
    );
    expect(`Providers picked ${next}`, { label: next, title: next }, shown);
  }
  await setViewport(client, VIEWPORT);
}

/**
 * Every chevron opens something with content; a row that opens nothing has
 * no chevron (the G6 empty collapsibles).
 */
async function checkDisclosures(client) {
  for (const label of TABS.slice(1)) {
    await clickTab(client, label);
    const rows = await evaluate(
      client,
      `[...document.querySelectorAll('[data-fixture-settings-pane] [role="tabpanel"]:not([hidden]) [data-sortable-id]')].map((row) => ({
         id: row.getAttribute('data-sortable-id'),
         discloses: row.querySelector(':scope > [data-row-line] [aria-expanded]') !== null,
       }))`,
    );
    for (const row of rows) {
      if (!row.discloses) continue;
      const detail = await evaluate(
        client,
        `(async () => {
           const row = document.querySelector('[data-fixture-settings-pane] [data-sortable-id="${row.id}"]');
           const grab = row.querySelector(':scope > [data-row-line] [aria-expanded]');
           if (grab.getAttribute('aria-expanded') !== 'true') grab.click();
           await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
           const detail = row.querySelector(':scope > [data-sortable-detail]');
           const text = detail === null ? '' : detail.innerText.trim();
           grab.click();
           return text;
         })()`,
      );
      if (detail.length === 0) {
        failures.push(
          `${label}: row ${row.id} has a chevron that opens nothing`,
        );
      }
    }
    console.log(
      `${label}: ${rows.filter((row) => row.discloses).length} of ${rows.length} rows disclose`,
    );
  }
}

/**
 * Operates every control on every tab, one at a time from the shipped layout,
 * and reports for each whether the app column rendered differently after it.
 */
async function operateEverySetting(client) {
  const results = [];
  const plans = [];
  for (const label of TABS) {
    await resetTo(client, label, []);
    for (const control of await listControls(client))
      plans.push({ tab: label, steps: [], control });
  }
  for (const setup of SETUPS) {
    await resetTo(client, setup.tab, []);
    const base = new Set(await listControls(client));
    await resetTo(client, setup.tab, setup.steps);
    const revealed = (await listControls(client)).filter(
      (control) => !base.has(control),
    );
    if (revealed.length === 0)
      failures.push(`setup ${setup.steps.join(" + ")} revealed no control`);
    for (const control of revealed)
      plans.push({ tab: setup.tab, steps: setup.steps, control });
  }
  for (const plan of plans) {
    await resetTo(client, plan.tab, plan.steps);
    const prerequisite = PREREQUISITES.find((entry) =>
      entry.control.test(plan.control),
    );
    if (prerequisite !== undefined)
      await operateAndWait(client, prerequisite.first);
    const before = await stableSignature(client);
    const operated = await operateAndWait(client, plan.control);
    const name = `${plan.tab} ▸ ${[...plan.steps, plan.control].join(" ▸ ")}`;
    if (operated === null) {
      failures.push(`planned control could not be operated: ${name}`);
      continue;
    }
    const after = await stableSignature(client);
    results.push([name, before !== after, operated]);
  }
  await evaluate(client, "window.__layoutCanvasProbe.reset()");
  await settle(client);
  return results;
}

/** Back to the shipped layout on `tab`, every row open, then `steps` operated. */
async function resetTo(client, tabLabel, steps) {
  if (!(await evaluate(client, "window.__layoutCanvasProbe !== undefined"))) {
    throw new Error(`the fixture unloaded before ${tabLabel}`);
  }
  await evaluate(client, "window.__layoutCanvasProbe.reset()");
  await settle(client);
  await clickTab(client, tabLabel);
  await openAllDisclosures(client);
  for (const step of steps) {
    if ((await operateAndWait(client, step)) === null)
      failures.push(`setup step could not be operated: ${step}`);
    await openAllDisclosures(client);
  }
}

/**
 * Operates `name` and waits for what it writes to land: the stored layout
 * changing, then the page holding still. Answers whether anything was stored,
 * or `null` when the control is not on the page.
 */
async function operateAndWait(client, name) {
  const storedBefore = await evaluate(client, STORED);
  if (!(await operate(client, name))) return null;
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if ((await evaluate(client, STORED)) !== storedBefore) break;
    await settle(client);
  }
  await stableSignature(client);
  return (await evaluate(client, STORED)) !== storedBefore;
}

/**
 * Choose... starts from what Automatic draws: for each provider the fixture
 * signs in, the stored picks are exactly the window its reading drew.
 */
async function checkChooseSeedsSelection(client) {
  for (const providerId of ["codex", "claude-code"]) {
    await resetTo(client, "Usage and resources", []);
    const drawn = await evaluate(
      client,
      `[...document.querySelectorAll('[data-testid="status-bar-provider-segment-${providerId}"] [data-window-key]')]
         .filter((node) => node.closest('[data-fixture-settings-pane]') === null)
         .map((node) => node.getAttribute('data-window-key'))`,
    );
    if (drawn.length === 0) {
      failures.push(`Choose: ${providerId} draws no window to seed from`);
      continue;
    }
    if (
      (await operateAndWait(client, `${providerId} Limits: Choose...`)) === null
    ) {
      failures.push(`Choose: ${providerId} has no Choose... option`);
      continue;
    }
    const stored = await evaluate(
      client,
      `window.__layoutCanvasProbe.snapshot().arrangement.providerLimits[${JSON.stringify(providerId)}]?.limitKeys ?? null`,
    );
    if (JSON.stringify(stored) !== JSON.stringify([drawn[0]])) {
      failures.push(
        `Choose: ${providerId} stored ${JSON.stringify(stored)}, expected the drawn ${JSON.stringify([drawn[0]])}`,
      );
    }
  }
  await evaluate(client, "window.__layoutCanvasProbe.reset()");
}

/**
 * Header readings take a bounded share of the header and never push its
 * controls out: a 900px app column, both readings in the header, and Codex
 * and Claude Code each drawing both their windows. The tabs and every header
 * control stay inside the header, the tabs keep real room, and no reading or
 * label is drawn cut.
 */
async function checkHeaderFit(client) {
  // Both readings where the fixture puts them (usage left, resources right),
  // then both on the right, where they share the cluster beside the header's
  // own controls.
  for (const [label, sides] of [
    ["split", []],
    ["both right", ["usageLimits Usage limits side: Right"]],
  ]) {
    // The settings pane is 36rem, so this leaves the app column 900px wide.
    await setViewport(client, { width: 1476, height: 900 });
    await resetTo(client, "Usage and resources", [
      ...sides,
      "codex Limits: Choose...",
      "claude-code Limits: Choose...",
    ]);
    // One box a pass: a click re-renders the row it sits in.
    for (let pass = 0; pass < 8; pass += 1) {
      const clicked = await evaluate(
        client,
        `(() => {
           for (const id of ["codex", "claude-code"]) {
             const row = document.querySelector('[data-fixture-settings-pane] [data-sortable-id="' + id + '"]');
             const box = row?.querySelector('[role="checkbox"][aria-checked="false"]');
             if (box) { box.click(); return true; }
           }
           return false;
         })()`,
      );
      if (!clicked) break;
      await settle(client);
    }
    await stableSignature(client);
    const windows = await evaluate(
      client,
      `Object.values(window.__layoutCanvasProbe.snapshot().arrangement.providerLimits).reduce((sum, entry) => sum + entry.limitKeys.length, 0)`,
    );
    if (windows < 4)
      failures.push(`header fit (${label}): only ${windows} windows selected`);
    const m = await evaluate(client, HEADER_FIT_PROBE);
    if (m === null) {
      failures.push(`header fit (${label}): no app header`);
    } else {
      for (const node of m.outside)
        failures.push(`header fit (${label}): ${node} leaves the header`);
      if (m.tabs === null || m.tabs < m.header * 0.25) {
        failures.push(
          `header fit (${label}): the tab strip keeps ${m.tabs}px of a ${m.header}px header`,
        );
      }
      for (const reading of m.cut)
        failures.push(`header fit (${label}): a reading is cut: ${reading}`);
      for (const text of m.ellipsized)
        failures.push(
          `header fit (${label}): a control draws ellipsized text: ${text}`,
        );
      console.log(
        `header fit (${label}): tabs ${m.tabs}px of ${m.header}px; readings shown ${JSON.stringify(m.shown)}`,
      );
    }
    await screenshotPage(client, `header-fit-900-${slug(label)}`);
  }
  await setViewport(client, VIEWPORT);
  await evaluate(client, "window.__layoutCanvasProbe.reset()");
}

async function setViewport(client, size) {
  viewport = size;
  await client.send("Emulation.setDeviceMetricsOverride", {
    ...size,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await settle(client);
}

/**
 * G7 and L-174: the monitor's Shown drives the tab strip's resource reading
 * and nothing else; "Readings on agent rows" (a Sidebar row) decides whether
 * the agent row prints; and WHICH readings it prints is the monitor's own
 * Metrics choice, which stays editable while the monitor is Hidden as long as
 * the rows print. The Sidebar row's "Choose metrics" opens that choice.
 */
async function checkAgentRows(client) {
  await evaluate(client, "window.__layoutCanvasProbe.reset()");
  await clickTab(client, "Usage and resources");
  await openAllDisclosures(client);
  await settle(client);
  const read = () =>
    evaluate(
      client,
      `({
         row: document.querySelector('[data-fixture-agent-row]')?.innerText.replace(/\\s+/g, ' ').trim() ?? null,
         monitor: [...document.querySelectorAll('[data-layout-region="resourceMonitor"]')].some(
           (node) => node.closest('[data-fixture-settings-pane]') === null && [node, ...node.children].some((part) => part.getClientRects().length > 0),
         ),
       })`,
    );
  // Whether the Metrics checks can be operated right now.
  const metricsLive = () =>
    evaluate(
      client,
      `(() => {
         const box = [...${PANEL}.querySelectorAll('[role="checkbox"]')].find((node) => node.closest('label')?.textContent.trim() === 'Memory');
         return box === undefined ? null : !box.disabled && box.closest('fieldset:disabled') === null;
       })()`,
    );
  const start = await read();
  if (start.row === null || !/472/.test(start.row)) {
    failures.push(
      `G7: agent row has no memory reading at rest: ${JSON.stringify(start)}`,
    );
  }
  if (!start.monitor)
    failures.push(`G7: no resource monitor at rest: ${JSON.stringify(start)}`);
  await screenshotPage(client, "g7-1-both-on");

  await mustOperate(client, "resourceMonitor Resource monitor display: Hidden");
  await settle(client);
  const monitorOff = await read();
  if (monitorOff.monitor)
    failures.push("G7: hiding the monitor left it in the tab strip");
  if (monitorOff.row !== start.row) {
    failures.push(
      `G7: hiding the monitor changed the agent row: ${JSON.stringify(monitorOff)}`,
    );
  }
  if ((await metricsLive()) !== true)
    failures.push("L-174: Metrics locked while Hidden with agent rows on");
  await screenshotRow(client, "g7-2-monitor-off-rows-on", "Metrics");

  // One source of truth: unticking Memory under the Hidden monitor takes the
  // memory reading off the agent row.
  await mustOperate(client, "resourceMonitor check Memory");
  await settle(client);
  const noMemory = await read();
  if (noMemory.row === null || /472/.test(noMemory.row)) {
    failures.push(
      `L-174: unticking Memory left it on the agent row: ${JSON.stringify(noMemory)}`,
    );
  }
  await mustOperate(client, "resourceMonitor check Memory");
  await settle(client);
  await screenshotRow(client, "g7-3-metrics-edited-while-hidden", "Metrics");

  await clickTab(client, "Sidebar");
  await mustOperate(client, "- Readings on agent rows");
  await settle(client);
  const bothOff = await read();
  if (bothOff.row === null || /472/.test(bothOff.row)) {
    failures.push(
      `G7: the agent rows switch did not remove the row reading: ${JSON.stringify(bothOff)}`,
    );
  }
  await screenshotRow(client, "g7-4-both-off", "Readings on agent rows");

  // "Choose metrics" lands on the monitor's row in its own area.
  await evaluate(client, "window.__layoutCanvasProbe.openSettingsApi()");
  const chose = await evaluate(
    client,
    `(() => {
       const link = [...${PANEL}.querySelectorAll('button')].find((node) => node.textContent.trim() === 'Choose metrics');
       if (link === undefined) return false;
       link.click();
       return true;
     })()`,
  );
  await settle(client);
  const landed = await poll(
    client,
    `${PANEL}?.getAttribute('aria-label') === 'Usage and resources' && ${PANEL}.querySelector('[data-sortable-id="resourceMonitor"] [aria-expanded="true"]') !== null`,
  );
  if (!chose || !landed)
    failures.push(
      "L-174: Choose metrics did not open the Resource monitor row",
    );
  if ((await metricsLive()) !== false)
    failures.push("L-174: Metrics editable while Hidden with agent rows off");
  await screenshotRow(client, "g7-5-choose-metrics-landing", "Metrics");

  await mustOperate(client, "resourceMonitor Resource monitor display: Shown");
  await settle(client);
  const monitorOn = await read();
  if (!monitorOn.monitor)
    failures.push("G7: showing the monitor did not bring it back");
  if (monitorOn.row !== bothOff.row) {
    failures.push(
      `G7: showing the monitor brought the row reading back: ${JSON.stringify(monitorOn)}`,
    );
  }
  await screenshotPage(client, "g7-6-monitor-on-rows-off");
  await evaluate(client, "window.__layoutCanvasProbe.reset()");
}

async function checkErrors(client, label) {
  const errors = await evaluate(client, "window.__layoutCanvasErrors ?? []");
  for (const error of errors)
    failures.push(`${label}: page error: ${error.split("\n")[0]}`);
  await evaluate(
    client,
    "window.__layoutCanvasErrors && (window.__layoutCanvasErrors.length = 0)",
  );
}

// --- the panel --------------------------------------------------------------

async function clickTab(client, label) {
  const found = await evaluate(
    client,
    `(() => {
       const tab = [...document.querySelectorAll(${JSON.stringify(AREA_TAB)})]
         .find((node) => ${AREA_NAME}(node) === ${JSON.stringify(label)});
       if (tab === undefined) return false;
       tab.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
       tab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
       tab.click();
       return tab.getAttribute('aria-selected');
     })()`,
  );
  await settle(client);
  const selected = await evaluate(
    client,
    `[...document.querySelectorAll(${JSON.stringify(AREA_TAB)})].find((node) => ${AREA_NAME}(node) === ${JSON.stringify(label)})?.getAttribute('aria-selected')`,
  );
  if (found === false || selected !== "true")
    failures.push(`tab ${label} could not be selected`);
}

/**
 * A row's ↺ by keyboard, the only per-setting reset since T1 retired the
 * area Resets: Enter puts the row back, the ↺ goes with the change, and focus
 * stays in the area's panel rather than falling to the page.
 */
async function revertRowByKeyboard(client, rowName, areaLabel, shot) {
  const REVERT = `${PANEL}?.querySelector('button[aria-label="Revert ${rowName}"]')`;
  const focused = await evaluate(
    client,
    `(() => { const revert = ${REVERT}; revert?.focus(); return revert != null && document.activeElement === revert; })()`,
  );
  if (!focused) {
    failures.push(`revert ${rowName}: no ↺ to focus`);
    return;
  }
  await screenshotPage(client, shot);
  await press(client, "Enter");
  const landed = await poll(
    client,
    `${REVERT} == null && ${PANEL}?.contains(document.activeElement) === true && ${PANEL}.getAttribute('aria-label') === ${JSON.stringify(areaLabel)}`,
  );
  if (!landed)
    failures.push(
      `revert ${rowName}: after Enter, not in the ${areaLabel} panel (${await describeFocus(client)})`,
    );
}

/** Where focus is, and whether a dialog or a list is open, for a failure. */
function describeFocus(client) {
  return evaluate(
    client,
    `(() => {
       const node = document.activeElement;
       const name = node?.getAttribute('aria-label') ?? node?.textContent.trim().slice(0, 30) ?? 'none';
       return 'focus ' + node?.tagName + ' "' + name + '" role=' + node?.getAttribute('role') + ', dialog ' + (document.querySelector('[role="dialog"]') !== null) + ', listbox ' + (document.querySelector('[data-slot="select-positioner"]:not([hidden]) [role="listbox"]') !== null);
     })()`,
  );
}

/** Opens the select named `label` with the pointer, as a person would. */
async function openSelect(client, label) {
  const point = await evaluate(
    client,
    `(() => { const r = ${SELECT_TRIGGER(label)}.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
  );
  await clickPoint(client, point);
  if (
    !(await poll(
      client,
      `document.querySelector('[data-slot="select-positioner"]:not([hidden]) [role="listbox"]') !== null`,
    ))
  )
    failures.push(`select ${label} does not open`);
}

/** Opens the select named `label` and picks its option `option`, by pointer. */
async function pickFromSelect(client, label, option) {
  await openSelect(client, label);
  // Matched here, not in the page, so no page text is spliced into code.
  const options = await evaluate(
    client,
    `[...document.querySelectorAll('[data-slot="select-positioner"]:not([hidden]) [role="listbox"] [role="option"]')].map((node) => {
       const r = node.getBoundingClientRect();
       return { name: node.querySelector('.truncate')?.textContent.trim() ?? null, x: r.left + r.width / 2, y: r.top + r.height / 2 };
     })`,
  );
  const point = options.find((candidate) => candidate.name === option) ?? null;
  if (point === null) {
    failures.push(`select ${label} has no option ${option}`);
    return;
  }
  await clickPoint(client, point);
  if (!(await poll(client, SELECT_CLOSED)))
    failures.push(`select ${label}: picking ${option} leaves it open`);
  await settle(client);
}

/** Closes the open select list with Escape. */
async function closeSelect(client) {
  await press(client, "Escape");
  if (!(await poll(client, SELECT_CLOSED)))
    failures.push("Escape leaves a select list open");
}

/** A real left click at a point: move, press, release. */
async function clickPoint(client, point) {
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    ...point,
  });
  for (const type of ["mousePressed", "mouseReleased"]) {
    await client.send("Input.dispatchMouseEvent", {
      type,
      ...point,
      button: "left",
      clickCount: 1,
    });
  }
  await settle(client);
}

/** Polls `expression` for up to three seconds; whether it came true. */
async function poll(client, expression) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (await evaluate(client, expression)) return true;
    await delay(50);
  }
  return false;
}

async function openAllDisclosures(client) {
  await evaluate(
    client,
    `${PANEL}.querySelectorAll('[data-sortable-id] > [data-row-line] [aria-expanded="false"]').forEach((grab) => grab.click())`,
  );
  await settle(client);
}

async function listControls(client) {
  return evaluate(client, `${CONTROLS}.map((entry) => entry.key)`);
}

async function mustOperate(client, name) {
  if (!(await operate(client, name)))
    failures.push(`control not found: ${name}`);
}

/** Operates the control named `name`; false when the tab no longer has it. */
async function operate(client, name) {
  const kind = await evaluate(
    client,
    `(() => {
       const entry = ${CONTROLS}.find((candidate) => candidate.key === ${JSON.stringify(name)});
       if (entry === undefined) return null;
       if (entry.order) {
         entry.node.focus();
         return document.activeElement === entry.node ? entry.order : null;
       }
       entry.node.click();
       return 'click';
     })()`,
  );
  if (kind === "ArrowDown" || kind === "ArrowUp") await key(client, kind, 1);
  return kind !== null;
}

/** One key, unmodified, to whatever holds focus. */
async function press(client, name) {
  const codes = { Enter: 13, Escape: 27 };
  // Enter activates a button through its character, which only `keyDown`
  // with text carries.
  const down =
    name === "Enter" ? { type: "keyDown", text: "\r" } : { type: "rawKeyDown" };
  for (const event of [down, { type: "keyUp" }]) {
    await client.send("Input.dispatchKeyEvent", {
      ...event,
      key: name,
      code: name,
      windowsVirtualKeyCode: codes[name],
    });
  }
}

/** Alt+<key>: the sortable list's nudge, which commits at once (L-31). */
async function key(client, name, modifiers) {
  const code = name;
  for (const type of ["rawKeyDown", "keyUp"]) {
    await client.send("Input.dispatchKeyEvent", {
      type,
      key: name,
      code,
      windowsVirtualKeyCode: name === "ArrowDown" ? 40 : 38,
      modifiers,
    });
  }
}

// --- the app column ---------------------------------------------------------

/**
 * What the app column renders, as one string: every sibling of the settings
 * pane, with the attributes that move on their own (motion styles, ids React
 * mints) left out, so the only thing that can change it is a setting.
 */
function appSignature(client) {
  return evaluate(
    client,
    `(() => {
       const pane = document.querySelector('[data-fixture-settings-pane]');
       const root = pane.parentElement.closest('#root') ?? document.body;
       const clone = root.cloneNode(true);
       clone.querySelector('[data-fixture-settings-pane]')?.remove();
       for (const node of clone.querySelectorAll('*')) {
         for (const name of ['id', 'aria-labelledby', 'aria-describedby', 'aria-controls', 'style', 'data-state', 'data-open', 'data-closed', 'data-starting-style', 'data-popup-open']) {
           node.removeAttribute(name);
         }
       }
       return clone.innerHTML;
     })()`,
  );
}

/** A signature that holds still across two frames: nothing mid-transition. */
async function stableSignature(client) {
  let previous = await appSignature(client);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await delay(60);
    const next = await appSignature(client);
    if (next === previous) return next;
    previous = next;
  }
  return previous;
}

// --- evidence ---------------------------------------------------------------

async function screenshotPane(client, name) {
  if (outDir === null) return;
  const clip = await evaluate(
    client,
    `(() => {
       const box = document.querySelector('[data-fixture-settings-pane]').getBoundingClientRect();
       return { x: box.left, y: box.top, width: box.width, height: box.height };
     })()`,
  );
  const shot = await client.send("Page.captureScreenshot", {
    format: "png",
    clip: { ...clip, scale: 1 },
  });
  await writeFile(
    path.join(outDir, `${name}.png`),
    Buffer.from(shot.data, "base64"),
  );
}

async function screenshotPage(client, name) {
  if (outDir === null) return;
  const shot = await client.send("Page.captureScreenshot", { format: "png" });
  await writeFile(
    path.join(outDir, `${name}.png`),
    Buffer.from(shot.data, "base64"),
  );
}

/**
 * A G7 step's evidence: the settings row whose label is `label` scrolled to
 * the middle of its pane, in both themes, so the row and the agent row it
 * drives are in one frame.
 */
async function screenshotRow(client, name, label) {
  if (outDir === null) return;
  await evaluate(
    client,
    `[...${PANEL}.querySelectorAll('[data-layout-form-row]')].find((row) => row.textContent.includes(${JSON.stringify(label)}))?.scrollIntoView({ block: 'center' })`,
  );
  for (const theme of ["dark", "light"]) {
    await evaluate(
      client,
      `window.__layoutCanvasProbe.setTheme(${JSON.stringify(theme)})`,
    );
    await settle(client);
    await screenshotPage(client, `${name}-${theme}`);
  }
  await evaluate(client, `window.__layoutCanvasProbe.setTheme("dark")`);
}

function slug(label) {
  return label.toLowerCase().replace(/\W+/g, "-");
}

// --- plumbing ---------------------------------------------------------------

/**
 * This run's own Vite: file watching off and its own dependency cache, through
 * a wrapper config around the shared one. The tree is shared with other agents,
 * so a watcher reloads the page on a peer's save, and a shared `.vite` cache is
 * rewritten under the run by a peer driver's `--force`, after which the page's
 * next lazy import answers 504 and Vite reloads it mid-check.
 */
async function spawnVite(port) {
  const configDir = await mkdtemp(path.join(tmpdir(), "layout-settings-vite-"));
  const configPath = path.join(configDir, "vite.isolated.config.mjs");
  await writeFile(
    configPath,
    [
      `import base from ${JSON.stringify(path.join(projectRoot, "vitest.config.ts"))};`,
      `export default { ...base, cacheDir: ${JSON.stringify(path.join(configDir, "cache"))}, server: { ...base.server, watch: null } };`,
      "",
    ].join("\n"),
  );
  const requireFromHere = createRequire(import.meta.url);
  const viteManifestPath = requireFromHere.resolve("vite/package.json");
  const viteManifest = requireFromHere(viteManifestPath);
  const viteEntry = path.resolve(
    path.dirname(viteManifestPath),
    viteManifest.bin.vite,
  );
  const child = spawn(
    "node",
    [
      viteEntry,
      "--config",
      configPath,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    { cwd: projectRoot, stdio: ["ignore", "ignore", "pipe"] },
  );
  child.once("exit", () => {
    void rm(configDir, { recursive: true, force: true });
  });
  return child;
}

async function navigate(client, url) {
  try {
    await evaluate(client, "window.__probeStaleDocument = true");
  } catch (error) {
    if (!isNavigationContextError(error)) throw error;
  }
  await client.send("Page.navigate", { url });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (client.crashed())
      throw new Error(`The renderer was killed while navigating to ${url}`);
    try {
      const ready = await evaluate(
        client,
        `window.__probeStaleDocument !== true && document.readyState === "complete"`,
      );
      if (ready) return;
    } catch (error) {
      if (!isNavigationContextError(error)) throw error;
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for the navigation to ${url}`);
}

function isNavigationContextError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /context was destroyed|Cannot find context|Inspected target navigated/i.test(
    message,
  );
}

function settle(client) {
  return evaluate(
    client,
    `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50))))`,
  );
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createTcpServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port =
        typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHttp(url, child, readError, label) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`${label} exited early: ${readError()}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await delay(150);
  }
  throw new Error(`${label} did not become reachable: ${readError()}`);
}

async function evaluate(client, expression) {
  const response = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails !== undefined) {
    throw new Error(
      response.exceptionDetails.exception?.description ??
        response.exceptionDetails.text ??
        "Browser evaluation failed",
    );
  }
  return response.result.value;
}

async function waitFor(client, label, expression) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (client.crashed())
      throw new Error(`The renderer was killed while waiting for ${label}`);
    if (await evaluate(client, expression)) return;
    await delay(100);
  }
  const pageState = await evaluate(
    client,
    `({ rootEmpty: (document.getElementById("root")?.childElementCount ?? 0) === 0, errors: window.__layoutCanvasErrors ?? [], text: document.body.innerText.slice(0, 2000) })`,
  );
  pageState.exceptions = pageExceptions.slice(-10);
  throw new Error(
    `Timed out waiting for ${label}:\n${JSON.stringify(pageState, null, 2)}`,
  );
}
