// Browser regression for the toast close button on touch devices, and for
// where the toaster sits in the installed mobile app.
//
// jsdom cannot answer either: it evaluates no media queries, so a class scoped
// to `(hover: none) and (pointer: coarse)` looks the same on every device, and
// it has no layout, so an offset written as a CSS `calc()` is never resolved.
// This renders the real `Toaster` against the real stylesheet and flips the
// media query with Chrome's touch emulation, which switches both `hover` and
// `pointer` exactly as a phone reports them.
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
const fixtureUrlPath = "/src/__tests__/browser/toast-close-button-touch.html";
const chromePath = await findChrome("the toast close-button touch regression");
const vitePort = await freePort();
const TOUCH_QUERY = "(hover: none) and (pointer: coarse)";
const CLOSE_BUTTON =
  '[data-sonner-toast][data-mounted="true"] [data-close-button]';
// Sonner's 20px close glyph, grown to a 44px hit area on touch.
const TOUCH_HIT_AREA_PX = 44;
let chrome;
let chromeProfilePath;
let client;
let viteProcess;

try {
  const pageUrl = `http://127.0.0.1:${vitePort}${fixtureUrlPath}`;
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
  await waitForHttp(pageUrl, viteProcess, () => viteError, "Vite");

  const launched = await launchChromeWithDevTools(
    chromePath,
    "traycer-toast-touch-",
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
    new URL(`/json/new?${encodeURIComponent(pageUrl)}`, devtoolsUrl),
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
    width: 1200,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await waitForToast(client);

  // --- Desktop: hidden until hover, exactly as before. ---
  await moveMouse(client, 5, 5);
  const desktop = await readCloseButton(client);
  assert.equal(
    desktop.touchQuery,
    false,
    "desktop arm must not match the touch query",
  );
  assert.equal(
    desktop.position,
    "bottom-right",
    "desktop toaster must keep its default anchor",
  );
  assert.equal(
    desktop.opacity,
    "0",
    "desktop close button must be hidden until hover",
  );
  assert.equal(
    desktop.pointerEvents,
    "none",
    "a hidden desktop close button must not take clicks",
  );
  assert.equal(
    desktop.hitNearCorner,
    false,
    "desktop close button must not grow a touch hit area",
  );

  await moveMouse(client, desktop.toastCenter.x, desktop.toastCenter.y);
  const hovered = await readCloseButton(client);
  assert.equal(
    hovered.opacity,
    "1",
    "hovering the toast must reveal the close button",
  );
  assert.equal(
    hovered.pointerEvents,
    "auto",
    "a revealed close button must take clicks",
  );
  await moveMouse(client, 5, 5);

  // --- Touch: sonner's own always-visible default stands. ---
  await client.send("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    maxTouchPoints: 5,
  });
  const touch = await readCloseButton(client);
  assert.equal(
    touch.touchQuery,
    true,
    `touch emulation must match ${TOUCH_QUERY}`,
  );
  assert.equal(
    touch.opacity,
    "1",
    "the close button must be visible without hover on touch",
  );
  assert.equal(
    touch.pointerEvents,
    "auto",
    "the close button must be tappable on touch",
  );
  assert.equal(
    touch.glyphWidth,
    desktop.glyphWidth,
    "the touch hit area must not change the glyph's size",
  );
  assert.equal(touch.hitAreaWidth, TOUCH_HIT_AREA_PX, "touch hit area width");
  assert.equal(touch.hitAreaHeight, TOUCH_HIT_AREA_PX, "touch hit area height");
  assert.equal(
    touch.hitNearCorner,
    true,
    "a tap just outside the glyph must land on the close button",
  );

  await client.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  const desktopAgain = await readCloseButton(client);
  assert.equal(
    desktopAgain.opacity,
    "0",
    "leaving touch must restore the hover-only close button",
  );

  // --- Installed mobile app: top-center, below the header. ---
  await client.send("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    maxTouchPoints: 5,
  });
  const placements = [];
  for (const viewport of [
    // Portrait reads sonner's `mobileOffset` (<=600px) ...
    { width: 390, height: 844 },
    // ... and landscape its `offset`, so both must carry the header offset.
    { width: 844, height: 390 },
  ]) {
    await client.send("Emulation.setDeviceMetricsOverride", {
      ...viewport,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await client.send("Page.navigate", { url: `${pageUrl}?mobile-app=1` });
    await waitForToast(client);
    const mobile = await readCloseButton(client);
    const label = `${viewport.width}x${viewport.height}`;
    assert.equal(
      mobile.position,
      "top-center",
      `mobile app toaster anchor at ${label}`,
    );
    // No device insets headless, so the header's bottom edge is its 2.5rem
    // height and the toaster's top is that plus the 1.25rem gap.
    assert.equal(
      mobile.toasterTop,
      mobile.rootFontPx * 3.75,
      `mobile app toaster top at ${label}`,
    );
    assert.ok(
      mobile.hitAreaTop >= mobile.rootFontPx * 2.5,
      `the close button's hit area must stay clear of the header at ${label} (hit area top ${mobile.hitAreaTop})`,
    );
    assert.equal(
      mobile.opacity,
      "1",
      `mobile app close button visible at ${label}`,
    );
    placements.push(
      `${label} top=${mobile.toasterTop} hitTop=${mobile.hitAreaTop}`,
    );
  }

  console.log(
    "toast close-button touch regression passed: desktop hidden/hover-revealed, touch visible with a 44px hit area, mobile app " +
      placements.join(", "),
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

async function waitForToast(client) {
  await waitFor(
    client,
    "the toast to mount",
    `document.querySelector(${JSON.stringify(CLOSE_BUTTON)}) !== null`,
  );
  // Sonner's enter transition is 400ms; read styles once it has finished.
  await evaluate(client, `new Promise((r) => setTimeout(r, 600))`);
}

async function moveMouse(client, x, y) {
  await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await settle(client);
}

async function readCloseButton(client) {
  await settle(client);
  return evaluate(
    client,
    `(() => {
       const button = document.querySelector(${JSON.stringify(CLOSE_BUTTON)});
       const toast = button.closest("[data-sonner-toast]");
       const toaster = button.closest("[data-sonner-toaster]");
       const style = getComputedStyle(button);
       const after = getComputedStyle(button, "::after");
       const glyph = button.getBoundingClientRect();
       const toastRect = toast.getBoundingClientRect();
       const hitAreaHeight = parseFloat(after.height) || 0;
       const centerX = glyph.left + glyph.width / 2;
       const centerY = glyph.top + glyph.height / 2;
       // Inside a 44px square around the glyph, outside the 20px glyph.
       const probe = document.elementFromPoint(centerX + 18, centerY + 18);
       return {
         touchQuery: matchMedia(${JSON.stringify(TOUCH_QUERY)}).matches,
         position: toaster.dataset.yPosition + "-" + toaster.dataset.xPosition,
         opacity: style.opacity,
         pointerEvents: style.pointerEvents,
         glyphWidth: glyph.width,
         hitAreaWidth: parseFloat(after.width) || 0,
         hitAreaHeight,
         hitAreaTop: centerY - hitAreaHeight / 2,
         hitNearCorner: probe !== null && probe.closest("[data-close-button]") === button,
         toastCenter: {
           x: toastRect.left + toastRect.width / 2,
           y: toastRect.top + toastRect.height / 2,
         },
         toasterTop: toaster.getBoundingClientRect().top,
         rootFontPx: parseFloat(getComputedStyle(document.documentElement).fontSize),
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
