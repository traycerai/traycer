// Browser regression for the quit intercept's Cancel path: after Cancel, is the
// window actually usable again?
//
// jsdom cannot answer that - it has no hit testing, so a click reaches a node
// whether or not a real user could reach it, and the best a jsdom fixture can do
// is assert Radix released its `body { pointer-events: none }` lock, which is a
// proxy. This clicks a button behind the modal in a real layout engine.
//
// Structure follows `diff-edit-browser-regression.mjs` (vite + headless Chrome
// over CDP); both are wired into `scripts/run-tests.ts` behind
// RUN_DIFF_EDIT_BROWSER_REGRESSION, which CI sets for this package.
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
const fixtureUrlPath = "/src/__tests__/browser/quit-intercept-cancel.html";
const chromePath = await findChrome();
const profilePath = await mkdtemp(path.join(tmpdir(), "traycer-quit-cancel-"));
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
    `http://127.0.0.1:${devtoolsPort}/json/new?${encodeURIComponent(pageUrl)}`,
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

  await waitFor(
    client,
    "the fixture to mount",
    `Boolean(document.querySelector("#app-button")) && typeof window.__probeEmitQuit === "function"`,
  );

  // The retention is the premise of the whole fixture. Assert it POSITIVELY
  // before anything that depends on it: a fixture whose premise silently did
  // not happen proves nothing, and every later assertion here would still pass
  // on an empty registry.
  const retainedRows = await evaluate(client, `window.__probeRetainedRows()`);
  assert.equal(
    retainedRows,
    1,
    "expected exactly one un-syncable unsynced row (the retained buffer) before the quit request",
  );

  const appButton = await rectCentre(client, "#app-button");
  await click(client, appButton.x, appButton.y);
  await settle(client);
  assert.equal(
    await appClicks(client),
    1,
    "the app button must be clickable BEFORE the modal opens, or this fixture cannot tell a released modal from a broken click",
  );

  // ── Arm 1: the outside-click dismissal path ──────────────────────────────
  //
  // Clicking the app button while the dialog is open is unavoidably ALSO an
  // outside pointer-down on the dialog, so this one gesture measures two
  // things, and both are wanted: the app button must not receive the click
  // (the modal blocks) and the dialog must answer main rather than just
  // vanishing (a dismissal without a decision parks main for ever).
  await emitQuit(client);

  // Opening focus must not sit on the destructive control. This dialog is
  // summoned by a keyboard shortcut, so a default of "Quit and discard" means
  // Cmd+Q then Enter destroys every unsynced edit - and jsdom cannot see focus
  // the way a real focus scope resolves it.
  assert.equal(
    await evaluate(
      client,
      `document.activeElement === null ? "none" : (document.activeElement.getAttribute("data-testid") ?? document.activeElement.tagName.toLowerCase())`,
    ),
    "quit-intercept-cancel",
    "the quit dialog must open with focus on Cancel, not on Quit and discard",
  );

  await click(client, appButton.x, appButton.y);
  await waitFor(
    client,
    "the dialog to close after an outside click",
    `document.querySelector('[data-testid="quit-intercept-dialog"]') === null`,
  );
  await settle(client);
  assert.equal(
    await appClicks(client),
    1,
    "the app button must NOT receive the click that lands on it while the quit dialog is open",
  );
  assert.equal(
    await decision(client),
    "userCancelled",
    "an outside click must RESPOND userCancelled, not merely dismiss",
  );

  // The claim jsdom cannot make: the window is interactive again.
  await click(client, appButton.x, appButton.y);
  await settle(client);
  assert.equal(
    await appClicks(client),
    2,
    "after a cancel the app must accept clicks again - 'the app stayed alive' and 'a decision was sent' both pass without this",
  );
  assert.equal(
    await evaluate(client, `document.body.style.pointerEvents`),
    "",
    "Radix's body pointer-events lock must be released after a cancel",
  );

  // ── Arm 2: the Cancel BUTTON, on a second quit after the first was cancelled
  //
  // Also the second-quit-after-cancel case: quitting is now a state the shell
  // enters and leaves deliberately, so a request arriving after a cancel has to
  // be serviced with its own id rather than swallowed by the resolved one.
  await evaluate(
    client,
    `document.querySelector("#probe-state").setAttribute("data-decision", "")`,
  );
  await emitQuit(client);
  const cancelButton = await rectCentre(
    client,
    '[data-testid="quit-intercept-cancel"]',
  );
  await click(client, cancelButton.x, cancelButton.y);
  await waitFor(
    client,
    "the dialog to close after the Cancel button",
    `document.querySelector('[data-testid="quit-intercept-dialog"]') === null`,
  );
  await settle(client);
  assert.equal(
    await decision(client),
    "userCancelled",
    "the Cancel button must respond userCancelled on a quit request that arrived after an earlier cancel",
  );
  await click(client, appButton.x, appButton.y);
  await settle(client);
  assert.equal(
    await appClicks(client),
    3,
    "the window must be interactive again after the second cancel too",
  );

  // And the point of cancelling: the work is still there.
  assert.equal(
    await evaluate(client, `window.__probeRetainedRows()`),
    1,
    "the retained unsynced buffer must survive a cancel - preserving it is the reason the verb exists",
  );

  console.log(
    "quit-intercept Cancel browser regression passed: modal blocked, both cancel paths responded, window interactive after each, buffer intact",
  );
} catch (error) {
  console.error("QUIT-INTERCEPT CANCEL REGRESSION FAILED:", error);
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

async function emitQuit(client) {
  await evaluate(client, `window.__probeEmitQuit()`);
  await waitFor(
    client,
    "the quit-intercept dialog",
    `document.querySelector('[data-testid="quit-intercept-dialog"]') !== null`,
  );
  await settle(client);
}

async function decision(client) {
  return evaluate(
    client,
    `document.querySelector("#probe-state").getAttribute("data-decision")`,
  );
}

async function appClicks(client) {
  return Number(
    await evaluate(
      client,
      `document.querySelector("#probe-state").getAttribute("data-app-clicks")`,
    ),
  );
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

async function click(client, x, y) {
  await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}
