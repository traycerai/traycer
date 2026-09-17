// Browser regression for the status bar's usage cluster: it scrolls when it
// holds more readings than the strip is wide, fades only the edge that hides
// something, and never pushes the resource readout off the strip - and the
// Settings preview's frame, whose readings are `inert`, still scrolls under a
// REAL wheel and a real swipe, since an inert ancestor would swallow both.
//
// jsdom cannot answer any of that. It lays nothing out, so `scrollWidth` and
// `clientWidth` are both 0 and "does this overflow" has no answer; and the
// fade is a mask utility whose class name a jsdom test can read but whose
// effect it cannot see - a class with no rule behind it passes every string
// assertion. This renders the strip's row with the production scroller,
// trigger, readings and resource segment against the real stylesheet, at a
// real width, and reads the layout back.
//
// Structure follows `destructive-dialog-focus-browser.mjs` (vite + headless
// Chrome over CDP); wired into `scripts/run-tests.ts` behind
// RUN_DIFF_EDIT_BROWSER_REGRESSION, which CI sets for this package.
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

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const fixtureUrlPath = "/src/__tests__/browser/status-bar-usage-scroll.html";
const chromePath = await findChrome("the status bar usage-scroll regression");
const vitePort = await freePort();
const SCROLLER = '[data-testid="status-bar-rate-limit-scroller"]';
const RESOURCES =
  '[data-testid="app-status-bar"] [data-testid="status-bar-resource-segment"]';
