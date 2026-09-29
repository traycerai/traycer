// Real-Chrome MEASUREMENT (not assertion) for D16's ContextMenu modal
// question: Base's ContextMenu forces `modal: true` internally with no
// supported opt-out, while `landing-terminal-tab-strip.tsx` used Radix's
// `modal={false}` before this migration and has since dropped the prop
// entirely. This script records what actually happens for 5 named
// interactions against four real (or shape-faithful) row families, and
// writes a JSON report. It asserts nothing about what the "right" answer is
// - it is meant to be run once against a HEAD (Radix) checkout of the same
// fixture file and once against the current (Base) tree, then diffed.
//
// Structure follows `context-menu-rename-focus-steal-browser-regression.mjs`.
// Not wired into `scripts/run-tests.ts` - run it directly:
//   bun run scripts/context-menu-row-interaction-parity-browser.mjs
import { writeFile, readFile, mkdtemp } from "node:fs/promises";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer as createTcpServer } from "node:net";
import path from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  findChrome,
  launchChromeWithDevTools,
  terminateProcessTree,
} from "./chrome-launcher.mjs";
import { connectCdp } from "./cdp-client.mjs";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const chromePath = await findChrome(
  "the context-menu row-interaction parity measurement",
);
const vitePort = await freePort();
let chrome;
let chromeProfilePath;
let client;
let viteProcess;

// `rowExpr`/`scrollContainerExpr` are JS EXPRESSIONS (evaluated directly,
// not passed through `document.querySelector`), since file-tree's rows live
// inside a real shadow root - `document.querySelector` cannot pierce it, so
// that family's rows are reached via `...shadowHost.shadowRoot.querySelector`
// instead. `landing-tabstrip` renders through the REAL, unmodified
// `LandingTerminalTabStrip` (its own `data-testid`); `header-tabstrip`/
// `sidebar-row` are this fixture's own light-DOM rows. Every family renders
// 8 rows in a container too small to hold them, so `axis` names which
// scroll offset actually moves.
const ROW_IDS = ["a", "b", "c", "d", "e", "f", "g", "h"];
const testIdExpr = (testId) =>
  `document.querySelector('[data-testid="${testId}"]')`;
const FILE_TREE_SHADOW_ROOT_EXPR = `document.querySelector('[data-testid="file-tree-shadow-host"]')?.shadowRoot`;
const FAMILIES = [
  {
    name: "landing-tabstrip",
    rowExpr: (index) => testIdExpr(`landing-terminal-tab-${ROW_IDS[index]}`),
    // The real component nests a flex wrapper before its own scroller
    // (landing-terminal-tab-strip.tsx:106-107); `> div` only reaches the
    // wrapper. The scroller is the wrapper's own `.overflow-x-auto` child.
    scrollContainerExpr: `document.querySelector('[data-testid="landing-terminal-tab-strip"] .overflow-x-auto')`,
    axis: "x",
  },
  {
    name: "header-tabstrip",
    rowExpr: (index) => testIdExpr(`row-${index}`),
    scrollContainerExpr: testIdExpr("row-interaction-strip"),
    axis: "x",
  },
  {
    name: "sidebar-row",
    rowExpr: (index) => testIdExpr(`row-${index}`),
    scrollContainerExpr: testIdExpr("row-interaction-strip"),
    axis: "y",
  },
  {
    name: "file-tree",
    rowExpr: (index) =>
      `${FILE_TREE_SHADOW_ROOT_EXPR}?.querySelector('[data-testid="row-${index}"]')`,
    scrollContainerExpr: testIdExpr("row-interaction-strip"),
    axis: "y",
    // The shadow root only attaches after mount; the generic mount wait
    // below doesn't see into it.
    extraMountReadyExpr: `!!(${FILE_TREE_SHADOW_ROOT_EXPR}?.querySelector('[data-testid="row-0"]'))`,
  },
];

// Base marks an exit with the boolean `data-closed` attribute; Radix (HEAD)
// marked it with the string `data-state="closed"`. Recognizing both lets
// this same driver run unchanged against either checkout. Installed fresh
// after every navigation, since a full-page nav drops prior globals.
const MENU_PROBES_SRC = `
  window.__menuOpen = (el) => {
    if (!el) return false;
    if (el.hasAttribute('data-closed')) return false;
    if (el.getAttribute('data-state') === 'closed') return false;
    return true;
  };
  window.__isPainted = (el) => {
    if (!(el instanceof Element) || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || '1') !== 0;
  };
  window.__openMenuContents = () =>
    [...document.querySelectorAll('[data-slot="context-menu-content"]')]
      .filter((el) => window.__menuOpen(el) && window.__isPainted(el));
`;

