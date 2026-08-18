// Measurement, not a regression test: can a Sonner toast's buttons be clicked
// while a Radix `modal` Dialog is open? Driven in real Chrome because the answer
// is a hit-test question and jsdom has no hit testing.
//
// Structure copied from `diff-edit-browser-regression.mjs` (vite + headless
// Chrome over CDP).
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
const fixtureUrlPath = "/src/__tests__/browser/toast-over-modal.html";
const chromePath = await findChrome();
const profilePath = await mkdtemp(path.join(tmpdir(), "traycer-hittest-"));
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
    "the dialog and the toast to both be painted",
    `Boolean(document.querySelector('[data-testid="probe-dialog"]')) &&
     Boolean(document.querySelector('[data-probe-action]')) &&
     Boolean(document.querySelector('[data-sonner-toast] [data-close-button]'))`,
  );
  // Sonner mounts a toast at `data-mounted=false` and transforms it into place;
  // measuring before that lands would read a rect the user never sees.
  await evaluate(client, `new Promise((r) => setTimeout(r, 700))`);

  const readState = `(() => {
    const toast = document.querySelector('[data-sonner-toast]');
    const action = document.querySelector('[data-probe-action]');
    const closeButton = document.querySelector('[data-sonner-toast] [data-close-button]');
    const dialog = document.querySelector('[data-testid="probe-dialog"]');
    const describe = (el) => {
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      return {
        pointerEvents: getComputedStyle(el).pointerEvents,
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    };
    const hitAt = (p) => {
      if (p === null) return null;
      const el = document.elementFromPoint(p.x, p.y);
      if (el === null) return "NOTHING";
      if (el.closest('[data-probe-action]') !== null) return "probe-action";
      if (el.closest('[data-close-button]') !== null) return "toast-close-button";
      if (el.closest('[data-sonner-toast]') !== null) return "sonner-toast";
      if (el.closest('[data-slot="dialog-content"]') !== null) return "dialog-content";
      if (el.closest('[data-slot="dialog-overlay"]') !== null) return "dialog-overlay";
      return el.tagName.toLowerCase();
    };
    const a = describe(action);
    const c = describe(closeButton);
    return {
      bodyPointerEvents: document.body.style.pointerEvents,
      dialogPresent: dialog !== null,
      toastPointerEvents: toast === null ? null : getComputedStyle(toast).pointerEvents,
      toasterPointerEvents: (() => {
        const list = document.querySelector('[data-sonner-toaster]');
        return list === null ? null : getComputedStyle(list).pointerEvents;
      })(),
      action: a,
      closeButton: c,
      actionHit: hitAt(a),
      closeHit: hitAt(c),
      actionClicks: Number(document.querySelector('#probe-state')?.getAttribute('data-action-clicks')),
    };
  })()`;

  const withModal = await evaluate(client, readState);
  if (withModal.action === null)
    throw new Error("probe action button not found");
  await click(client, withModal.action.x, withModal.action.y);
  await evaluate(client, `new Promise((r) => setTimeout(r, 250))`);
  const afterActionClick = await evaluate(
    client,
    `Number(document.querySelector('#probe-state').getAttribute('data-action-clicks'))`,
  );
  await click(client, withModal.closeButton.x, withModal.closeButton.y);
  await evaluate(client, `new Promise((r) => setTimeout(r, 400))`);
  const toastStillUp = await evaluate(
    client,
    `document.querySelector('[data-sonner-toast]') !== null`,
  );

  // CONTROL ARM. Without it, "the click did not register" is indistinguishable
  // from a broken harness - the failure mode this whole audit keeps finding.
  // Close the dialog through a button INSIDE it (that one is on the layer, so
  // it is clickable by construction), then click the same toast button at its
  // own live coordinates and require the counter to move.
  const dismissPoint = await evaluate(
    client,
    `(() => {
      const el = document.querySelector('[data-probe-dismiss]');
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`,
  );
  if (dismissPoint === null)
    throw new Error("in-dialog dismiss button not found");
  await click(client, dismissPoint.x, dismissPoint.y);
  await evaluate(client, `new Promise((r) => setTimeout(r, 700))`);
  const inDialogClickClosedIt = await evaluate(
    client,
    `document.querySelector('#probe-state').getAttribute('data-dialog-open') === "false"`,
  );
  const dismissPointHit = await evaluate(
    client,
    `(() => {
       const el = document.elementFromPoint(${dismissPoint.x}, ${dismissPoint.y});
       return el === null ? "NOTHING" : (el.getAttribute('data-slot') ?? el.tagName.toLowerCase());
     })()`,
  );
  // Whatever that click did, the control must run: close the dialog directly.
  await evaluate(client, `window.__probeCloseDialog()`);
  await evaluate(client, `new Promise((r) => setTimeout(r, 700))`);
  const withoutModal = await evaluate(client, readState);
  let controlClicks = null;
  if (withoutModal.action !== null) {
    await click(client, withoutModal.action.x, withoutModal.action.y);
    await evaluate(client, `new Promise((r) => setTimeout(r, 250))`);
    controlClicks = await evaluate(
      client,
      `Number(document.querySelector('#probe-state').getAttribute('data-action-clicks'))`,
    );
  }

  console.log(
    JSON.stringify(
      {
        WITH_MODAL_OPEN: withModal,
        actionClicksAfterClickWithModal: afterActionClick,
        toastStillUpAfterCloseClickWithModal: toastStillUp,
        inDialogButtonClickClosedTheDialog: inDialogClickClosedIt,
        whatIsAtTheInDialogButtonsCentre: dismissPointHit,
        CONTROL_dialogClosed: withoutModal,
        actionClicksAfterControlClick: controlClicks,
      },
      null,
      2,
    ),
  );
} catch (error) {
  // Reported here rather than left to propagate: a throw out of `finally`
  // (Chrome still writing its profile when `rm` runs) would replace this one
  // and the real failure would never be printed.
  console.error("MEASUREMENT FAILED:", error);
  process.exitCode = 1;
} finally {
  client?.close();
  chrome?.kill("SIGKILL");
  viteProcess?.kill("SIGKILL");
  await delay(300);
  try {
    await rm(profilePath, { recursive: true, force: true });
  } catch {
    // A leftover temp profile is not a measurement result.
  }
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
