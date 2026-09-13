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
const fixturePath =
  "/src/__tests__/browser/docx-preview-browser-regression.html";
const chromePath = await findChrome("the Word preview browser regression");
const vitePort = await freePort();
let chrome;
let chromeProfilePath;
let client;
let viteProcess;

try {
  const pageUrl = `http://127.0.0.1:${vitePort}${fixturePath}`;
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
      "--force",
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
    "traycer-docx-preview-",
    [],
  );
  chrome = launched.chrome;
  chromeProfilePath = launched.profilePath;
  await waitForHttp(
    new URL("/json/version", launched.devtoolsHttpUrl),
    chrome,
    launched.readError,
    "Chrome DevTools",
  );

  const targetResponse = await fetch(
    new URL(
      `/json/new?${encodeURIComponent(pageUrl)}`,
      launched.devtoolsHttpUrl,
    ),
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
  client = await connectCdp(target.webSocketDebuggerUrl);
  await client.send("Runtime.enable");
  await client.send("Page.enable");
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: 2200,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });

  await waitFor(
    client,
    "both real docx-preview documents",
    `document.querySelectorAll('[data-word-tile] [data-testid="docx-preview-container"]').length === 2 &&
      [...document.querySelectorAll('[data-word-tile]')].every((tile) =>
        tile.querySelector('[data-testid="docx-preview-host"]')?.shadowRoot?.querySelectorAll('section.docx').length === 3)`,
  );

  await resizeTiles(client, { alpha: 280, beta: 1400 });
  await waitFor(
    client,
    "fit-to-width after narrow and wide tile resize",
    `(() => {
      const inspect = (id) => {
        const tile = document.querySelector('[data-word-tile="' + id + '"]');
        const container = tile?.querySelector('[data-testid="docx-preview-container"]');
        const wrapper = tile?.querySelector('[data-testid="docx-preview-host"]')?.shadowRoot?.querySelector('.docx-wrapper');
        if (!(container instanceof HTMLElement) || !(wrapper instanceof HTMLElement)) return null;
        return container.scrollWidth <= container.clientWidth + 2 &&
          wrapper.getBoundingClientRect().width <= container.clientWidth - 32 + 2;
      };
      return inspect('alpha') === true && inspect('beta') === true;
    })()`,
  );
  const fitMeasurements = await evaluate(
    client,
    `(() => {
      const inspect = (id) => {
        const tile = document.querySelector('[data-word-tile="' + id + '"]');
        const container = tile?.querySelector('[data-testid="docx-preview-container"]');
        const wrapper = tile?.querySelector('[data-testid="docx-preview-host"]')?.shadowRoot?.querySelector('.docx-wrapper');
        const zoom = tile?.querySelector('[aria-label="Zoom level"]');
        if (!(container instanceof HTMLElement) || !(wrapper instanceof HTMLElement)) return null;
        return {
          clientWidth: container.clientWidth,
          scrollWidth: container.scrollWidth,
          wrapperWidth: wrapper.getBoundingClientRect().width,
          zoom: zoom?.textContent ?? '',
        };
      };
      return { alpha: inspect('alpha'), beta: inspect('beta') };
    })()`,
  );
  assert.ok(
    fitMeasurements.alpha.clientWidth < fitMeasurements.beta.clientWidth,
    `narrow tile was not narrower: ${JSON.stringify(fitMeasurements)}`,
  );
  assert.ok(
    fitMeasurements.alpha.scrollWidth <= fitMeasurements.alpha.clientWidth + 2,
    `narrow tile overflows horizontally: ${JSON.stringify(fitMeasurements.alpha)}`,
  );
  assert.ok(
    fitMeasurements.beta.scrollWidth <= fitMeasurements.beta.clientWidth + 2,
    `wide tile overflows horizontally: ${JSON.stringify(fitMeasurements.beta)}`,
  );

  const betaZoomBefore = await evaluate(
    client,
    `Number(document.querySelector('[data-word-tile="beta"] [data-testid="docx-preview-host"]')?.shadowRoot?.querySelector('.docx-wrapper')?.style.zoom)`,
  );
  assert.ok(
    Number.isFinite(betaZoomBefore) && betaZoomBefore > 0,
    `wide document has no measurable pre-zoom scale: ${betaZoomBefore}`,
  );
  await clickSelector(
    client,
    '[data-word-tile="beta"]',
    '[aria-label="Zoom in"]',
  );
  await waitFor(
    client,
    "manual zoom on the wide document",
    `Number(document.querySelector('[data-word-tile="beta"] [data-testid="docx-preview-host"]')?.shadowRoot?.querySelector('.docx-wrapper')?.style.zoom) > ${betaZoomBefore}`,
  );
  const betaZoomAfter = await evaluate(
    client,
    `Number(document.querySelector('[data-word-tile="beta"] [data-testid="docx-preview-host"]')?.shadowRoot?.querySelector('.docx-wrapper')?.style.zoom)`,
  );
  assert.ok(
    betaZoomAfter > betaZoomBefore,
    `zoom-in did not increase scale: ${betaZoomBefore} -> ${betaZoomAfter}`,
  );
  await clickSelector(
    client,
    '[data-word-tile="beta"]',
    '[aria-label="Next page"]',
  );
  await waitFor(
    client,
    "the second page after zoom",
    `document.querySelector('[data-word-tile="beta"] [aria-label="Page number"]')?.value === "2"`,
  );
  const pageAlignment = await evaluate(
    client,
    `(() => {
      const tile = document.querySelector('[data-word-tile="beta"]');
      const container = tile?.querySelector('[data-testid="docx-preview-container"]');
      const page = tile?.querySelector('[data-testid="docx-preview-host"]')?.shadowRoot?.querySelectorAll('section.docx')[1];
      if (!(container instanceof HTMLElement) || !(page instanceof HTMLElement)) return null;
      const containerRect = container.getBoundingClientRect();
      const pageRect = page.getBoundingClientRect();
      return { pageTop: pageRect.top, containerTop: containerRect.top, gutter: pageRect.top - containerRect.top };
    })()`,
  );
  assert.ok(
    pageAlignment !== null,
    "could not measure the zoomed page alignment",
  );
  assert.ok(
    Math.abs(pageAlignment.gutter - 16) <= 2,
    `goToPage lost the 16px gutter after zoom: ${JSON.stringify(pageAlignment)}`,
  );

  await clickDocument(client, "alpha");
  await dispatchCtrlA(client);
  const selection = await evaluate(
    client,
    `(() => {
      const selection = window.getSelection();
      const range = selection?.rangeCount === 1 ? selection.getRangeAt(0) : null;
      const alpha = document.querySelector('[data-word-tile="alpha"] [data-testid="docx-preview-host"]');
      const beta = document.querySelector('[data-word-tile="beta"] [data-testid="docx-preview-host"]');
      return {
        text: selection?.toString() ?? '',
        rangeRoot: range?.commonAncestorContainer.getRootNode() === alpha?.shadowRoot,
        includesBeta: (selection?.toString() ?? '').includes('BETA-SEARCH'),
        includesAlpha: (selection?.toString() ?? '').includes('ALPHA-SEARCH'),
        alphaShadow: alpha?.shadowRoot !== null,
        betaShadow: beta?.shadowRoot !== null,
      };
    })()`,
  );
  assert.equal(
    selection.rangeRoot,
    true,
    `select-all range escaped the alpha shadow root: ${JSON.stringify(selection)}`,
  );
  assert.equal(
    selection.includesAlpha,
    true,
    "select-all did not include the active document text",
  );
  assert.equal(
    selection.includesBeta,
    false,
    "select-all included the inactive document text",
  );

  // Keep both wide enough for the inline search button while leaving beta's
  // toolbar inside the emulated viewport for a real pointer click.
  await resizeTiles(client, { alpha: 700, beta: 700 });
  await waitFor(
    client,
    "wide toolbars for independent searches",
    `document.querySelectorAll('[data-word-tile] [aria-label="Search document"]').length === 2`,
  );
  await openSearchAndType(client, "alpha", "ALPHA-SEARCH");
  const alphaHighlights = await getHighlightNames(client, "alpha");
  assert.ok(
    alphaHighlights.length > 0,
    "alpha search painted no CSS highlights",
  );
  await openSearchAndType(client, "beta", "BETA-SEARCH");
  const betaHighlights = await getHighlightNames(client, "beta");
  assert.ok(betaHighlights.length > 0, "beta search painted no CSS highlights");
  assert.deepEqual(
    alphaHighlights.filter((name) => betaHighlights.includes(name)),
    [],
    "two Word viewers shared a CSS highlight name",
  );
  assert.equal(
    await highlightsStillRegistered(client, alphaHighlights),
    true,
    "beta search cleared alpha's highlights",
  );

  await clickSelector(
    client,
    '[data-word-tile="beta"]',
    '[aria-label="Close search"]',
  );
  await waitFor(
    client,
    "beta search to close",
    `document.querySelector('[data-word-tile="beta"] input[aria-label="Find in document"]') === null`,
  );
  assert.equal(
    await highlightsStillRegistered(client, alphaHighlights),
    true,
    "closing beta search cleared alpha's highlights",
  );

  console.log(
    "Word preview browser regression passed (real docx-preview + Chromium)",
  );
} catch (error) {
  console.error("WORD PREVIEW BROWSER REGRESSION FAILED:", error);
  process.exitCode = 1;
} finally {
  client?.close();
  if (chrome !== undefined) await terminateProcessTree(chrome);
  viteProcess?.kill("SIGTERM");
  if (chromeProfilePath !== undefined) {
    await rm(chromeProfilePath, {
      recursive: true,
      force: true,
      maxRetries: 3,
    });
  }
}