const report = { families: {} };

try {
  const pageUrl = new URL(
    "/src/__tests__/browser/context-menu-row-interaction-parity.html",
    `http://127.0.0.1:${vitePort}`,
  );
  const requireFromHere = createRequire(import.meta.url);
  const viteManifestPath = requireFromHere.resolve("vite/package.json");
  const viteManifest = requireFromHere(viteManifestPath);
  const viteEntry = path.resolve(
    path.dirname(viteManifestPath),
    viteManifest.bin.vite,
  );
  viteProcess = spawn(
    "node",
    [
      viteEntry,
      "--config",
      path.join(projectRoot, "vitest.config.ts"),
      "--host",
      "127.0.0.1",
      "--port",
      String(vitePort),
      "--strictPort",
    ],
    { cwd: projectRoot, stdio: ["ignore", "ignore", "pipe"] },
  );
  let viteError = "";
  viteProcess.stderr.setEncoding("utf8");
  viteProcess.stderr.on("data", (chunk) => {
    viteError += chunk;
  });
  await waitForHttp(pageUrl.href, viteProcess, () => viteError, "Vite");

  const launched = await launchChromeWithDevTools(
    chromePath,
    "traycer-row-interaction-parity-",
    // Emulation.setEmulatedMedia alone leaves headless Chrome's real input
    // device model at hover:none/pointer:coarse underneath, so Tailwind's
    // `hover:` utilities (gated on `@media (hover: hover)`) still get no
    // real hover styling even though the media query itself reports
    // matched - these blink-settings force the actual device model.
    [
      "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
    ],
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
  const targetResponse = await fetch(
    new URL(`/json/new?${encodeURIComponent(pageUrl.href)}`, devtoolsUrl),
    { method: "PUT" },
  );
  if (!targetResponse.ok) {
    throw new Error(
      `Chrome could not open the fixture: ${targetResponse.status}`,
    );
  }
  const target = await targetResponse.json();
  client = await connectCdp(target.webSocketDebuggerUrl);
  await client.send("Runtime.enable");
  await client.send("Page.enable");
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: 900,
    height: 700,
    deviceScaleFactor: 1,
    mobile: false,
  });
  // Headless Chrome's default emulated media can report `hover: none` /
  // `pointer: coarse`, which would starve Tailwind v4's `hover:` utilities
  // (gated behind `@media (hover: hover)`) of real styling regardless of
  // what Base or Radix do - forcing desktop-hover capability here is what
  // makes interaction (3)'s hover measurement trustworthy.
  await client.send("Emulation.setEmulatedMedia", {
    features: [
      { name: "hover", value: "hover" },
      { name: "pointer", value: "fine" },
    ],
  });

  for (const family of FAMILIES) {
    report.families[family.name] = await measureFamily(family);
  }

  // Optional: REFERENCE_REPORT points at a previously written report (a
  // HEAD run) - when set, this diffs the requested semantic fields only
  // (never diagnostic outerHTML strings) against a measured reference, no
  // hardcoded approximations. Unset (the default, and always true for the
  // HEAD run that PRODUCES a reference), this stays pure measurement - no
  // comparison, no throw.
  const referenceReportPath = process.env.REFERENCE_REPORT;
  if (referenceReportPath !== undefined) {
    const referenceReport = JSON.parse(
      await readFile(referenceReportPath, "utf8"),
    );
    const mismatches = [];
    for (const family of FAMILIES) {
      const referenceSnapshot = semanticSnapshot(
        referenceReport.families?.[family.name] ?? {},
      );
      const actualSnapshot = semanticSnapshot(report.families[family.name]);
      mismatches.push(
        ...diffSemanticSnapshots(
          family.name,
          referenceSnapshot,
          actualSnapshot,
        ),
      );
    }
    report.comparison = {
      referenceReportPath,
      mismatchCount: mismatches.length,
      mismatches,
    };
  }

  const reportPath =
    process.env.REPORT_OUT ??
    path.join(
      await mkdtemp(path.join(tmpdir(), "context-menu-parity-")),
      "result.json",
    );
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(
    "context-menu row-interaction parity measurement complete:",
    reportPath,
  );
  if (report.comparison !== undefined && report.comparison.mismatchCount > 0) {
    throw new Error(
      `context-menu row-interaction parity: ${report.comparison.mismatchCount} semantic mismatch(es) vs reference ${referenceReportPath} - see the written report's "comparison" field for details`,
    );
  }
} finally {
  client?.close();
  if (chrome !== undefined) {
    await terminateProcessTree(chrome);
  }
  viteProcess?.kill("SIGTERM");
  if (chromeProfilePath !== undefined) {
    await rm(chromeProfilePath, {
      recursive: true,
      force: true,
      maxRetries: 3,
    });
  }
}

