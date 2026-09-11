#!/usr/bin/env bun

/**
 * Drive the development-only tab-recovery fixture over CDP.
 *
 * This driver starts an isolated Vite fixture and headless Chrome target. It
 * never attaches to a user's browser or needs a host. Backend/auth behavior
 * is supplied by the fixture's MockRunnerHost; canvas, tab layout,
 * coordinator, IndexedDB history, recovery, and the rendered TabStrip remain
 * real.
 *
 * Run from clients/gui-app/:
 *
 *   bun scripts/tab-recovery-browser-regression.mjs
 */

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
const fixtureUrlPath = "/src/__tests__/browser/tab-recovery.html";
const chromePath = await findChrome("the tab recovery browser regression");
const vitePort = await freePort();
let chrome;
let chromeProfilePath;
let client;
let viteProcess;
let viteError = "";
const runtimeExceptions = [];
const MAX_DIAGNOSTIC_TEXT = 12_000;
const MAX_RUNTIME_EXCEPTIONS = 20;

function appendDiagnostic(target, value) {
  return `${target}${value}`.slice(-MAX_DIAGNOSTIC_TEXT);
}

function connect(webSocketDebuggerUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketDebuggerUrl);
    const pending = new Map();
    let nextId = 0;
    let settled = false;

    const failPending = (error) => {
      for (const request of pending.values()) request.reject(error);
      pending.clear();
    };
    const connectTimeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      const error = new Error("Timed out connecting to CDP after 10 seconds");
      failPending(error);
      reject(error);
      socket.close();
    }, 10_000);
    socket.addEventListener("error", () => {
      const error = new Error("CDP WebSocket failed");
      failPending(error);
      if (!settled) {
        clearTimeout(connectTimeout);
        settled = true;
        reject(error);
      }
    });
    socket.addEventListener("close", (event) => {
      failPending(new Error(`CDP WebSocket closed (${event.code})`));
      if (!settled) {
        clearTimeout(connectTimeout);
        settled = true;
        reject(new Error("CDP socket closed before connection settled"));
      }
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.method === "Runtime.exceptionThrown") {
        const details = message.params?.exceptionDetails;
        const description =
          details?.exception?.description ??
          details?.text ??
          JSON.stringify(details ?? message);
        runtimeExceptions.push(String(description).slice(0, 2_000));
        if (runtimeExceptions.length > MAX_RUNTIME_EXCEPTIONS)
          runtimeExceptions.shift();
      }
      const request = pending.get(message.id);
      if (request === undefined) return;
      pending.delete(message.id);
      if (message.error !== undefined) {
        request.reject(new Error(JSON.stringify(message.error)));
      } else {
        request.resolve(message.result);
      }
    });
    socket.addEventListener("open", () => {
      const send = (method, params) =>
        new Promise((requestResolve, requestReject) => {
          const id = ++nextId;
          pending.set(id, { resolve: requestResolve, reject: requestReject });
          socket.send(JSON.stringify({ id, method, params: params ?? {} }));
        });
      if (!settled) {
        clearTimeout(connectTimeout);
        settled = true;
        resolve({ send, close: () => socket.close() });
      }
    });
  });
}

async function callBridge(client, method, args) {
  const windowResult = await client.send("Runtime.evaluate", {
    expression: "window",
  });
  const objectId = windowResult.result?.objectId;
  if (objectId === undefined) throw new Error("CDP did not return window");
  const result = await client.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `async function(method, args) {
      const bridge = Reflect.get(this, "__traycerTabRecovery");
      if (bridge === undefined) throw new Error("tab recovery bridge disappeared");
      const operation = bridge[method];
      if (typeof operation !== "function") throw new Error("unknown bridge operation: " + method);
      return await operation(...args);
    }`,
    arguments: [{ value: method }, { value: args ?? [] }],
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails !== undefined) {
    throw new Error(
      result.exceptionDetails.exception?.description ??
        JSON.stringify(result.exceptionDetails),
    );
  }
  return result.result?.value;
}

function headerEntry(snapshot) {
  return snapshot.entries.find((entry) => entry.kind === "header");
}

