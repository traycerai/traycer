// Browser regression for the epic canvas tile's VS Code-style tab strip
// (`TabStrip`, `src/components/epic-canvas/canvas/tab-strip.tsx`): a fixed
// h-9 tab item used to overflow the scroller's real 35px row by 1px, and
// because an `overflow-x-auto` scroller computes `overflow-y` to `auto`, a
// vertical mouse wheel over the strip - when there is no HORIZONTAL overflow,
// so `useHorizontalWheelScroll` returns early without `preventDefault()` -
// fell through to the browser's own native scroll-on-wheel action, which
// scrolled that 1px of vertical slack: the active tab's top accent bar and
// label wobbled up and down by a pixel. The fix drops the tab item's fixed
// height (it now stretches to the scroller's row) and adds `pt-px` so the
// icon/title sit on the same 18px centre line the old, clipped h-9 tab drew
// them on.
//
// jsdom cannot answer any of this. It lays nothing out, so `scrollHeight` and
// `clientHeight` are always 0 and "does this row have 1px of vertical
// overflow" has no answer there; and jsdom's `fireEvent.wheel` is a synthetic
// event with no native default action behind it, so it can never reach the
// mechanism the bug actually lived in - the BROWSER choosing which axis to
// scroll when a synthetic handler declines to call `preventDefault()`. Only a
// real layout engine plus a real CDP-dispatched wheel event can tell a 35px
// row with zero vertical slack apart from one with 1px of it.
//
// It also covers a second, narrower regression in the same fixed-height fix:
// `TabStripDropIndicator` (the vertical drop line a strip drag renders inside
// the hovered tab) was `inset-y-1` on the old fixed 36px tab, spanning
// 4px-32px from the tab's top; on the now-35px tab that same `inset-y-1`
// spans only 4px-31px, a 1px visible shrink. The fix reclaims it with
// `top-1 bottom-0.75`, and this driver seeds a drop preview via the fixture's
// `?dropIndex=` param and measures the indicator back to 4px-32px.
//
// Structure follows `status-bar-usage-scroll-browser.mjs` (vite + headless
// Chrome over CDP via `scripts/chrome-launcher.mjs`); wired into
// `scripts/run-tests.ts` behind `RUN_DIFF_EDIT_BROWSER_REGRESSION`, next to
// that fixture's entry.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
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
import { connectCdp } from "./cdp-client.mjs";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const fixtureUrlPath = "/src/__tests__/browser/canvas-tab-strip-overflow.html";
const chromePath = await findChrome("the canvas tab strip overflow regression");
const vitePort = await freePort();
const STRIP = '[data-testid="tab-strip"]';
const SCROLLER = '[data-testid="tab-strip-end"]';
const DROP_INDICATOR = '[data-testid="tab-strip-drop-indicator"]';
// Wide enough that a single ~100px blank tab never overflows it, narrow
// enough that twenty of them comfortably do.
const VIEWPORT_WIDTH_PX = 640;
const VIEWPORT_HEIGHT_PX = 200;
// Enough blank tabs to overflow `VIEWPORT_WIDTH_PX` several times over -
// twenty blank tabs at ~100px each is ~2000px of content in a 640px strip.
const OVERFLOW_TAB_COUNT = 20;
// Vertical wheel notches, dispatched as a real OS-level wheel event via CDP -
// see the header for why this cannot be `fireEvent.wheel`.
const WHEEL_DELTA_PX = 120;
// "Look preserved" baseline: where the icon and title centres sat on the
// pre-fix layout (tab item `h-9`, no `pt-px`), measured by reverting
// `tab-strip.tsx` to it and running this driver. The fixed layout measures the
// same, so the fix moved nothing; a change here is a visible change.
const EXPECTED_ICON_CENTER_Y_FROM_STRIP_TOP_PX = 18;
const EXPECTED_TITLE_CENTER_Y_FROM_STRIP_TOP_PX = 18;
// Drop-indicator baseline: where `inset-y-1` placed the line on the old fixed
// 36px tab (4px from the top, 32px from the top - a 28px-tall line). The
// 35px tab's `top-1 bottom-0.75` fix reclaims exactly this span.
const EXPECTED_DROP_INDICATOR_TOP_FROM_TAB_TOP_PX = 4;
const EXPECTED_DROP_INDICATOR_BOTTOM_FROM_TAB_TOP_PX = 32;
let chrome;
let chromeProfilePath;
let client;
let viteProcess;