/**
 * Extracts only the requested semantic fields from a family's measurement -
 * B ownership/action identity, openCount/distance, wheel scroll, computed
 * hover before/after+pseudo/styleChanged, one-click close/action, after-
 * close rowA/body/shadow focus, landing rename - for the REFERENCE_REPORT
 * comparison below. Deliberately omits every diagnostic string
 * (`outerHTML`, `activeElement`) - those vary on incidental DOM shape
 * (attribute order, whitespace) that carries no semantic meaning.
 */
function semanticSnapshot(result) {
  const snapshot = {};
  if (result.rowBOwnershipAfterOpen) {
    const ownership = result.rowBOwnershipAfterOpen;
    snapshot.rowBOwnership = {
      ownsRowB: ownership.ownsRowB,
      expectedIdentity: ownership.expected ?? ownership.expectedRowId ?? null,
      // Non-landing families name the clicked item via `itemTestId`; landing
      // (the real LandingTerminalTabStrip) has no such attribute on its
      // Close item - its actual recorded action lives in `events`
      // (`close:<rowId>`, pushed by the fixture's own onClose), alongside
      // `clicked` (did a "Close" item even get found to click).
      actualIdentity: ownership.itemTestId ?? null,
      clicked: ownership.clicked ?? null,
      events: ownership.events ?? null,
    };
  }
  if (result.rightClickOtherRowWhileOpen) {
    snapshot.rightClickOtherRowWhileOpen = {
      openCount: result.rightClickOtherRowWhileOpen.openCount,
      distanceFromRightClickPoint:
        result.rightClickOtherRowWhileOpen.distanceFromRightClickPoint,
    };
  }
  if (result.wheelScrollWhileOpen) {
    snapshot.wheelScrollWhileOpen = {
      scrolled: result.wheelScrollWhileOpen.scrolled,
      // The boolean alone hides a real regression (e.g. scrolling a much
      // shorter distance, or the wrong axis) - compare the raw offsets too.
      before: result.wheelScrollWhileOpen.before,
      after: result.wheelScrollWhileOpen.after,
    };
  }
  if (result.hoverOtherRowWhileOpen) {
    const hover = result.hoverOtherRowWhileOpen;
    snapshot.hoverOtherRowWhileOpen = {
      rowMatchesHoverPseudoClass: hover.rowMatchesHoverPseudoClass,
      styleChanged: hover.styleChanged,
      before: hover.before,
      after: hover.after,
    };
  }
  if (result.leftClickOtherRowClosesAndActs) {
    snapshot.leftClickOtherRowClosesAndActs = {
      openCount: result.leftClickOtherRowClosesAndActs.openCount,
      events: result.leftClickOtherRowClosesAndActs.events,
    };
  }
  if (result.focusAfterClose) {
    const focus = result.focusAfterClose;
    snapshot.focusAfterClose = {
      matchesRowA: focus.matchesRowA,
      shadowActiveMatchesRowA: focus.shadowActiveMatchesRowA,
      isBody: focus.isBody,
    };
  }
  if (result.landingRenameKeepsFocus)
    snapshot.landingRenameKeepsFocus = result.landingRenameKeepsFocus;
  return snapshot;
}

/** Field-by-field diff of two semantic snapshots for one family. */
function diffSemanticSnapshots(familyName, reference, actual) {
  const mismatches = [];
  const keys = new Set([
    ...Object.keys(reference ?? {}),
    ...Object.keys(actual ?? {}),
  ]);
  for (const key of keys) {
    const referenceValue = reference?.[key];
    const actualValue = actual?.[key];
    if (JSON.stringify(referenceValue) !== JSON.stringify(actualValue))
      mismatches.push({
        family: familyName,
        field: key,
        reference: referenceValue,
        actual: actualValue,
      });
  }
  return mismatches;
}