async function resizeTiles(client, sizes) {
  await evaluate(
    client,
    `(() => {
      for (const [id, width] of ${JSON.stringify(Object.entries(sizes))}) {
        const tile = document.querySelector('[data-word-tile="' + id + '"]');
        if (!(tile instanceof HTMLElement)) throw new Error('missing tile ' + id);
        tile.style.width = width + 'px';
      }
    })()`,
  );
}

async function clickDocument(client, id) {
  const point = await evaluate(
    client,
    `(() => {
      const page = document.querySelector('[data-word-tile="${id}"] [data-testid="docx-preview-host"]')?.shadowRoot?.querySelector('section.docx');
      if (!(page instanceof HTMLElement)) return null;
      const rect = page.getBoundingClientRect();
      return { x: rect.left + 24, y: rect.top + 48 };
    })()`,
  );
  if (point === null) throw new Error(`could not resolve ${id} document point`);
  await click(client, point.x, point.y);
}

async function dispatchCtrlA(client) {
  await client.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "a",
    code: "KeyA",
    modifiers: 2,
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
  });
  await client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "a",
    code: "KeyA",
    modifiers: 2,
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
  });
  await delay(50);
}

async function openSearchAndType(client, id, query) {
  await clickSelector(
    client,
    `[data-word-tile="${id}"]`,
    '[aria-label="Search document"]',
  );
  await waitFor(
    client,
    `${id} search input`,
    `document.querySelector('[data-word-tile="${id}"] input[aria-label="Find in document"]') !== null`,
  );
  await client.send("Input.insertText", { text: query });
  await waitFor(
    client,
    `${id} search result`,
    `document.querySelector('[data-word-tile="${id}"] [aria-live="polite"]')?.textContent === "1 / 1"`,
  );
}