function canvasEntry(snapshot) {
  return snapshot.entries.find((entry) => entry.kind === "canvas");
}

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
  viteProcess.stderr.setEncoding("utf8");
  viteProcess.stderr.on("data", (chunk) => {
    viteError = appendDiagnostic(viteError, chunk);
  });
  await waitForHttp(pageUrl, viteProcess, () => viteError, "Vite");

  const launched = await launchChromeWithDevTools(
    chromePath,
    "traycer-tab-recovery-",
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
    new URL(`/json/new?${encodeURIComponent(pageUrl)}`, devtoolsUrl),
    { method: "PUT" },
  );
  if (!targetResponse.ok) {
    throw new Error(
      `Chrome could not open the fixture: ${targetResponse.status}`,
    );
  }
  const target = await targetResponse.json();
  if (typeof target.webSocketDebuggerUrl !== "string") {
    throw new Error("Chrome did not return a page debugger URL");
  }
  client = await connect(target.webSocketDebuggerUrl);
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
    "the tab recovery fixture to mount",
    `Boolean(document.querySelector('[data-testid="tab-recovery-browser-fixture"]')) && typeof window.__traycerTabRecovery === "object"`,
  );

  await callBridge(client, "reset", []);
  await callBridge(client, "flush", []);
  let state = await callBridge(client, "snapshot", []);
  assert(state.ready, "history did not become ready on startup");
  assert(state.entries.length === 0, "startup history was not empty");

  await clickSelector(client, '[data-testid="recovery-create-draft"]');
  state = await callBridge(client, "snapshot", []);
  const draftId = state.draftIds.at(-1);
  assert(typeof draftId === "string", "draft button did not create a draft");
  await clickSelector(client, '[data-testid="recovery-close-active"]');
  await callBridge(client, "flush", []);
  state = await callBridge(client, "snapshot", []);
  const draftEntry = headerEntry(state);
  assert(
    draftEntry?.items[0]?.id === draftId,
    "closed draft was not journaled",
  );
  assert(
    draftEntry.items[0].hasSnapshot === false,
    "saved draft recovery journal retained an editor snapshot",
  );
  assert(
    state.draftRecords.some(
      (draft) => draft.id === draftId && draft.closed === true,
    ),
    "closed saved draft record was not retained",
  );
  await clickSelector(client, '[data-testid="recovery-reopen"]');
  await waitForRecoveryConsumed(client, "draft recovery");
  await callBridge(client, "flush", []);
  state = await callBridge(client, "snapshot", []);
  assert(state.entries.length === 0, "draft recovery entry was not consumed");
  assert(
    state.draftIds.includes(draftId),
    "draft was not restored to the strip",
  );
  assert(
    state.draftRecords.some(
      (draft) => draft.id === draftId && draft.closed === false,
    ),
    "saved draft record was not reopened",
  );

  const singleTask = await callBridge(client, "createTask", [
    "Single recovery",
  ]);
  const singleFocus = (await callBridge(client, "snapshot", []))
    .activeHeaderItemId;
  await clickSelector(client, '[data-testid="recovery-close-active"]');
  state = await callBridge(client, "snapshot", []);
  assert(
    headerEntry(state)?.bulk === false,
    "single task close was not recorded as a single recovery action",
  );
  await clickSelector(client, '[data-testid="recovery-reopen"]');
  await waitForRecoveryConsumed(client, "single task recovery");
  state = await callBridge(client, "snapshot", []);
  assert(
    state.openTaskIds.includes(singleTask),
    "single task was not restored",
  );
  assert(
    state.activeHeaderItemId === singleFocus,
    "single task recovery did not restore focus",
  );

  const taskA = await callBridge(client, "createTask", ["Recovery A"]);
  const taskB = await callBridge(client, "createTask", ["Recovery B"]);
  const taskC = await callBridge(client, "createTask", ["Surviving focus"]);
  const focusBeforeBulk = (await callBridge(client, "snapshot", []))
    .activeHeaderItemId;
  await callBridge(client, "closeBulk", [
    [
      { kind: "epic", id: taskA },
      { kind: "epic", id: taskB },
    ],
  ]);
  state = await callBridge(client, "snapshot", []);
  const bulkEntry = headerEntry(state);
  assert(bulkEntry?.bulk === true, "bulk task close was not grouped");
  await clickSelector(client, '[data-testid="recovery-reopen"]');
  await waitForRecoveryConsumed(client, "bulk task recovery");
  state = await callBridge(client, "snapshot", []);
  assert(state.entries.length === 0, "bulk recovery entry was not consumed");
  assert(state.openTaskIds.includes(taskA), "bulk task A was not restored");
  assert(state.openTaskIds.includes(taskB), "bulk task B was not restored");
  assert(
    state.activeHeaderItemId === focusBeforeBulk &&
      state.openTaskIds.includes(taskC),
    "bulk restore changed the surviving header focus",
  );

  const splitTask = await callBridge(client, "createTask", ["Split recovery"]);
  await callBridge(client, "seedInnerSplit", [splitTask]);
  state = await callBridge(client, "snapshot", []);
  const splitBeforeClose = state.canvases[splitTask];
  assert(
    splitBeforeClose?.panes.length === 2,
    "inner split fixture did not create two panes",
  );
  const closedPane = splitBeforeClose.panes.find((pane) =>
    pane.tabInstanceIds.includes("inst-a"),
  );
  assert(closedPane !== undefined, "closed inner pane was not found");
  await callBridge(client, "closeInnerTile", [
    splitTask,
    closedPane.id,
    "inst-a",
  ]);
  state = await callBridge(client, "snapshot", []);
  assert(canvasEntry(state) !== undefined, "inner close was not journaled");
  await clickSelector(client, '[data-testid="recovery-reopen"]');
  await waitForRecoveryConsumed(client, "inner split recovery");
  state = await callBridge(client, "snapshot", []);
  assert(canvasEntry(state) === undefined, "inner recovery entry remained");
  assert(
    state.canvases[splitTask]?.panes.some((pane) =>
      pane.tabInstanceIds.includes("inst-a"),
    ),
    "closed inner tile was not restored",
  );

  const emptySplitTask = await callBridge(client, "createTask", [
    "Empty split recovery",
  ]);
  const emptyPaneId = await callBridge(client, "seedEmptySplit", [
    emptySplitTask,
  ]);
  state = await callBridge(client, "snapshot", []);
  assert(
    state.canvases[emptySplitTask]?.panes.some(
      (pane) => pane.id === emptyPaneId && pane.tabInstanceIds.length === 0,
    ),
    "empty split fixture did not preserve its empty pane",
  );
  await callBridge(client, "closeEmptyPane", [emptySplitTask, emptyPaneId]);
  await callBridge(client, "flush", []);
  state = await callBridge(client, "snapshot", []);
  const emptyPaneEntry = canvasEntry(state);
  assert(emptyPaneEntry !== undefined, "empty pane close was not journaled");
  assert(
    emptyPaneEntry.items?.paneIds?.includes(emptyPaneId),
    "empty pane recovery did not record the closed pane",
  );
  await client.send("Page.reload", { ignoreCache: false });
  await waitFor(
    client,
    "the tab recovery fixture to remount after empty pane reload",
    `Boolean(document.querySelector('[data-testid="tab-recovery-browser-fixture"]')) && typeof window.__traycerTabRecovery === "object"`,
  );
  await waitForRecoveryReady(client, "empty pane recovery history");
  state = await callBridge(client, "snapshot", []);
  assert(
    canvasEntry(state)?.items?.paneIds?.includes(emptyPaneId),
    "empty pane recovery was not persisted",
  );
  await clickSelector(client, '[data-testid="recovery-reopen"]');
  await waitForRecoveryConsumed(client, "empty pane recovery");
  state = await callBridge(client, "snapshot", []);
  assert(
    canvasEntry(state) === undefined,
    "empty pane recovery entry remained",
  );
  assert(
    state.canvases[emptySplitTask]?.panes.some(
      (pane) => pane.id === emptyPaneId && pane.tabInstanceIds.length === 0,
    ),
    "closed empty pane was not restored",
  );

  const persistedDraft = await callBridge(client, "createDraft", []);
  await clickSelector(client, '[data-testid="recovery-close-active"]');
  await callBridge(client, "flush", []);
  await client.send("Page.reload", { ignoreCache: false });
  await waitFor(
    client,
    "the tab recovery fixture to remount after reload",
    `Boolean(document.querySelector('[data-testid="tab-recovery-browser-fixture"]')) && typeof window.__traycerTabRecovery === "object"`,
  );
  await waitForRecoveryReady(client, "reloaded recovery history");
  state = await callBridge(client, "snapshot", []);
  assert(
    headerEntry(state)?.items.some((item) => item.id === persistedDraft),
    "closed draft did not survive a page reload",
  );
  await clickSelector(client, '[data-testid="recovery-reopen"]');
  await waitForRecoveryConsumed(client, "reloaded draft recovery");
  state = await callBridge(client, "snapshot", []);
  assert(state.entries.length === 0, "reloaded history was not consumed");

  const duplicateTask = await callBridge(client, "createTask", [
    "Duplicate guard",
  ]);
  assert(
    typeof duplicateTask === "string",
    "duplicate guard task was not created",
  );
  await clickSelector(client, '[data-testid="recovery-close-active"]');
  await clickSelector(client, '[data-testid="recovery-reopen"]');
  await waitForRecoveryConsumed(client, "duplicate guard recovery");
  const afterFirstReopen = await callBridge(client, "snapshot", []);
  await clickSelector(client, '[data-testid="recovery-reopen"]');
  await waitFor(
    client,
    "empty-history reopen completion",
    `window.__traycerTabRecovery?.snapshot().completedReopens > ${afterFirstReopen.completedReopens}`,
  );
  const afterSecondReopen = await callBridge(client, "snapshot", []);
  assert(
    JSON.stringify(afterSecondReopen.headerTabs) ===
      JSON.stringify(afterFirstReopen.headerTabs),
    "reopening without history changed the header tabs",
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        page: pageUrl,
        checks: [
          "startup-empty-history",
          "draft-close-reopen",
          "single-and-bulk-task-recovery",
          "inner-split-recovery",
          "empty-pane-recovery-and-persistence",
          "reload-persisted-history",
          "duplicate-reopen-no-op",
        ],
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    "TAB RECOVERY BROWSER REGRESSION FAILED:",
    JSON.stringify(
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    ),
  );
  if (viteError.trim() !== "")
    console.error("VITE STDERR (latest output):", JSON.stringify(viteError));
  if (runtimeExceptions.length > 0)
    console.error(
      "CDP RUNTIME EXCEPTIONS (latest output):",
      JSON.stringify(runtimeExceptions),
    );
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
      // The process is still starting its listener.
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
  return response.result?.value;
}