async function measureFamily(family) {
  const url = new URL(
    "/src/__tests__/browser/context-menu-row-interaction-parity.html",
    `http://127.0.0.1:${vitePort}`,
  );
  url.searchParams.set("family", family.name);
  await client.send("Page.navigate", { url: url.href });
  const mountReadyExpr =
    `!!document.querySelector('[data-testid="row-interaction-strip"]') && !!window.rowInteraction` +
    (family.extraMountReadyExpr === undefined
      ? ""
      : ` && (${family.extraMountReadyExpr})`);
  await waitFor(client, `${family.name} fixture mounted`, mountReadyExpr);

  await evaluate(client, MENU_PROBES_SRC);

  const rowA = family.rowExpr(0);
  const rowB = family.rowExpr(1);

  // Structural precondition: if the container doesn't actually overflow,
  // every scroll measurement below is vacuous regardless of what Base does.
  await assertContainerOverflows(client, family);

  const result = {};

  // (0) Closed-menu wheel positive control: the container must actually
  // scroll with no menu open, or the open-menu measurement below is
  // vacuous - asserted, not just recorded. Also records that the wheel
  // point sits outside any popup. This deliberately scrolls the container,
  // so every later block resets it before touching row geometry.
  await resetScrollAndSettle(client, family);
  await assertRowVisible(client, family, rowA, "row A");
  await assertRowVisible(client, family, rowB, "row B");
  result.closedMenuWheelControl = await measureWheel(client, family, "closed");

  // (1) Menu open on row A: right-click row B opens B's menu in ONE
  // gesture at B's point. `openCount`/`activeElement` still can't name
  // "whose" content opened for the real LandingTerminalTabStrip - that is
  // what the separate ownership check below establishes concretely.
  await resetScrollAndSettle(client, family);
  await assertRowVisible(client, family, rowA, "row A");
  await assertRowVisible(client, family, rowB, "row B");
  await openRowANearBottom(client, rowA);
  await waitFor(
    client,
    "row A menu opens",
    "window.__openMenuContents().length > 0",
  );
  await delay(150);
  // The exact point this right-click was dispatched at, computed fresh
  // (post-reset) rather than reused from an earlier, now-stale layout. Fixed
  // (B's own center) across HEAD/Base runs - A's OPENING point is what moves
  // (near-bottom) to keep this one genuinely exposed.
  const rowBClickPoint = await centerOf(client, rowB);
  await assertPointOutsidePopups(
    client,
    rowBClickPoint,
    "right-click-B-while-A-open",
  );
  await rightClickAtPoint(client, rowBClickPoint);
  await delay(150);
  result.rightClickOtherRowWhileOpen = await evaluate(
    client,
    `(() => {
      const contents = window.__openMenuContents();
      const contentRect = contents.length === 1 ? contents[0].getBoundingClientRect() : null;
      const distanceFromClickPoint = (rect) =>
        rect === null
          ? null
          : Math.hypot(rect.left - ${rowBClickPoint.x}, rect.top - ${rowBClickPoint.y});
      return {
        openCount: contents.length,
        distanceFromRightClickPoint: distanceFromClickPoint(contentRect),
        activeElement: document.activeElement?.outerHTML.slice(0, 200) ?? null,
      };
    })()`,
  );
  // Concrete B ownership: click the open content's own action item and
  // record what fired, rather than inferring it from position.
  result.rowBOwnershipAfterOpen = await measureRowBOwnership(
    client,
    family,
    rowB,
  );
  await pressEscapeUntilClosed(client);

  // (2) Wheel-scroll over the list while a menu is open: does the list
  // still scroll? Only meaningful given (0)'s positive control passed.
  await resetScrollAndSettle(client, family);
  await assertRowVisible(client, family, rowA, "row A");
  await openRowANearBottom(client, rowA);
  await waitFor(
    client,
    "menu opens for scroll check",
    "window.__openMenuContents().length > 0",
  );
  await delay(150);
  result.wheelScrollWhileOpen = await measureWheel(client, family, "open");
  await pressEscapeUntilClosed(client);

  // (2b) Closed-menu hover positive control: no popup open at all, so this
  // can't be confused with (3) below. Proves this Chrome instance actually
  // renders real hover styling - matchMedia('(hover: hover)') alongside a
  // before/after computed-style diff and the :hover pseudo-class itself -
  // so a transparent result in (3) reads as a genuine regression, not an
  // environment that never had hover capability to lose.
  await resetScrollAndSettle(client, family);
  await assertRowVisible(client, family, rowB, "row B");
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: 0,
    y: 0,
  });
  // >=200ms: a shorter wait catches the row's own transition-colors still
  // mid-flight off a PRIOR hover (a real residual alpha, not transparent),
  // not a clean unhovered baseline. Same settle window applies below after
  // moving TO the hover point, and on both HEAD/Base runs.
  await delay(220);
  const closedControlBefore = await computedRowStyle(client, rowB);
  const closedControlPoint = await centerOf(client, rowB);
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: closedControlPoint.x,
    y: closedControlPoint.y,
  });
  await delay(220);
  const closedControlAfter = await computedRowStyle(client, rowB);
  result.closedMenuHoverControl = {
    hoverMediaMatches: await evaluate(
      client,
      "matchMedia('(hover: hover)').matches",
    ),
    pointerFineMediaMatches: await evaluate(
      client,
      "matchMedia('(pointer: fine)').matches",
    ),
    rowMatchesHoverPseudoClass: await evaluate(
      client,
      `(${rowB})?.matches(':hover') ?? null`,
    ),
    before: closedControlBefore,
    after: closedControlAfter,
    styleChanged:
      closedControlBefore !== null &&
      closedControlAfter !== null &&
      (closedControlBefore.color !== closedControlAfter.color ||
        closedControlBefore.backgroundColor !==
          closedControlAfter.backgroundColor),
  };
  if (
    !result.closedMenuHoverControl.hoverMediaMatches ||
    !result.closedMenuHoverControl.pointerFineMediaMatches
  ) {
    throw new Error(
      `${family.name}: this Chrome instance does not report hover:hover/pointer:fine - the launch's device-model flags aren't taking effect, so every hover measurement below would be vacuous`,
    );
  }
  if (!result.closedMenuHoverControl.styleChanged) {
    throw new Error(
      `${family.name}: closed-menu hover positive control saw no computed-style change - this Chrome instance is not exercising real hover, so (3)'s open-menu hover measurement would be vacuous`,
    );
  }
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: 0,
    y: 0,
  });
  await delay(220);

  // (3) Hover another row while a menu is open: does the browser's own
  // :hover pseudo-class register, and does the row's actual computed style
  // (its real hover treatment, not a synthetic one) change? (Real
  // mouse-driven :hover cannot be observed in jsdom - this needs the real
  // browser.)
  await resetScrollAndSettle(client, family);
  await assertRowVisible(client, family, rowA, "row A");
  await assertRowVisible(client, family, rowB, "row B");
  await openRowANearBottom(client, rowA);
  await waitFor(
    client,
    "menu opens for hover check",
    "window.__openMenuContents().length > 0",
  );
  await delay(150);
  const beforeHover = await computedRowStyle(client, rowB);
  const rowBCenter = await centerOf(client, rowB);
  await assertPointOutsidePopups(client, rowBCenter, "hover-B-while-A-open");
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: rowBCenter.x,
    y: rowBCenter.y,
  });
  // Same >=200ms settle as the positive control above, for a stable
  // transition-colors sample on both HEAD/Base runs.
  await delay(220);
  const afterHover = await computedRowStyle(client, rowB);
  result.hoverOtherRowWhileOpen = {
    rowMatchesHoverPseudoClass: await evaluate(
      client,
      `(${rowB})?.matches(':hover') ?? null`,
    ),
    before: beforeHover,
    after: afterHover,
    styleChanged:
      beforeHover !== null &&
      afterHover !== null &&
      (beforeHover.color !== afterHover.color ||
        beforeHover.backgroundColor !== afterHover.backgroundColor),
  };
  await pressEscapeUntilClosed(client);

  // (4) Left-click another row: does it BOTH close the menu AND act on the
  // row in one click? `window.rowInteraction.events` records every
  // `activate:*` the fixture's own onClick handlers fire.
  await resetScrollAndSettle(client, family);
  await assertRowVisible(client, family, rowA, "row A");
  await assertRowVisible(client, family, rowB, "row B");
  await evaluate(client, "window.rowInteraction.events.length = 0");
  await openRowANearBottom(client, rowA);
  await waitFor(
    client,
    "menu opens for left-click-other-row check",
    "window.__openMenuContents().length > 0",
  );
  await delay(150);
  const rowBLeftClickPoint = await centerOf(client, rowB);
  await assertPointOutsidePopups(
    client,
    rowBLeftClickPoint,
    "left-click-B-while-A-open",
  );
  await clickAtPoint(client, rowBLeftClickPoint);
  await delay(200);
  result.leftClickOtherRowClosesAndActs = await evaluate(
    client,
    `({
      openCount: window.__openMenuContents().length,
      events: window.rowInteraction.events.slice(),
    })`,
  );
  await pressEscapeUntilClosed(client);

  // (5) Where focus is after an ordinary close (Escape on row A's own
  // menu).
  await resetScrollAndSettle(client, family);
  await assertRowVisible(client, family, rowA, "row A");
  await openRowANearBottom(client, rowA);
  await waitFor(
    client,
    "menu opens for focus-after-close check",
    "window.__openMenuContents().length > 0",
  );
  await delay(150);
  await pressEscape(client);
  await delay(250);
  result.focusAfterClose = await evaluate(
    client,
    `(() => {
      const active = document.activeElement;
      // For file-tree, a focused row inside the shadow root retargets
      // document.activeElement to the shadow HOST when read from outside
      // it - shadowActiveElement reads the real target from inside.
      const shadowRoot = ${FILE_TREE_SHADOW_ROOT_EXPR};
      const shadowActive = shadowRoot ? shadowRoot.activeElement : null;
      return {
        matchesRowA: active === (${rowA}),
        shadowActiveMatchesRowA: shadowActive === (${rowA}),
        isBody: active === document.body,
        outerHTML: (shadowActive ?? active)?.outerHTML.slice(0, 200) ?? null,
      };
    })()`,
  );

  // (6) Landing-only: the original load-bearing `modal={false}` scenario.
  // Clicking the real Rename item must put the row into rename mode, AND
  // the input must KEEP focus once the menu's own close/focus-restore fully
  // settles - a trapped Radix focus scope used to yank focus back to the
  // trigger the instant the menu started closing, blurring the just-mounted
  // input before `useInlineRename` could commit it. `finalFocus={false}`
  // only suppresses Base's own restoration step, not a claim about
  // trapping, so this is the one check that actually proves the input kept
  // what it took.
  if (family.name === "landing-tabstrip") {
    await resetScrollAndSettle(client, family);
    await assertRowVisible(client, family, rowA, "row A");
    await openRowANearBottom(client, rowA);
    await waitFor(
      client,
      "menu opens for rename check",
      "window.__openMenuContents().length > 0",
    );
    await delay(150);
    const renameClicked = await evaluate(
      client,
      `(() => {
        const content = window.__openMenuContents()[0];
        if (!content) return false;
        const items = [...content.querySelectorAll('[data-slot="context-menu-item"]')];
        const rename = items.find((el) => el.textContent?.trim() === 'Rename');
        if (!rename) return false;
        rename.click();
        return true;
      })()`,
    );
    await delay(150);
    const renameInputExpr = `document.querySelector('[data-testid="landing-terminal-tab-input-${ROW_IDS[0]}"]')`;
    const rightAfterClick = await evaluate(
      client,
      `(() => ({
        present: !!(${renameInputExpr}),
        focused: document.activeElement === (${renameInputExpr}),
      }))()`,
    );
    // Let the menu's own close-transition/focus-restore fully settle - the
    // exact window a trapped scope used to steal focus back in.
    await delay(300);
    const afterCloseSettles = await evaluate(
      client,
      `(() => ({
        present: !!(${renameInputExpr}),
        focused: document.activeElement === (${renameInputExpr}),
      }))()`,
    );
    result.landingRenameKeepsFocus = {
      renameClicked,
      rightAfterClick,
      afterCloseSettles,
    };
    if (afterCloseSettles.present) await pressEscape(client);
    await delay(150);
    await pressEscapeUntilClosed(client);
  }

  return result;
}

