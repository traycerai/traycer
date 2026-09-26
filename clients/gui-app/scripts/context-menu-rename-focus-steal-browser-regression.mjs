// Real-Chrome regression for the "Edit Title" pointer-drift focus steal (see
// the fixture doc comment). Structure follows `destructive-dialog-focus-
// browser.mjs`. Not wired into `scripts/run-tests.ts` - run it directly:
//   bun run scripts/context-menu-rename-focus-steal-browser-regression.mjs
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
const fixtureUrlPath =
  "/src/__tests__/browser/context-menu-rename-focus-steal.html";
const chromePath = await findChrome(
  "the context-menu rename focus-steal regression",
);
const vitePort = await freePort();
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
    "traycer-rename-focus-steal-",
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
  client = await connectCdp(target.webSocketDebuggerUrl);
  await client.send("Runtime.enable");
  await client.send("Page.enable");
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: 800,
    height: 600,
    deviceScaleFactor: 1,
    mobile: false,
  });

  await waitFor(
    client,
    "the fixture trigger to mount",
    `document.querySelector('[data-testid="fixture-trigger"]') !== null`,
  );

  const triggerPoint = await centerOf(client, "fixture-trigger");
  await rightClick(client, triggerPoint.x, triggerPoint.y);
  await waitFor(
    client,
    "the context menu to open",
    `document.querySelector('[data-testid="fixture-edit-title"]') !== null`,
  );

  const itemPoint = await centerOf(client, "fixture-edit-title");
  await click(client, itemPoint.x, itemPoint.y);
  await waitFor(
    client,
    "the rename input to mount and focus",
    `document.querySelector('[data-testid="fixture-input"]') !== null &&
     document.activeElement === document.querySelector('[data-testid="fixture-input"]')`,
  );

  // Measured real-Chrome race: ~40ms after select the menu is still
  // mid-exit, and a 2px pointer drift is enough to refocus the closing item.
  await delay(40);
  const closingItem = await evaluate(
    client,
    `(() => {
      const item = document.querySelector('[data-testid="fixture-edit-title"]');
      if (!(item instanceof HTMLElement)) return null;
      const content = item.closest('[data-slot="context-menu-content"]');
      const rect = item.getBoundingClientRect();
      return {
        dataState: content instanceof HTMLElement ? content.getAttribute("data-state") : null,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
    })()`,
  );
  if (closingItem === null) {
    throw new Error(
      "the 'Edit Title' item was already gone before the pointer-move probe - " +
        "the race this test targets needs it still mounted mid-exit-animation",
    );
  }
  assert.equal(
    closingItem.dataState,
    "closed",
    "the menu content was not mid-exit ('data-state=closed') at the probe point - " +
      "the pointer-move race this test targets did not set up",
  );
  await moveMouse(client, closingItem.x + 2, closingItem.y + 2);
  // Give a real blur/focus/React-commit cycle time to run, well inside the
  // ~150ms exit animation so a pass is not just "the menu finished closing".
  await delay(30);

  const outcome = await evaluate(
    client,
    `(() => {
      const input = document.querySelector('[data-testid="fixture-input"]');
      const active = document.activeElement;
      return {
        inputPresent: input !== null,
        inputFocused: input !== null && active === input,
        activeTestId: active instanceof HTMLElement ? active.getAttribute("data-testid") : null,
        activeRole: active instanceof HTMLElement ? active.getAttribute("role") : null,
      };
    })()`,
  );

  assert.equal(
    outcome.inputPresent,
    true,
    `the rename input closed itself during the menu's exit animation: ${JSON.stringify(outcome)}`,
  );
  assert.equal(
    outcome.inputFocused,
    true,
    `a 2px pointer drift over the closing "Edit Title" item stole focus from the rename input: ${JSON.stringify(outcome)}`,
  );
  console.log("context-menu rename focus-steal regression passed");
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

async function centerOf(client, testId) {
  const point = await evaluate(
    client,
    `(() => {
      const element = document.querySelector('[data-testid="${testId}"]');
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
    throw new Error(`Could not resolve a click point for "${testId}"`);
  }
  return point;
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

async function moveMouse(client, x, y) {
  await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
}

async function click(client, x, y) {
  await moveMouse(client, x, y);
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

async function rightClick(client, x, y) {
  await moveMouse(client, x, y);
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "right",
    buttons: 2,
    clickCount: 1,
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "right",
    buttons: 0,
    clickCount: 1,
  });
}