const PREVIEW_SCROLLER = '[data-testid="status-bar-preview-usage"]';
// Vertical wheel notches, which the scroller turns sideways.
const WHEEL_DELTA_PX = 120;
// How far the swipe travels, in a few moves so Chrome treats it as a drag.
const SWIPE_DISTANCE_PX = 160;
// A narrow window: six accounts cannot fit, and the readout on the right
// must still be whole.
const NARROW_WIDTH_PX = 480;
// A wide window: two accounts fit with room to spare, so nothing may fade.
const WIDE_WIDTH_PX = 1400;
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
  const narrowUrl = pageUrl(6);
  await waitForHttp(narrowUrl, viteProcess, () => viteError, "Vite");

  const launched = await launchChromeWithDevTools(
    chromePath,
    "traycer-status-bar-scroll-",
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
    new URL(`/json/new?${encodeURIComponent(narrowUrl)}`, devtoolsUrl),
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

  // ── six accounts at 480px: overflow, right fade, resources whole ──────────
  await setViewportWidth(client, NARROW_WIDTH_PX);
  await waitForStrip(client);
  const narrowStart = await readLayout(client);
  assert.ok(
    narrowStart.scroller.scrollWidth > narrowStart.scroller.clientWidth,
    `six accounts at ${NARROW_WIDTH_PX}px must overflow the scroller (scrollWidth ${narrowStart.scroller.scrollWidth}, clientWidth ${narrowStart.scroller.clientWidth})`,
  );
  assert.equal(
    narrowStart.scroller.scrollLeft,
    0,
    "the scroller must start at the first account",
  );
  assert.deepEqual(
    narrowStart.fade,
    { left: false, right: true },
    `at the start only the right edge hides something (classes: ${narrowStart.scroller.className})`,
  );
  assert.notEqual(
    narrowStart.scroller.maskImage,
    "none",
    "the fade class must resolve to a real mask, not a name with no rule behind it",
  );
  assertResourcesWhole(narrowStart, NARROW_WIDTH_PX);
  // Every account is in the DOM, none folded away.
  assert.equal(narrowStart.segmentCount, 6, "all six segments must be drawn");
  assert.equal(
    narrowStart.foldedChip,
    false,
    "nothing may be folded into a chip",
  );

  // ── scrolled to the end: left fade, no right fade ─────────────────────────
  await scrollTo(client, "end");
  const narrowEnd = await readLayout(client);
  assert.ok(
    narrowEnd.scroller.scrollLeft > 0,
    "scrolling to the end must move the scroller",
  );
  assert.deepEqual(
    narrowEnd.fade,
    { left: true, right: false },
    `at the end only the left edge hides something (classes: ${narrowEnd.scroller.className})`,
  );
  assertResourcesWhole(narrowEnd, NARROW_WIDTH_PX);

  // ── mid-scroll: both edges ────────────────────────────────────────────────
  await scrollTo(client, "middle");
  const narrowMiddle = await readLayout(client);
  assert.deepEqual(
    narrowMiddle.fade,
    { left: true, right: true },
    `mid-scroll both edges hide something (classes: ${narrowMiddle.scroller.className})`,
  );

  // ── the preview at its Narrow frame, driven by real input ─────────────────
  // A wide viewport, so the frame's own `w-[480px]` is what constrains the
  // preview and not the window: the preview has to scroll because of the
  // width the control named, on a page with plenty of room.
  await setViewportWidth(client, WIDE_WIDTH_PX);
  await settle(client);
  const previewStart = await readScroller(client, PREVIEW_SCROLLER);
  assert.ok(
    previewStart.scrollWidth > previewStart.clientWidth,
    `six accounts in the Narrow preview frame must overflow (scrollWidth ${previewStart.scrollWidth}, clientWidth ${previewStart.clientWidth})`,
  );
  assert.equal(
    previewStart.scrollLeft,
    0,
    "the preview starts at the first account",
  );
  assert.deepEqual(previewStart.fade, { left: false, right: true });
  assert.equal(
    previewStart.inertAncestor,
    false,
    "no ancestor of the preview's scroller may be inert - it would swallow the wheel",
  );
  assert.equal(
    previewStart.inertReadings,
    true,
    "the preview's readings must be inert",
  );

  // A real mouse wheel over the readings: the inert content is skipped by hit
  // testing, so the event lands on the scroller and the strip's wheel handler
  // turns it sideways. `scrollLeft` is never assigned here.
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: previewStart.centerX,
    y: previewStart.centerY,
    deltaX: 0,
    deltaY: WHEEL_DELTA_PX,
  });
  await settle(client);
  const previewAfterWheel = await readScroller(client, PREVIEW_SCROLLER);
  assert.ok(
    previewAfterWheel.scrollLeft > 0,
    `a real wheel over the preview must scroll it (scrollLeft ${previewAfterWheel.scrollLeft})`,
  );
  assert.equal(
    previewAfterWheel.fade.left,
    true,
    `once scrolled the preview's left edge hides something (classes: ${previewAfterWheel.className})`,
  );

  // A real swipe, with touch emulated: a drag from left to right across the
  // readings scrolls the frame the other way from the wheel above, back
  // toward the start.
  await client.send("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    maxTouchPoints: 1,
  });
  await swipe(client, previewAfterWheel, "toward-start");
  await client.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  const previewAfterSwipe = await readScroller(client, PREVIEW_SCROLLER);
  assert.ok(
    previewAfterSwipe.scrollLeft < previewAfterWheel.scrollLeft,
    `a real swipe over the preview must scroll it (before ${previewAfterWheel.scrollLeft}, after ${previewAfterSwipe.scrollLeft})`,
  );

  // ── two accounts at 1400px: everything fits, nothing fades ────────────────
  await client.send("Page.navigate", { url: pageUrl(2) });
  await setViewportWidth(client, WIDE_WIDTH_PX);
  await waitForStrip(client);
  const wide = await readLayout(client);
  assert.equal(wide.segmentCount, 2, "both segments must be drawn");
  assert.ok(
    wide.scroller.scrollWidth <= wide.scroller.clientWidth,
    `two accounts at ${WIDE_WIDTH_PX}px must not overflow (scrollWidth ${wide.scroller.scrollWidth}, clientWidth ${wide.scroller.clientWidth})`,
  );
  assert.deepEqual(
    wide.fade,
    { left: false, right: false },
    `nothing fades when everything fits (classes: ${wide.scroller.className})`,
  );
  assert.equal(
    wide.scroller.maskImage,
    "none",
    "no mask may be applied when nothing is cut off",
  );
  assertResourcesWhole(wide, WIDE_WIDTH_PX);

  console.log(
    `status bar usage-scroll regression passed: narrow ${narrowStart.scroller.scrollWidth}/${narrowStart.scroller.clientWidth}px scrolls with fades right→both→left, resources at right=${narrowStart.resources.right}px; preview ${previewStart.scrollWidth}/${previewStart.clientWidth}px scrolled to ${previewAfterWheel.scrollLeft}px by wheel and back to ${previewAfterSwipe.scrollLeft}px by swipe; wide ${wide.scroller.scrollWidth}/${wide.scroller.clientWidth}px, no fade`,
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

function pageUrl(accounts) {
  return `http://127.0.0.1:${vitePort}${fixtureUrlPath}?accounts=${accounts}`;
}

/**
 * The resource segment has to be entirely inside the viewport and entirely
 * unclipped: the usage cluster is the box that gives way, never this one.
 */
function assertResourcesWhole(layout, viewportWidth) {
  assert.ok(
    layout.resources.left >= 0 && layout.resources.right <= viewportWidth,
    `the resource segment must sit inside the ${viewportWidth}px strip (left ${layout.resources.left}, right ${layout.resources.right})`,
  );
  assert.ok(
    layout.resources.scrollWidth <= layout.resources.clientWidth,
    `the resource segment must not clip its own readings (scrollWidth ${layout.resources.scrollWidth}, clientWidth ${layout.resources.clientWidth})`,
  );
  assert.ok(
    layout.resources.left >= layout.scroller.right,
    `the resource segment must sit to the right of the scroller, not under it (scroller right ${layout.scroller.right}, resources left ${layout.resources.left})`,
  );
}

async function setViewportWidth(client, width) {
  await client.send("Emulation.setDeviceMetricsOverride", {
    width,
    height: 300,
    deviceScaleFactor: 1,
    mobile: false,
  });
}

async function waitForStrip(client) {
  await waitFor(
    client,
    "the strip to mount",
    `document.querySelector('${SCROLLER}') !== null && document.querySelector('${RESOURCES}') !== null`,
  );
  // A frame for the ResizeObserver to deliver the first measurement and the
  // fade state to commit.
  await settle(client);
}

/** Scroll the scroller to the end or the middle, then let the fade catch up. */
async function scrollTo(client, where) {
  await evaluate(
    client,
    `(() => {
       const s = document.querySelector('${SCROLLER}');
       const max = s.scrollWidth - s.clientWidth;
       s.scrollLeft = ${where === "end" ? "max" : "Math.round(max / 2)"};
     })()`,
  );
  await settle(client);
}

/**
 * One scroller's overflow, position, fade and hit-test situation, plus the
 * point to aim real input at.
 */
async function readScroller(client, selector) {
  return evaluate(
    client,
    `(() => {
       const s = document.querySelector('${selector}');
       const rect = s.getBoundingClientRect();
       const className = s.className;
       let inertAncestor = false;
       for (let node = s.parentElement; node !== null; node = node.parentElement) {
         if (node.hasAttribute("inert")) inertAncestor = true;
       }
       const readings = s.querySelector('[data-testid="status-bar-preview-readings"]');
       return {
         scrollWidth: s.scrollWidth,
         clientWidth: s.clientWidth,
         scrollLeft: s.scrollLeft,
         className,
         fade: {
           left: className.includes("to_right,transparent,black_1.5rem"),
           right: className.includes("black_calc(100%-1.5rem),transparent"),
         },
         inertAncestor,
         inertReadings: readings !== null && readings.hasAttribute("inert"),
         left: rect.left,
         right: rect.right,
         centerX: Math.round(rect.left + rect.width / 2),
         centerY: Math.round(rect.top + rect.height / 2),
       };
     })()`,
  );
}

/**
 * A one-finger drag across the scroller. `toward-start` moves the finger
 * left-to-right, which scrolls the content back toward its first account.
 */
async function swipe(client, scroller, direction) {
  const y = scroller.centerY;
  const from =
    direction === "toward-start"
      ? scroller.centerX - SWIPE_DISTANCE_PX / 2
      : scroller.centerX + SWIPE_DISTANCE_PX / 2;
  const step = direction === "toward-start" ? 20 : -20;
  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: from, y }],
  });
  for (let moved = step; Math.abs(moved) <= SWIPE_DISTANCE_PX; moved += step) {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: from + moved, y }],
    });
    await delay(16);
  }
  await client.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  // Touch scrolling decelerates after the finger lifts; give it time to stop.
  await evaluate(client, `new Promise((r) => setTimeout(r, 600))`);
}