/**
 * Structural precondition, asserted (not just recorded): the scroll
 * container's content must actually exceed its box on `family`'s axis, or
 * every scroll measurement for this family is vacuous regardless of what
 * Base does.
 */
async function assertContainerOverflows(client, family) {
  const range = await evaluate(
    client,
    `(() => {
      const el = ${family.scrollContainerExpr};
      if (!el) return null;
      return { x: el.scrollWidth - el.clientWidth, y: el.scrollHeight - el.clientHeight };
    })()`,
  );
  const key = family.axis;
  if (range === null || !(range[key] > 0)) {
    throw new Error(
      `${family.name}: scroll container does not overflow on axis "${family.axis}" (range=${JSON.stringify(range)}) - the scroll measurement would be vacuous`,
    );
  }
}

/** Zeroes the container's scroll offset and waits a frame for layout to
 * settle, so a prior interaction's wheel scroll can never leave row A/B
 * clipped or offscreen for the next one, and cached click points are never
 * computed against a stale, already-scrolled layout. */
async function resetScrollAndSettle(client, family) {
  await evaluate(
    client,
    `(() => {
      const el = ${family.scrollContainerExpr};
      if (el) { el.scrollLeft = 0; el.scrollTop = 0; }
    })()`,
  );
  await evaluate(
    client,
    `new Promise((resolve) => requestAnimationFrame(() => resolve(null)))`,
  );
}