async function waitFor(client, label, expression) {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(client, expression)) return;
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  let pageState = null;
  try {
    pageState = await evaluate(
      client,
      `({
        text: document.body.innerText,
        html: document.body.innerHTML.slice(0, 3000),
        errors: window.__traycerTabRecoveryErrors ?? [],
        recovery: window.__traycerTabRecovery?.snapshot?.() ?? null,
      })`,
    );
  } catch (error) {
    lastError = error;
  }
  throw new Error(
    `Timed out waiting for ${label}: ${JSON.stringify(pageState)}`,
    { cause: lastError },
  );
}

async function waitForRecoveryReady(client, label) {
  await waitFor(
    client,
    label,
    `Boolean(window.__traycerTabRecovery?.snapshot().ready)`,
  );
}

async function waitForRecoveryConsumed(client, label) {
  await waitFor(
    client,
    label,
    `window.__traycerTabRecovery?.snapshot().entries.length === 0`,
  );
}

async function rectCentre(client, selector) {
  const point = await evaluate(
    client,
    `(() => {
       const element = document.querySelector(${JSON.stringify(selector)});
       if (element === null) return null;
       const rect = element.getBoundingClientRect();
       return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
     })()`,
  );
  if (point === null) throw new Error(`element not found: ${selector}`);
  return point;
}

async function clickSelector(client, selector) {
  const point = await rectCentre(client, selector);
  await click(client, point.x, point.y);
}

async function click(client, x, y) {
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
  });
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
