// The boot card's escape hatch must survive its own surface being replaced
// mid-press.
//
// WHY A BROWSER GATE. The defect is an input-dispatch fact, not a React fact:
// when the element a press started on leaves the document before release,
// Chromium emits NO `click`, so an `onClick` handler never runs and the
// navigation never happens. jsdom has no input pipeline - Testing Library
// dispatches `click` directly - so every jsdom test of this button passes on
// the broken build. This driver presses with `Input.dispatchMouseEvent`,
// swaps the surface while the button is held, releases, and counts.
//
// Reproduced from a CDP capture of a real user press on the shipped card:
// pointerdown/mousedown on `host-boot-open-settings`, mouseup 198ms later on
// the tree that replaced it, and no click event at all.
//
//   bun scripts/boot-escape-hatch-press-browser.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const fixtureUrlPath = "/src/__tests__/browser/boot-escape-hatch-press.html";
const BUTTON = '[data-testid="host-boot-open-settings"]';
const chromePath = await findChrome();
const profilePath = await mkdtemp(path.join(tmpdir(), "traycer-boot-press-"));
const vitePort = await freePort();
let devtoolsPort = await freePort();
while (devtoolsPort === vitePort) devtoolsPort = await freePort();
let chrome;
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

  chrome = spawn(
    chromePath,
    [
      "--headless=new",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-features=Translate",
      "--disable-sync",
      "--no-default-browser-check",
      "--no-first-run",
      "--no-sandbox",
      `--remote-debugging-port=${devtoolsPort}`,
      `--user-data-dir=${profilePath}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let chromeError = "";
  chrome.stderr.setEncoding("utf8");
  chrome.stderr.on("data", (chunk) => {
    chromeError += chunk;
  });
  await waitForHttp(
    `http://127.0.0.1:${devtoolsPort}/json/version`,
    chrome,
    () => chromeError,
    "Chrome DevTools",
  );
  const targetResponse = await fetch(
    `http://127.0.0.1:${devtoolsPort}/json/new?about:blank`,
    { method: "PUT" },
  );
  if (!targetResponse.ok) {
    throw new Error(`Chrome could not open a page: ${targetResponse.status}`);
  }
  const target = await targetResponse.json();
  client = await connectCdp(target.webSocketDebuggerUrl);
  await client.send("Runtime.enable");
  await client.send("Page.enable");
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: 1200,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await client.send("Page.navigate", { url: pageUrl });
  await waitFor(
    client,
    "the boot card",
    `document.querySelector(${JSON.stringify(BUTTON)}) !== null &&
     typeof window.__bootEscapeHatchProbe === "object"`,
  );
  await settle(client);

  // ── THE MEASURED PREMISE ────────────────────────────────────────────────
  // An ordinary press and release, no swap: exactly one activation. This runs
  // first because it is what makes the swap case meaningful - if the button
  // never activated at all, "it activates across a swap" would be satisfied by
  // a fixture that is simply broken, and a double-fire would hide here.
  await reset(client);
  const centre = await rectCentre(client, BUTTON);
  await press(client, centre, "left");
  await release(client, centre, "left");
  await settle(client);
  assert.equal(
    await activations(client),
    1,
    "an ordinary click must activate the escape hatch exactly once",
  );

  // ── THE REGRESSION ──────────────────────────────────────────────────────
  // Press, replace the surface under the held pointer, release. Before the
  // fix this was 0: Chromium emitted no click, so `onClick` never ran.
  await reset(client);
  const heldCentre = await rectCentre(client, BUTTON);
  assert.equal(
    await evaluate(client, `window.__bootEscapeHatchProbe.captureButton()`),
    true,
    "the fixture must be able to hold a reference to the pressed button",
  );
  await press(client, heldCentre, "left");
  await evaluate(client, `window.__bootEscapeHatchProbe.swap()`);
  // The swap must genuinely DETACH the pressed node. If React reconciled the
  // two surfaces into the same element, the browser would still fire a click
  // and this case would pass without testing anything.
  await waitFor(
    client,
    "the pressed button to be detached by the surface swap",
    `window.__bootEscapeHatchProbe.capturedIsConnected() === false &&
     document.querySelector(${JSON.stringify(BUTTON)}) !== null`,
  );
  await release(client, heldCentre, "left");
  await settle(client);
  assert.equal(
    await activations(client),
    1,
    "a press on the escape hatch must activate it even when the boot surface " +
      "is replaced before the release (no click event is emitted at all)",
  );

  // ── NON-PRIMARY BUTTON ──────────────────────────────────────────────────
  // Press-start activation must not turn a right-click into a navigation.
  await reset(client);
  const rightCentre = await rectCentre(client, BUTTON);
  await press(client, rightCentre, "right");
  await release(client, rightCentre, "right");
  await settle(client);
  assert.equal(
    await activations(client),
    0,
    "a secondary-button press must not activate the escape hatch",
  );

  console.log(
    "BOOT ESCAPE HATCH PRESS REGRESSION PASSED: activates once on an ordinary " +
      "click, activates across a surface swap that emits no click, and ignores " +
      "a secondary-button press.",
  );
} catch (error) {
  console.error("BOOT ESCAPE HATCH PRESS REGRESSION FAILED:", error);
  process.exitCode = 1;
} finally {
  client?.close();
  chrome?.kill("SIGKILL");
  viteProcess?.kill("SIGKILL");
  await delay(300);
  try {
    await rm(profilePath, { recursive: true, force: true });
  } catch {
    // A leftover temp profile is not a test result.
  }
}

async function reset(client) {
  await evaluate(client, `window.__bootEscapeHatchProbe.reset()`);
  await waitFor(
    client,
    "the runtime boot surface after reset",
    `document.querySelector('[data-testid="host-runtime-boot-fallback"]') !== null &&
     window.__bootEscapeHatchProbe.activations() === 0`,
  );
  await settle(client);
}

function activations(client) {
  return evaluate(client, `window.__bootEscapeHatchProbe.activations()`);
}

async function press(client, point, button) {
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button,
    buttons: button === "left" ? 1 : 2,
    clickCount: 1,
  });
}

async function release(client, point, button) {
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button,
    buttons: 0,
    clickCount: 1,
  });
}

async function rectCentre(client, selector) {
  const point = await evaluate(
    client,
    `(() => {
       const el = document.querySelector(${JSON.stringify(selector)});
       if (el === null) return null;
       const r = el.getBoundingClientRect();
       return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
     })()`,
  );
  if (point === null) throw new Error(`element not found: ${selector}`);
  return point;
}

function settle(client) {
  return evaluate(client, `new Promise((r) => setTimeout(r, 250))`);
}

async function findChrome() {
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error("No Chrome/Chromium binary found");
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