/**
 * Sanity-checks a row's own geometry (nonzero size, within its scroll
 * container's visible viewport) BEFORE any menu opens over it. Deliberately
 * does not require hit-testability once a menu is already open - whether an
 * open backdrop blocks that is the thing interactions (1)-(5) measure, not
 * a precondition to assert away.
 */
async function assertRowVisible(client, family, rowExpr, label) {
  const ok = await evaluate(
    client,
    `(() => {
      const container = ${family.scrollContainerExpr};
      const row = ${rowExpr};
      if (!container || !row) return false;
      const c = container.getBoundingClientRect();
      const r = row.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      return r.top >= c.top - 1 && r.bottom <= c.bottom + 1 && r.left >= c.left - 1 && r.right <= c.right + 1;
    })()`,
  );
  if (!ok) {
    throw new Error(
      `${family.name}: ${label} is not visible within its scroll container's viewport before the gesture (${rowExpr})`,
    );
  }
}

/**
 * Wheel-scrolls at a point chosen from `family`'s scroll container's own
 * VISIBLE rect (never an offscreen row past the overflow - that container
 * clips at ~6 of its 8 rows, so a "far row" center can sit outside the
 * viewport entirely and never receive the wheel event). The point is the
 * container-rect corner farthest from any open popup's center, then
 * verified (not assumed) to actually sit outside every open popup. `mode:
 * "closed"` is the positive control (no menu open, scroll must work,
 * asserted); `mode: "open"` is interaction (2), recorded only - whether the
 * open backdrop blocks it is what's under measurement.
 */