async function readLayout(client) {
  return evaluate(
    client,
    `(() => {
       const s = document.querySelector('${SCROLLER}');
       const r = document.querySelector('${RESOURCES}');
       const sRect = s.getBoundingClientRect();
       const rRect = r.getBoundingClientRect();
       const className = s.className;
       return {
         scroller: {
           scrollWidth: s.scrollWidth,
           clientWidth: s.clientWidth,
           scrollLeft: s.scrollLeft,
           right: sRect.right,
           className,
           maskImage: getComputedStyle(s).maskImage,
         },
         fade: {
           left: className.includes("to_right,transparent,black_1.5rem"),
           right: className.includes("black_calc(100%-1.5rem),transparent"),
         },
         resources: {
           left: rRect.left,
           right: rRect.right,
           width: rRect.width,
           scrollWidth: r.scrollWidth,
           clientWidth: r.clientWidth,
         },
         segmentCount: s.querySelectorAll('[data-testid^="status-bar-provider-segment-"]').length,
         foldedChip: s.querySelector('[data-testid="status-bar-folded-providers"]') !== null,
       };
     })()`,
  );
}

function settle(client) {
  return evaluate(client, `new Promise((r) => setTimeout(r, 250))`);
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

function connectCdp(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    let nextId = 0;
    const connectTimer = setTimeout(
      () => reject(new Error("CDP connect timed out")),
      15_000,
    );
    socket.addEventListener("error", (event) =>
      reject(new Error(String(event))),
    );
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (typeof message.id !== "number") return;
      const request = pending.get(message.id);
      if (request === undefined) return;
      pending.delete(message.id);
      if (message.error === undefined) request.resolve(message.result);
      else request.reject(new Error(message.error.message));
    });
    socket.addEventListener("open", () => {
      clearTimeout(connectTimer);
      resolve({
        send(method, params = {}) {
          return new Promise((requestResolve, requestReject) => {
            const id = ++nextId;
            pending.set(id, { resolve: requestResolve, reject: requestReject });
            socket.send(JSON.stringify({ id, method, params }));
          });
        },
        close() {
          socket.close();
        },
      });
    });
  });
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
