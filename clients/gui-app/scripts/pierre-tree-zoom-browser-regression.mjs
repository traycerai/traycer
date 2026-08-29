import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
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
const requireFromDesktop = createRequire(
  path.join(projectRoot, "../desktop/package.json"),
);
const desktopRoot = path.resolve(projectRoot, "../desktop");
const defaultElectronPath = requireFromDesktop("electron");
const { prepareElectronBinary } = requireFromDesktop(
  "./scripts/dev/electron-binary.cjs",
);
const electronPath = prepareElectronBinary(
  defaultElectronPath,
  desktopRoot,
  "Traycer Tree Zoom Test",
);
const vitePort = await freePort();
const devtoolsPort = await freePort();
let electron;
let electronProfilePath;
let electronStdout = "";
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

  const launched = await launchElectron(electronPath, pageUrl, devtoolsPort);
  electron = launched.electron;
  electronProfilePath = launched.profilePath;
  electronStdout = launched.readStdout();
  launched.onStdout((stdout) => {
    electronStdout = stdout;
  });
  const devtoolsUrl = launched.devtoolsHttpUrl;
  const target = await waitForElectronTarget(devtoolsUrl, pageUrl, launched);
  if (typeof target.webSocketDebuggerUrl !== "string") {
    throw new Error("Electron did not return a page debugger URL");
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

  for (const [index, zoom] of zoomLevels.entries()) {
    const requestId = `zoom-${index}`;
    electron.stdin.write(`${JSON.stringify({ id: requestId, zoom })}\n`);
    await waitForValue(
      () => electronStdout,
      (stdout) => stdout.includes(`"id":"${requestId}"`),
      `Electron zoom acknowledgement for ${zoom}`,
      launched.readStderr,
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
  if (electron !== undefined) {
    await terminateElectron(electron);
  }
  viteProcess?.kill("SIGTERM");
  if (electronProfilePath !== undefined) {
    await rm(electronProfilePath, {
      recursive: true,
      force: true,
      maxRetries: 3,
    });
  }
}

async function launchElectron(executable, pageUrl, debuggingPort) {
  const profilePath = await mkdtemp(path.join(tmpdir(), "traycer-tree-zoom-"));
  const electronEnv = { ...process.env };
  delete electronEnv.ELECTRON_RUN_AS_NODE;
  const electronArgs = [
    "--headless",
    "--no-sandbox",
    `--remote-debugging-port=${debuggingPort}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${profilePath}`,
    path.join(
      projectRoot,
      "src/__tests__/browser/pierre-tree-zoom-electron-app",
    ),
    pageUrl,
  ];
  const needsVirtualDisplay =
    process.platform === "linux" && electronEnv.DISPLAY === undefined;
  const electronProcess = spawn(
    needsVirtualDisplay ? "xvfb-run" : executable,
    needsVirtualDisplay
      ? [
          "--auto-servernum",
          "--server-args=-screen 0 1280x1024x24",
          executable,
          ...electronArgs,
        ]
      : electronArgs,
    {
      cwd: projectRoot,
      env: electronEnv,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    },
  );
  let stderr = "";
  let stdout = "";
  let stdoutListener = () => {};
  electronProcess.stderr.setEncoding("utf8");
  electronProcess.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  electronProcess.stdout.setEncoding("utf8");
  electronProcess.stdout.on("data", (chunk) => {
    stdout += chunk;
    stdoutListener(stdout);
  });
  const devtoolsHttpUrl = new URL(`http://127.0.0.1:${debuggingPort}`);
  try {
    await waitForHttp(
      new URL("/json/version", devtoolsHttpUrl).href,
      electronProcess,
      () => stderr,
      "Electron DevTools",
    );
  } catch (error) {
    await terminateElectron(electronProcess);
    await rm(profilePath, { recursive: true, force: true, maxRetries: 3 });
    throw error;
  }
  return {
    electron: electronProcess,
    profilePath,
    devtoolsHttpUrl,
    readStderr: () => stderr,
    readStdout: () => stdout,
    onStdout(listener) {
      stdoutListener = listener;
    },
  };
}

async function waitForElectronTarget(devtoolsUrl, pageUrl, launched) {
  return await waitForValue(
    async () => {
      const response = await fetch(new URL("/json/list", devtoolsUrl));
      if (!response.ok) return [];
      return await response.json();
    },
    (targets) => targets.some((target) => target.url === pageUrl),
    "Electron fixture target",
    launched.readStderr,
    (targets) => targets.find((target) => target.url === pageUrl),
  );
}

async function waitForValue(
  readValue,
  isReady,
  label,
  readError,
  select = (value) => value,
) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const value = await readValue();
    if (isReady(value)) return select(value);
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}:\n${readError()}`);
}

async function terminateElectron(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.stdin.write(`${JSON.stringify({ quit: true })}\n`);
  const deadline = Date.now() + 2_000;
  while (
    child.exitCode === null &&
    child.signalCode === null &&
    Date.now() < deadline
  ) {
    await delay(50);
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // The Electron process group already exited.
  }
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
    if (process.exitCode !== null || process.signalCode !== null) {
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

async function connectCdp(url) {
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    let nextId = 0;
    const failPending = (error) => {
      for (const request of pending.values()) request.reject(error);
      pending.clear();
    };
    const connectTimer = setTimeout(() => {
      reject(new Error("CDP connect timed out"));
      socket.close();
    }, 15_000);
    socket.addEventListener("error", () => {
      const error = new Error("CDP socket failed");
      reject(error);
      failPending(error);
    });
    socket.addEventListener("close", () => {
      clearTimeout(connectTimer);
      failPending(new Error("CDP socket closed"));
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