async function getHighlightNames(client, id) {
  return await evaluate(
    client,
    `(() => {
      const host = document.querySelector('[data-word-tile="${id}"] [data-testid="docx-preview-host"]');
      const shadow = host?.shadowRoot;
      if (shadow === undefined || shadow === null) return [];
      const names = [];
      for (const name of CSS.highlights.keys()) {
        const highlight = CSS.highlights.get(name);
        if (highlight === undefined) continue;
        const ranges = [...highlight];
        if (ranges.some((range) => range.startContainer.getRootNode() === shadow)) {
          names.push(name);
        }
      }
      return names;
    })()`,
  );
}

async function highlightsStillRegistered(client, names) {
  return await evaluate(
    client,
    `(() => ${JSON.stringify(names)}.every((name) => CSS.highlights.get(name) !== undefined))()`,
  );
}

async function clickSelector(client, scopeSelector, selector) {
  const point = await evaluate(
    client,
    `(() => {
      const scope = document.querySelector(${JSON.stringify(scopeSelector)});
      const element = scope?.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLElement)) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`,
  );
  if (point === null)
    throw new Error(`could not resolve ${scopeSelector} ${selector}`);
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

async function connectCdp(url) {
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    let nextId = 0;
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("Timed out connecting to the CDP socket"));
    }, 15_000);
    socket.addEventListener("error", () =>
      reject(new Error("CDP socket failed")),
    );
    socket.addEventListener("close", () => {
      clearTimeout(timer);
      const failure = new Error("CDP socket closed before the request settled");
      for (const request of pending.values()) request.reject(failure);
      pending.clear();
    });
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
      clearTimeout(timer);
      resolve({
        send(method, params) {
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
  const state = await evaluate(
    client,
    `({ text: document.body.innerText, html: document.body.innerHTML.slice(0, 3000) })`,
  );
  throw new Error(
    `Timed out waiting for ${label}:\n${JSON.stringify(state, null, 2)}`,
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
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`${label} exited early: ${readError()}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await delay(150);
  }
  throw new Error(`${label} did not become reachable: ${readError()}`);
}