async function measureWheel(client, family, mode) {
  const before = await scrollOffset(client, family);
  const point = await wheelPointOutsidePopup(client, family);
  const pointOutsidePopup = await evaluate(
    client,
    `(() => {
      const contents = window.__openMenuContents();
      return contents.every((el) => {
        const r = el.getBoundingClientRect();
        return ${point.x} < r.left || ${point.x} > r.right || ${point.y} < r.top || ${point.y} > r.bottom;
      });
    })()`,
  );
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: point.x,
    y: point.y,
    deltaX: family.axis === "x" ? 80 : 0,
    deltaY: family.axis === "y" ? 80 : 0,
  });
  await delay(200);
  const after = await scrollOffset(client, family);
  const key = family.axis === "x" ? "scrollLeft" : "scrollTop";
  const scrolled =
    before[key] !== null && after[key] !== null && after[key] !== before[key];
  if (mode === "closed" && !scrolled) {
    throw new Error(
      `${family.name}: closed-menu wheel positive control did not scroll (before=${JSON.stringify(before)}, after=${JSON.stringify(after)}, point=${JSON.stringify(point)}) - the open-menu scroll measurement would be meaningless`,
    );
  }
  return {
    mode,
    point,
    pointOutsidePopup,
    before,
    after,
    scrolled,
  };
}

async function wheelPointOutsidePopup(client, family) {
  const margin = 12;
  const container = await evaluate(
    client,
    `(() => {
      const el = ${family.scrollContainerExpr};
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    })()`,
  );
  const popup = await evaluate(
    client,
    `(() => {
      const el = window.__openMenuContents()[0];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    })()`,
  );
  const corners = [
    { x: container.left + margin, y: container.top + margin },
    { x: container.right - margin, y: container.top + margin },
    { x: container.left + margin, y: container.bottom - margin },
    { x: container.right - margin, y: container.bottom - margin },
  ];
  if (popup === null) return corners[0];
  const popupCenter = {
    x: (popup.left + popup.right) / 2,
    y: (popup.top + popup.bottom) / 2,
  };
  return corners.reduce((farthest, corner) =>
    Math.hypot(corner.x - popupCenter.x, corner.y - popupCenter.y) >
    Math.hypot(farthest.x - popupCenter.x, farthest.y - popupCenter.y)
      ? corner
      : farthest,
  );
}

async function scrollOffset(client, family) {
  return evaluate(
    client,
    `(() => {
      const el = ${family.scrollContainerExpr};
      return { scrollLeft: el?.scrollLeft ?? null, scrollTop: el?.scrollTop ?? null };
    })()`,
  );
}

async function computedRowStyle(client, rowExpr) {
  return evaluate(
    client,
    `(() => {
      const el = ${rowExpr};
      if (!el) return null;
      const style = getComputedStyle(el);
      return { color: style.color, backgroundColor: style.backgroundColor };
    })()`,
  );
}

/**
 * Clicks the currently-open content's own action item and reports what it
 * named, rather than inferring ownership from screen position. Every
 * family's stand-in item testid (or, for landing-tabstrip, the real Close
 * item's own text) carries the row identity it acted on directly.
 */
