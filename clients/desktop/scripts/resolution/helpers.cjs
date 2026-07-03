#!/usr/bin/env bun
"use strict";

const { Buffer } = require("node:buffer");
const { mkdir, readdir, readFile, writeFile } = require("node:fs/promises");
const path = require("node:path");

async function waitForInspectablePage(port, timeoutMs) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`);
      if (response.ok) {
        const targets = await response.json();
        const page = targets.find(
          (target) =>
            target.type === "page" &&
            typeof target.webSocketDebuggerUrl === "string",
        );
        if (page !== undefined) return page;
      }
    } catch (err) {
      lastError = err;
    }
    await sleep(250);
  }
  throw new Error(
    `Timed out waiting for Electron CDP page on port ${port}${
      lastError === null ? "" : `: ${String(lastError)}`
    }`,
  );
}

async function connectCdp(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 1;

  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (typeof message.id !== "number") return;
    const deferred = pending.get(message.id);
    if (deferred === undefined) return;
    pending.delete(message.id);
    if (message.error !== undefined) {
      deferred.reject(new Error(JSON.stringify(message.error)));
      return;
    }
    deferred.resolve(message.result);
  });

  return {
    send(method, params) {
      const id = nextId;
      nextId += 1;
      const payload =
        params === undefined ? { id, method } : { id, method, params };
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify(payload));
      });
    },
    close() {
      socket.close();
    },
  };
}

async function waitForRendererReady(client, timeoutMs) {
  await client.send("Page.enable", undefined);
  await client.send("Runtime.enable", undefined);
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await evaluate(client, "document.readyState");
    if (result === "complete" || result === "interactive") return;
    await sleep(250);
  }
  throw new Error("Timed out waiting for renderer document readiness");
}

async function applyResolutionViewport(client, scenario) {
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: scenario.width,
    height: scenario.height,
    deviceScaleFactor: scenario.scaleFactor,
    mobile: false,
    screenWidth: scenario.width,
    screenHeight: scenario.height,
  });
  try {
    await client.send("Emulation.setVisibleSize", {
      width: scenario.width,
      height: scenario.height,
    });
  } catch {
    // Some Electron/Chromium combinations reject setVisibleSize outside
    // headless mode. Device metrics override is the important deterministic
    // viewport control for the screenshot and measurement helpers.
  }
}

async function captureScreenshot(client, filePath) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const result = await client.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  await writeFile(filePath, Buffer.from(result.data, "base64"));
}

async function evaluateCurrentZoom(client, forcedScaleFactor) {
  const metrics = await evaluate(
    client,
    `(() => {
      const viewport = window.visualViewport;
      return {
        devicePixelRatio: window.devicePixelRatio,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        outerWidth: window.outerWidth,
        outerHeight: window.outerHeight,
        visualViewportScale: viewport === null ? null : viewport.scale
      };
    })()`,
  );
  return {
    ...metrics,
    estimatedZoomFactor: round(metrics.devicePixelRatio / forcedScaleFactor),
  };
}

async function measureFirstTabWidth(client) {
  return await evaluate(
    client,
    `(() => {
      const tab = document.querySelector('[role="tab"][data-testid^="tab-"]');
      if (tab === null) return null;
      const rect = tab.getBoundingClientRect();
      return {
        testId: tab.getAttribute("data-testid"),
        width: Math.round(rect.width * 100) / 100,
        height: Math.round(rect.height * 100) / 100
      };
    })()`,
  );
}

async function readZoomPreference(profileDir) {
  const jsonFiles = await collectJsonFiles(profileDir, 4);
  const zoomNamed = jsonFiles.filter((filePath) =>
    /zoom|display|scale/i.test(path.basename(filePath)),
  );
  const otherNamed = jsonFiles.filter(
    (filePath) => !/zoom|display|scale/i.test(path.basename(filePath)),
  );

  for (const filePath of zoomNamed.concat(otherNamed)) {
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (containsZoomPreference(parsed)) {
        return { path: filePath, value: parsed };
      }
    } catch {
      // Ignore unrelated or partially-written JSON files in throwaway profiles.
    }
  }
  return null;
}

async function evaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails !== undefined) {
    throw new Error(JSON.stringify(result.exceptionDetails));
  }
  return result.result.value;
}

async function collectJsonFiles(rootDir, maxDepth) {
  const found = [];
  await walk(rootDir, 0, found, maxDepth);
  return found;
}

async function walk(dir, depth, found, maxDepth) {
  if (depth > maxDepth) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath, depth + 1, found, maxDepth);
        return;
      }
      if (entry.isFile() && entry.name.endsWith(".json")) {
        found.push(entryPath);
      }
    }),
  );
}

function containsZoomPreference(value) {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsZoomPreference);
  return Object.entries(value).some(([key, child]) => {
    if (/zoom|scaleFactor|displayScale/i.test(key)) return true;
    return containsZoomPreference(child);
  });
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  applyResolutionViewport,
  captureScreenshot,
  connectCdp,
  evaluateCurrentZoom,
  measureFirstTabWidth,
  readZoomPreference,
  waitForInspectablePage,
  waitForRendererReady,
};