try {
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
  const singleTabUrl = pageUrl(1);
  await waitForHttp(singleTabUrl, viteProcess, () => viteError, "Vite");

  const launched = await launchChromeWithDevTools(
    chromePath,
    "traycer-canvas-tab-strip-overflow-",
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
  const targetResponse = await fetch(
    new URL(`/json/new?${encodeURIComponent(singleTabUrl)}`, devtoolsUrl),
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
  await setViewport(client);

  // ── (a)/(b)/(d): a single tab, no horizontal overflow ─────────────────────
  await waitForStrip(client, 1);
  const singleStart = await readStripState(client);
  assert.equal(
    singleStart.scroller.scrollHeight,
    singleStart.scroller.clientHeight,
    `a single tab must leave the scroller with NO vertical scroll range ` +
      `(scrollHeight ${singleStart.scroller.scrollHeight}px, ` +
      `clientHeight ${singleStart.scroller.clientHeight}px)`,
  );
  assert.equal(
    singleStart.scroller.scrollWidth <= singleStart.scroller.clientWidth,
    true,
    `a single tab must not overflow horizontally either ` +
      `(scrollWidth ${singleStart.scroller.scrollWidth}px, ` +
      `clientWidth ${singleStart.scroller.clientWidth}px)`,
  );

  // (a) Assigning `scrollTop` directly must read back 0: there is no range to
  // move it into.
  await evaluate(client, `document.querySelector('${SCROLLER}').scrollTop = 5`);
  const afterAssign = await readScrollerScrollTop(client);
  assert.equal(
    afterAssign,
    0,
    `assigning scrollTop = 5 on a strip with no vertical range must read ` +
      `back 0 (read ${afterAssign})`,
  );

  // (b) A real vertical wheel, a few notches each direction, over the
  // scroller's centre. Tracked PER NOTCH, not just at the end: a down-then-up
  // sequence can net-cancel back to scrollTop 0 on the BUGGY (pre-fix) code
  // too, which would make a final-value-only check pass on both the broken
  // and the fixed layout. The real invariant a zero-range scroller must
  // satisfy is that it never moves AT ALL, at any point in the sequence.
  let maxAbsScrollTopDuringWheel = 0;
  for (const deltaY of [
    WHEEL_DELTA_PX,
    WHEEL_DELTA_PX,
    WHEEL_DELTA_PX,
    -WHEEL_DELTA_PX,
    -WHEEL_DELTA_PX,
  ]) {
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: singleStart.scroller.centerX,
      y: singleStart.scroller.centerY,
      deltaX: 0,
      deltaY,
    });
    // Let this notch's native scroll land before the next is dispatched and
    // before reading scrollTop, so an intermediate wobble cannot be skipped
    // over by two notches coalescing into one paint.
    await delay(60);
    const scrollTopNow = await readScrollerScrollTop(client);
    maxAbsScrollTopDuringWheel = Math.max(
      maxAbsScrollTopDuringWheel,
      Math.abs(scrollTopNow),
    );
  }
  await settle(client);
  const singleAfterWheel = await readStripState(client);
  assert.equal(
    maxAbsScrollTopDuringWheel,
    0,
    `scrollTop must never move off 0 at ANY point during the wheel ` +
      `sequence, not merely settle back to 0 at the end (max |scrollTop| ` +
      `seen mid-sequence ${maxAbsScrollTopDuringWheel}, final ` +
      `${singleAfterWheel.scroller.scrollTop})`,
  );
  assert.equal(
    singleAfterWheel.scroller.scrollTop,
    0,
    `a real vertical wheel over a non-overflowing strip must not move ` +
      `scrollTop (read ${singleAfterWheel.scroller.scrollTop})`,
  );
  assert.equal(
    singleAfterWheel.tabTop,
    singleStart.tabTop,
    `the tab's top must not move under the wheel (before ` +
      `${singleStart.tabTop}px, after ${singleAfterWheel.tabTop}px) - this ` +
      `is the 1px wobble the fix removes`,
  );
  assert.equal(
    singleAfterWheel.accentTopFromStripTop,
    singleStart.accentTopFromStripTop,
    `the active tab's top accent bar must not move under the wheel ` +
      `(before ${singleStart.accentTopFromStripTop}px from the strip top, ` +
      `after ${singleAfterWheel.accentTopFromStripTop}px)`,
  );

  // (d) Look preserved: the tab item fills the scroller's row exactly, and
  // the icon/title sit on the same centre line the pre-fix h-9 tab drew them
  // on (baseline above).
  assert.equal(
    singleStart.tabHeight,
    singleStart.scroller.clientHeight,
    `the tab item's height must equal the scroller's row height - a ` +
      `mismatch is exactly the 1px overflow the fix removes (tab ` +
      `${singleStart.tabHeight}px, scroller ${singleStart.scroller.clientHeight}px)`,
  );
  assert.equal(
    singleStart.accentTopFromStripTop,
    0,
    `the active tab's top accent bar must sit flush with the strip's top ` +
      `(measured ${singleStart.accentTopFromStripTop}px from the strip top)`,
  );
  assert.equal(
    singleStart.iconCenterYFromStripTop,
    EXPECTED_ICON_CENTER_Y_FROM_STRIP_TOP_PX,
    `the tab icon's vertical centre must sit where the pre-fix layout drew ` +
      `it, ${EXPECTED_ICON_CENTER_Y_FROM_STRIP_TOP_PX}px from the strip's ` +
      `top (measured ${singleStart.iconCenterYFromStripTop}px)`,
  );
  assert.equal(
    singleStart.titleCenterYFromStripTop,
    EXPECTED_TITLE_CENTER_Y_FROM_STRIP_TOP_PX,
    `the tab title's vertical centre must sit where the pre-fix layout ` +
      `drew it, ${EXPECTED_TITLE_CENTER_Y_FROM_STRIP_TOP_PX}px from the ` +
      `strip's top (measured ${singleStart.titleCenterYFromStripTop}px)`,
  );

  // ── (e): the strip drop indicator reclaims its pre-35px-tab span ─────────
  // Reload with a seeded `artifact-tab-strip` drop preview at index 0 (the
  // fixture's `?dropIndex=` param), which mounts `TabStripDropIndicator`
  // inside the single tab with no real drag gesture needed.
  await client.send("Page.navigate", { url: dropIndexPageUrl(1, 0) });
  await waitForStrip(client, 1);
  await waitFor(
    client,
    "the tab strip drop indicator to mount",
    `document.querySelector('${STRIP} [role="tab"] ${DROP_INDICATOR}') !== null`,
  );
  // Let the indicator's 120ms mount animation (opacity/scaleY) settle before
  // measuring its rect.
  await settle(client);
  const dropIndicatorState = await readDropIndicatorState(client);
  assert.equal(
    dropIndicatorState.indicatorTopFromTabTop,
    EXPECTED_DROP_INDICATOR_TOP_FROM_TAB_TOP_PX,
    `the drop indicator's top must sit ` +
      `${EXPECTED_DROP_INDICATOR_TOP_FROM_TAB_TOP_PX}px below the tab's top ` +
      `- where inset-y-1 placed it on the old fixed 36px tab (measured ` +
      `${dropIndicatorState.indicatorTopFromTabTop}px)`,
  );
  assert.equal(
    dropIndicatorState.indicatorBottomFromTabTop,
    EXPECTED_DROP_INDICATOR_BOTTOM_FROM_TAB_TOP_PX,
    `the drop indicator's bottom must sit ` +
      `${EXPECTED_DROP_INDICATOR_BOTTOM_FROM_TAB_TOP_PX}px below the tab's ` +
      `top (a ${
        EXPECTED_DROP_INDICATOR_BOTTOM_FROM_TAB_TOP_PX -
        EXPECTED_DROP_INDICATOR_TOP_FROM_TAB_TOP_PX
      }px-tall line) - the drop line sits where it did when the tab was a ` +
      `fixed 36px (inset-y-1 on 36px) (measured ` +
      `${dropIndicatorState.indicatorBottomFromTabTop}px)`,
  );

  // ── (c): enough tabs to overflow, a vertical wheel scrolls horizontally ───
  await client.send("Page.navigate", { url: pageUrl(OVERFLOW_TAB_COUNT) });
  await waitForStrip(client, OVERFLOW_TAB_COUNT);
  const overflowStart = await readStripState(client);
  assert.equal(
    overflowStart.scroller.scrollHeight,
    overflowStart.scroller.clientHeight,
    `an overflowing strip must still have NO vertical scroll range of its ` +
      `own (scrollHeight ${overflowStart.scroller.scrollHeight}px, ` +
      `clientHeight ${overflowStart.scroller.clientHeight}px)`,
  );
  assert.ok(
    overflowStart.scroller.scrollWidth > overflowStart.scroller.clientWidth,
    `${OVERFLOW_TAB_COUNT} blank tabs at ${VIEWPORT_WIDTH_PX}px must ` +
      `overflow the scroller horizontally (scrollWidth ` +
      `${overflowStart.scroller.scrollWidth}px, clientWidth ` +
      `${overflowStart.scroller.clientWidth}px)`,
  );
  assert.equal(
    overflowStart.scroller.scrollLeft,
    0,
    `the overflowing strip must start scrolled to its first tab`,
  );

  await client.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: overflowStart.scroller.centerX,
    y: overflowStart.scroller.centerY,
    deltaX: 0,
    deltaY: WHEEL_DELTA_PX,
  });
  await settle(client);
  const overflowAfterWheel = await readStripState(client);
  assert.ok(
    overflowAfterWheel.scroller.scrollLeft > 0,
    `a real vertical wheel over an overflowing strip must turn into ` +
      `horizontal scroll (scrollLeft ${overflowAfterWheel.scroller.scrollLeft})`,
  );
  assert.equal(
    overflowAfterWheel.scroller.scrollTop,
    0,
    `the same wheel must leave scrollTop at 0 - it is horizontal scroll, ` +
      `never vertical (read ${overflowAfterWheel.scroller.scrollTop})`,
  );

  console.log(
    `canvas tab strip overflow regression passed: single-tab scroller ` +
      `${singleStart.scroller.scrollHeight}/${singleStart.scroller.clientHeight}px ` +
      `(no vertical range), tab height ${singleStart.tabHeight}px = row ` +
      `${singleStart.scroller.clientHeight}px, icon centre ` +
      `${singleStart.iconCenterYFromStripTop}px / title centre ` +
      `${singleStart.titleCenterYFromStripTop}px from strip top, wheel left ` +
      `tab top and accent unmoved; drop indicator spans ` +
      `${dropIndicatorState.indicatorTopFromTabTop}px-` +
      `${dropIndicatorState.indicatorBottomFromTabTop}px from the tab top; ` +
      `overflowing strip ` +
      `${overflowStart.scroller.scrollWidth}/${overflowStart.scroller.clientWidth}px ` +
      `scrolled horizontally to ${overflowAfterWheel.scroller.scrollLeft}px ` +
      `by the same wheel, scrollTop stayed 0`,
  );
} catch (error) {
  console.error("MEASUREMENT FAILED:", error);
  process.exitCode = 1;
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

function pageUrl(tabs) {
  return `http://127.0.0.1:${vitePort}${fixtureUrlPath}?tabs=${tabs}`;
}

/** Same as `pageUrl`, plus the fixture's `?dropIndex=` param that seeds an
 * `artifact-tab-strip` drop preview before the first render. */
function dropIndexPageUrl(tabs, dropIndex) {
  return `${pageUrl(tabs)}&dropIndex=${dropIndex}`;
}

async function setViewport(cdpClient) {
  await cdpClient.send("Emulation.setDeviceMetricsOverride", {
    width: VIEWPORT_WIDTH_PX,
    height: VIEWPORT_HEIGHT_PX,
    deviceScaleFactor: 1,
    mobile: false,
  });
}

async function waitForStrip(cdpClient, expectedTabCount) {
  await waitFor(
    cdpClient,
    "the tab strip to mount",
    `document.querySelector('${SCROLLER}') !== null && ` +
      `document.querySelectorAll('${STRIP} [role="tab"]').length === ${expectedTabCount}`,
  );
  // A frame for layout/ResizeObserver-driven state (the drop indicator's
  // LayoutGroup, any pending motion mount) to settle before measuring.
  await settle(cdpClient);
}

async function readScrollerScrollTop(cdpClient) {
  return evaluate(cdpClient, `document.querySelector('${SCROLLER}').scrollTop`);
}

/**
 * The scroller's overflow/scroll state, the strip's top, and - for the
 * strip's FIRST (active + globally-active) tab - its own top, its icon and
 * title's vertical centres relative to the strip's top, and its accent bar's
 * top relative to the strip's top.
 */
async function readStripState(cdpClient) {
  return evaluate(
    cdpClient,
    `(() => {
       const strip = document.querySelector('${STRIP}');
       const scroller = document.querySelector('${SCROLLER}');
       const tab = strip.querySelector('[role="tab"]');
       const stripRect = strip.getBoundingClientRect();
       const scrollerRect = scroller.getBoundingClientRect();
       const tabRect = tab === null ? null : tab.getBoundingClientRect();
       const icon = tab === null ? null : tab.querySelector('svg');
       const iconRect = icon === null ? null : icon.getBoundingClientRect();
       const title = tab === null
         ? null
         : tab.querySelector('[data-testid^="tab-title-"]');
       const titleRect = title === null ? null : title.getBoundingClientRect();
       const accent = tab === null
         ? null
         : tab.querySelector('[data-testid="tab-active-accent"]');
       const accentRect = accent === null ? null : accent.getBoundingClientRect();
       return {
         scroller: {
           scrollHeight: scroller.scrollHeight,
           clientHeight: scroller.clientHeight,
           scrollWidth: scroller.scrollWidth,
           clientWidth: scroller.clientWidth,
           scrollTop: scroller.scrollTop,
           scrollLeft: scroller.scrollLeft,
           centerX: Math.round(scrollerRect.left + scrollerRect.width / 2),
           centerY: Math.round(scrollerRect.top + scrollerRect.height / 2),
         },
         stripTop: stripRect.top,
         tabTop: tabRect === null ? null : tabRect.top,
         tabHeight: tabRect === null ? null : tabRect.height,
         iconCenterYFromStripTop: iconRect === null
           ? null
           : (iconRect.top + iconRect.height / 2) - stripRect.top,
         titleCenterYFromStripTop: titleRect === null
           ? null
           : (titleRect.top + titleRect.height / 2) - stripRect.top,
         accentTopFromStripTop: accentRect === null
           ? null
           : accentRect.top - stripRect.top,
       };
     })()`,
  );
}

/**
 * The strip's first tab's rect, and its `TabStripDropIndicator`'s rect
 * relative to that tab's top - null when either is absent.
 */
async function readDropIndicatorState(cdpClient) {
  return evaluate(
    cdpClient,
    `(() => {
       const strip = document.querySelector('${STRIP}');
       const tab = strip.querySelector('[role="tab"]');
       const indicator = tab === null
         ? null
         : tab.querySelector('${DROP_INDICATOR}');
       const tabRect = tab === null ? null : tab.getBoundingClientRect();
       const indicatorRect = indicator === null
         ? null
         : indicator.getBoundingClientRect();
       return {
         indicatorTopFromTabTop: (tabRect === null || indicatorRect === null)
           ? null
           : indicatorRect.top - tabRect.top,
         indicatorBottomFromTabTop: (tabRect === null || indicatorRect === null)
           ? null
           : indicatorRect.bottom - tabRect.top,
       };
     })()`,
  );
}

function settle(cdpClient) {
  return evaluate(cdpClient, `new Promise((r) => setTimeout(r, 250))`);
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

async function evaluate(cdpClient, expression) {
  const response = await cdpClient.send("Runtime.evaluate", {
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

async function waitFor(cdpClient, label, expression) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await evaluate(cdpClient, expression)) return;
    await delay(50);
  }
  const pageState = await evaluate(
    cdpClient,
    `({ text: document.body.innerText, html: document.body.innerHTML.slice(0, 3000) })`,
  );
  throw new Error(
    `Timed out waiting for ${label}:\n${JSON.stringify(pageState, null, 2)}`,
  );
}