async function measureRowBOwnership(client, family, rowB) {
  if (family.name === "landing-tabstrip") {
    const rowBId = ROW_IDS[1];
    await evaluate(client, "window.rowInteraction.events.length = 0");
    const clicked = await evaluate(
      client,
      `(() => {
        const content = window.__openMenuContents()[0];
        if (!content) return false;
        const items = [...content.querySelectorAll('[data-slot="context-menu-item"]')];
        const close = items.find((el) => el.textContent?.trim() === 'Close');
        if (!close) return false;
        close.click();
        return true;
      })()`,
    );
    await delay(150);
    const events = await evaluate(
      client,
      "window.rowInteraction.events.slice()",
    );
    return {
      clicked,
      expectedRowId: rowBId,
      events,
      ownsRowB: events.includes(`close:${rowBId}`),
    };
  }
  const testId = await evaluate(
    client,
    `window.__openMenuContents()[0]?.querySelector('[data-slot="context-menu-item"]')?.getAttribute('data-testid') ?? null`,
  );
  const expected =
    family.name === "file-tree"
      ? `file-tree-copy-path:file-1.ts`
      : `row-1-close`;
  if (testId !== null) {
    await evaluate(
      client,
      `document.querySelector('[data-testid=${JSON.stringify(testId)}]')?.click()`,
    );
  }
  return { itemTestId: testId, expected, ownsRowB: testId === expected };
}

async function pressEscapeUntilClosed(client) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const stillOpen = await evaluate(
      client,
      "window.__openMenuContents().length > 0",
    );
    if (!stillOpen) return;
    await pressEscape(client);
    await delay(200);
  }
}

// `elementExpr` is a JS expression evaluating to the element - not a CSS
// selector - so callers can reach through a shadow root
// (`shadowRoot.querySelector(...)`), which `document.querySelector` alone
// cannot pierce.
async function centerOf(client, elementExpr) {
  const point = await evaluate(
    client,
    `(() => {
      const element = ${elementExpr};
      if (!(element instanceof HTMLElement)) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`,
  );
  if (
    point === null ||
    typeof point !== "object" ||
    typeof point.x !== "number" ||
    typeof point.y !== "number"
  ) {
    throw new Error(`Could not resolve a click point for "${elementExpr}"`);
  }
  return point;
}

/**
 * A point near an element's bottom edge rather than its dead center. Used
 * to open row A's context menu: a popup right-clicked at A's CENTER can
 * cover B's center too (B sits at the same row band, and the popup extends
 * from the click point - a real, observed collision, not hypothetical).
 * Opening from A's bottom edge instead pushes the whole popup below the row
 * band, leaving B's own center genuinely exposed.
 */
async function nearBottomOf(client, elementExpr, inset = 4) {
  const point = await evaluate(
    client,
    `(() => {
      const element = ${elementExpr};
      if (!(element instanceof HTMLElement)) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.bottom - ${inset} };
    })()`,
  );
  if (
    point === null ||
    typeof point !== "object" ||
    typeof point.x !== "number" ||
    typeof point.y !== "number"
  ) {
    throw new Error(
      `Could not resolve a near-bottom click point for "${elementExpr}"`,
    );
  }
  return point;
}

/**
 * Verified, not assumed: throws if `point` falls inside any currently-open
 * popup's rect. B's own gesture point stays fixed (center) across HEAD and
 * Base runs - it is A's OPENING point that moves (near-bottom, above) to
 * keep B genuinely exposed, and this is the check that catches it if that
 * still isn't enough for a given family/geometry.
 */
async function assertPointOutsidePopups(client, point, label) {
  const outside = await evaluate(
    client,
    `(() => {
      const contents = window.__openMenuContents();
      return contents.every((el) => {
        const r = el.getBoundingClientRect();
        return ${point.x} < r.left || ${point.x} > r.right || ${point.y} < r.top || ${point.y} > r.bottom;
      });
    })()`,
  );
  if (!outside) {
    throw new Error(
      `${label}: gesture point (${point.x}, ${point.y}) falls inside an open popup's rect - not a genuine row hit`,
    );
  }
}

async function openRowANearBottom(client, rowA) {
  await rightClickAtPoint(client, await nearBottomOf(client, rowA));
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
  const deadline = Date.now() + 60_000;
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
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await evaluate(client, expression)) return;
    await delay(50);
  }
  const pageState = await evaluate(
    client,
    `({ text: document.body.innerText, html: document.body.innerHTML.slice(0, 3000) })`,
  );
  throw new Error(
    `Timed out waiting for ${label}:\n${JSON.stringify(pageState, null, 2)}`,
  );
}

async function pressEscape(client) {
  await client.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
    modifiers: 0,
  });
  await client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
    modifiers: 0,
  });
}

async function moveMouse(client, x, y) {
  await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
}

async function clickAtPoint(client, point) {
  await moveMouse(client, point.x, point.y);
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}

async function rightClickAtPoint(client, point) {
  await moveMouse(client, point.x, point.y);
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "right",
    buttons: 2,
    clickCount: 1,
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "right",
    buttons: 0,
    clickCount: 1,
  });
}

async function clickSelector(client, selector) {
  await clickAtPoint(client, await centerOf(client, selector));
}

async function rightClickSelector(client, selector) {
  await rightClickAtPoint(client, await centerOf(client, selector));
}
