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
const fixturePath = "/src/__tests__/browser/pierre-tree-zoom.html";
const zoomLevels = [0.8, 0.9, 1, 1.1, 1.25];
const chromePath = await findChrome();
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

  const chromeEnv = { ...process.env };
  delete chromeEnv.DBUS_SESSION_BUS_ADDRESS;
  const launched = await launchChrome(chromePath, chromeEnv);
  chrome = launched.chrome;
  chromeProfilePath = launched.profilePath;
  const devtoolsUrl = new URL(launched.webSocketUrl);
  devtoolsUrl.protocol = "http:";
  devtoolsUrl.pathname = "";
  devtoolsUrl.search = "";
  devtoolsUrl.hash = "";

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
  client = await connectCdp(target.webSocketDebuggerUrl);
  await client.send("Runtime.enable");
  await client.send("Page.enable");

  await waitFor(
    client,
    "both Pierre trees",
    `document.querySelectorAll("file-tree-container").length === 2 &&
      [...document.querySelectorAll("file-tree-container")].every(
        (tree) => tree.shadowRoot?.querySelector("[data-truncate-marker]") !== null,
      )`,
  );

  for (const zoom of zoomLevels) {
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: 1000,
      height: 800,
      deviceScaleFactor: zoom,
      mobile: false,
    });
    await evaluate(
      client,
      `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
    );

    const result = await evaluate(
      client,
      `(() => {
        const inspect = (name) => {
          const host = document.querySelector('[data-tree-case="' + name + '"]');
          const tree = host?.querySelector("file-tree-container");
          const root = tree?.shadowRoot;
          const markers = [...(root?.querySelectorAll("[data-truncate-marker]") ?? [])];
          return {
            rows: root?.querySelectorAll('button[data-type="item"]').length ?? 0,
            markerOpacities: markers.map((marker) => getComputedStyle(marker).opacity),
          };
        };
        return {
          devicePixelRatio,
          roomy: inspect("roomy"),
          overflow: inspect("overflow"),
        };
      })()`,
    );

    assert.ok(
      Math.abs(result.devicePixelRatio - zoom) < 0.0001,
      `CDP did not apply zoom ${zoom}: ${result.devicePixelRatio}`,
    );
    assert.ok(result.roomy.rows > 0, `roomy tree has no rows at zoom ${zoom}`);
    assert.ok(
      result.roomy.markerOpacities.length > 0,
      `roomy tree has no truncation markers at zoom ${zoom}`,
    );
    assert.ok(
      result.roomy.markerOpacities.every((opacity) => opacity === "0"),
      `roomy names gained an ellipsis at zoom ${zoom}: ${result.roomy.markerOpacities.join(", ")}`,
    );
    assert.ok(
      result.overflow.markerOpacities.some((opacity) => opacity === "1"),
      `genuine overflow lost its ellipsis at zoom ${zoom}`,
    );
  }

  console.log(
    `Pierre tree zoom regression passed at ${zoomLevels.join(", ")}x over CDP`,
  );
} finally {
  client?.close();
  if (chrome !== undefined) chrome.kill("SIGTERM");
  viteProcess?.kill("SIGTERM");
  if (chromeProfilePath !== undefined) {
    await rm(chromeProfilePath, {
      recursive: true,
      force: true,
      maxRetries: 3,
    });
  }
}

async function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter((candidate) => candidate !== undefined);
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next platform-standard location.
    }
  }
  throw new Error("Chrome is required for the Pierre tree zoom regression");
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = createTcpServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a debugging port"));
        return;
      }
      server.close();
      resolve(address.port);
    });
  });
}

async function waitForHttp(url, process, readError, label) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) {
      throw new Error(`${label} exited before it was ready:\n${readError()}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The server has not bound yet.
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}:\n${readError()}`);
}

async function launchChrome(chromeExecutable, env) {
  const profilePath = await mkdtemp(path.join(tmpdir(), "traycer-tree-zoom-"));
  const chromeProcess = spawn(
    chromeExecutable,
    [
      "--headless=new",
      "--disable-background-networking",
      "--disable-extensions",
      "--no-first-run",
      "--no-sandbox",
      "--remote-debugging-port=0",
      `--user-data-dir=${profilePath}`,
      "about:blank",
    ],
    { env, stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  chromeProcess.stderr.setEncoding("utf8");
  chromeProcess.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (match?.[1] !== undefined) {
      return { chrome: chromeProcess, profilePath, webSocketUrl: match[1] };
    }
    if (chromeProcess.exitCode !== null) {
      throw new Error(`Chrome exited before CDP was ready:\n${stderr}`);
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for Chrome CDP:\n${stderr}`);
}

async function connectCdp(url) {
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    let nextId = 0;
    socket.addEventListener("error", () =>
      reject(new Error("CDP socket failed")),
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

async function evaluate(cdp, expression) {
  const response = await cdp.send("Runtime.evaluate", {
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

async function waitFor(cdp, label, expression) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, expression)) return;
    await delay(50);
  }
  const state = await evaluate(
    cdp,
    `({
      html: document.body.innerHTML.slice(0, 4000),
      text: document.body.innerText,
      customElements: [...document.querySelectorAll("*")]
        .map((element) => element.localName)
        .filter((name) => name.includes("tree")),
      viteError: document.querySelector("vite-error-overlay")?.shadowRoot?.textContent ?? "",
    })`,
  );
  throw new Error(
    `Timed out waiting for ${label}:\n${JSON.stringify(state, null, 2)}`,
  );
}
