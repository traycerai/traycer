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
const fixtureUrlPath = "/src/__tests__/browser/diff-edit-focus.html";
const chromePath = await findChrome("the diff edit browser regression");
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
    "traycer-diff-edit-",
  );
  chrome = launched.chrome;
  chromeProfilePath = launched.profilePath;
  const readChromeError = launched.readError;
  const devtoolsUrl = launched.devtoolsHttpUrl;
  await waitForHttp(
    new URL("/json/version", devtoolsUrl).href,
    chrome,
    readChromeError,
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
  client = await connectCdp(target.webSocketDebuggerUrl);
  await client.send("Runtime.enable");
  await client.send("Page.enable");
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: 1000,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });

  await waitFor(
    client,
    "the painted split diff",
    `Boolean(document.querySelector("diffs-container")?.shadowRoot?.querySelector('[data-additions] [data-content] > [data-line="24"]'))`,
  );
  const initialContext = await evaluate(
    client,
    `(() => {
      const root = document.querySelector("diffs-container")?.shadowRoot;
      return {
        expanders: root?.querySelectorAll("[data-expand-button]").length ?? 0,
        trailing: root?.querySelector("[data-separator-last] [data-expand-button]") !== null,
      };
    })()`,
  );
  assert.ok(
    initialContext.expanders > 0,
    "collapsed context is not expandable before the diff is edited",
  );
  assert.equal(
    initialContext.trailing,
    true,
    "trailing EOF context has no expander",
  );
  await clickShadowSelector(
    client,
    "[data-separator-last] [data-expand-button]",
    "the trailing context expander",
  );
  await waitFor(
    client,
    "the expanded trailing context",
    `Boolean(document.querySelector("diffs-container")?.shadowRoot?.querySelector('[data-additions] [data-content] > [data-line="30"]'))`,
  );
  assert.ok(
    await evaluate(
      client,
      `Boolean(
        document
          .querySelector("diffs-container")
          ?.shadowRoot?.querySelector(
            '[data-separator-last] [data-expand-button]:not([data-collapse-button])',
          ),
      )`,
    ),
    "partial context expansion lost its remaining expander",
  );
  const collapseControl = await evaluate(
    client,
    `(() => {
      const element = document.querySelector("diffs-container")?.shadowRoot?.querySelector("[data-collapse-button]");
      return element === null ? null : {
        tagName: element.tagName,
        label: element.getAttribute("aria-label"),
      };
    })()`,
  );
  assert.deepEqual(
    collapseControl,
    { tagName: "BUTTON", label: "Collapse expanded lines" },
    "expanded context has no collapse control",
  );
  await clickShadowSelector(
    client,
    "[data-collapse-button]",
    "the context collapse control",
  );
  await waitFor(
    client,
    "the collapsed trailing context",
    `!document.querySelector("diffs-container")?.shadowRoot?.querySelector('[data-additions] [data-content] > [data-line="30"]')`,
  );
  await clickShadowSelector(
    client,
    "[data-separator-last] [data-expand-button]",
    "the restored trailing context expander",
  );
  await waitFor(
    client,
    "the re-expanded trailing context",
    `Boolean(document.querySelector("diffs-container")?.shadowRoot?.querySelector('[data-additions] [data-content] > [data-line="30"]'))`,
  );
  const clickPoint = await evaluate(
    client,
    `(() => {
      const host = document.querySelector("diffs-container");
      const line = host?.shadowRoot?.querySelector('[data-additions] [data-content] > [data-line="30"]');
      if (!(host instanceof HTMLElement) || !(line instanceof HTMLElement)) return null;
      window.__traycerDiffHost = host;
      line.scrollIntoView({ block: "center" });
      return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
        const rect = line.getBoundingClientRect();
        resolve({ x: rect.left + Math.min(120, rect.width / 2), y: rect.top + rect.height / 2 });
      })));
    })()`,
  );
  if (
    clickPoint === null ||
    typeof clickPoint !== "object" ||
    typeof clickPoint.x !== "number" ||
    typeof clickPoint.y !== "number"
  ) {
    throw new Error("Could not resolve the editable line click point");
  }
  await click(client, clickPoint.x, clickPoint.y);
  await waitFor(
    client,
    "the attached contenteditable editor",
    `(() => {
      const host = document.querySelector("diffs-container");
      return host === window.__traycerDiffHost &&
        host?.shadowRoot?.activeElement?.getAttribute("contenteditable") === "true" &&
        host.shadowRoot.querySelector("[data-caret]") !== null;
    })()`,
  );
  // Worker-backed first attach still has an in-flight highlight generation.
  // Typing before it settles accepts the key without painting the caret.
  await evaluate(client, `new Promise((resolve) => setTimeout(resolve, 500))`);

  const dragPoints = await evaluate(
    client,
    `(() => {
      const line = document.querySelector("diffs-container")?.shadowRoot?.querySelector('[data-additions] [data-content] > [data-line="30"]');
      if (!(line instanceof HTMLElement)) return null;
      const rect = line.getBoundingClientRect();
      return {
        start: { x: rect.left + 24, y: rect.top + rect.height / 2 },
        end: { x: rect.left + 128, y: rect.top + rect.height / 2 },
      };
    })()`,
  );
  if (dragPoints === null) {
    throw new Error("Could not resolve the editable text drag points");
  }
  const dragSelection = await drag(client, dragPoints.start, dragPoints.end);
  await evaluate(client, `new Promise((resolve) => setTimeout(resolve, 1000))`);
  const selectionRangeCount = await getSelectionRangeCount(client);
  assert.ok(
    dragSelection.during > 0,
    `mouse drag never created a selection: ${JSON.stringify(dragSelection)}`,
  );
  assert.ok(
    selectionRangeCount > 0,
    `mouse-drag selection disappeared after the pointer gesture settled: ${JSON.stringify({ ...dragSelection, settled: selectionRangeCount })}`,
  );
  await click(client, clickPoint.x, clickPoint.y);
  await waitFor(
    client,
    "the selection to collapse for the typing checks",
    `document.querySelector("diffs-container")?.shadowRoot?.querySelector("[data-selection-range]") === null`,
  );
  await click(client, clickPoint.x, clickPoint.y, 2);
  await evaluate(client, `new Promise((resolve) => setTimeout(resolve, 500))`);
  assert.ok(
    (await getSelectionRangeCount(client)) > 0,
    "double-click selection disappeared after the pointer gesture settled",
  );
  await click(client, clickPoint.x, clickPoint.y);
  await waitFor(
    client,
    "the double-click selection to collapse for the typing checks",
    `document.querySelector("diffs-container")?.shadowRoot?.querySelector("[data-selection-range]") === null`,
  );
  await click(client, clickPoint.x, clickPoint.y, 3);
  await evaluate(client, `new Promise((resolve) => setTimeout(resolve, 500))`);
  assert.ok(
    (await getSelectionRangeCount(client)) > 0,
    "whole-line selection disappeared after the pointer gesture settled",
  );
  await click(client, clickPoint.x, clickPoint.y);
  await waitFor(
    client,
    "the whole-line selection to collapse for the typing checks",
    `document.querySelector("diffs-container")?.shadowRoot?.querySelector("[data-selection-range]") === null`,
  );

  const attached = await snapshot(client);
  await typeKey(client, "x");
  await waitFor(
    client,
    "the first physical keystroke",
    `document.querySelector("#test-state")?.getAttribute("data-change-count") === "1"`,
  );
  await waitFor(
    client,
    "the first keystroke to appear in the editor",
    `(() => {
      const host = document.querySelector("diffs-container");
      const root = host?.shadowRoot;
      const line = root?.querySelector('[data-additions] [data-content] > [data-line="30"]');
      const editable = root?.querySelector('[contenteditable="true"]');
      return (line?.textContent?.includes("x") === true) ||
        (editable?.textContent?.includes("x") === true);
    })()`,
  );
  const afterFirstKey = await snapshot(client);

  await waitFor(
    client,
    "autosave to write the draft",
    `document.querySelector("#test-state")?.getAttribute("data-write-count") === "1"`,
  );
  await waitFor(
    client,
    "the post-save contents refetch to settle",
    `Number(document.querySelector("#test-state")?.getAttribute("data-contents-settled-count")) >= 2`,
  );
  await waitFor(
    client,
    "the post-commit WorkerPool quiet signal",
    `document.querySelector("#test-state")?.getAttribute("data-worker-quiet") === "true"`,
  );
  const afterAckWindow = await snapshot(client);

  await evaluate(
    client,
    `(() => {
      const tile = document.querySelector("#tile");
      if (tile instanceof HTMLElement) tile.style.width = "360px";
    })()`,
  );
  await evaluate(client, `new Promise((resolve) => setTimeout(resolve, 300))`);
  const afterResize = await snapshot(client);

  await typeKey(client, "y");
  await waitFor(
    client,
    "the post-resize physical keystroke",
    `document.querySelector("#test-state")?.getAttribute("data-change-count") === "2"`,
  );
  await evaluate(
    client,
    `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
  );
  const afterSecondKey = await snapshot(client);

  const violations = [];
  if (Math.abs(attached.caretOffset) > 1) {
    violations.push(
      `caret is offset from its line by ${attached.caretOffset}px`,
    );
  }
  if (!afterFirstKey.focused || !afterFirstKey.sameHost) {
    violations.push(
      "the first keystroke did not retain the focused editor host",
    );
  }
  if (afterFirstKey.caretLeft <= attached.caretLeft) {
    violations.push("the first keystroke did not advance the caret");
  }
  if (afterFirstKey.attachCount !== 1) {
    violations.push(
      `editor attached ${afterFirstKey.attachCount} time(s) after the first keystroke`,
    );
  }
  if (afterAckWindow.attachCount !== 1) {
    violations.push(
      `editor attached ${afterAckWindow.attachCount} time(s) after the post-save window`,
    );
  }
  if (afterAckWindow.caretLeft < afterFirstKey.caretLeft) {
    violations.push(
      "the caret returned toward the original click column after the post-save window",
    );
  }
  if (!afterAckWindow.focused || !afterAckWindow.sameHost) {
    violations.push(
      "the post-save window did not retain the focused editor host",
    );
  }
  if (afterResize.attachCount !== 1) {
    violations.push(
      `editor attached ${afterResize.attachCount} time(s) after width resize`,
    );
  }
  if (!afterResize.caretVisible) {
    violations.push(
      "the caret is outside the tile viewport after width resize",
    );
  }
  if (Math.abs(afterResize.caretOffset) > 1) {
    violations.push(
      `caret is offset from its line by ${afterResize.caretOffset}px after width resize`,
    );
  }
  if (Math.abs(afterSecondKey.scrollTop - afterResize.scrollTop) > 1) {
    violations.push(
      `the next keystroke moved scrollTop by ${afterSecondKey.scrollTop - afterResize.scrollTop}px`,
    );
  }
  if (!afterSecondKey.focused || !afterSecondKey.sameHost) {
    violations.push(
      "the post-resize keystroke did not retain the focused editor host",
    );
  }
  if (afterSecondKey.attachCount !== 1) {
    violations.push(
      `editor attached ${afterSecondKey.attachCount} time(s) after the post-resize keystroke`,
    );
  }
  if (afterSecondKey.caretLeft === afterResize.caretLeft) {
    violations.push("the post-resize keystroke did not move the caret");
  }
  if (afterSecondKey.blurCount !== 0) {
    violations.push(
      `the editor emitted ${afterSecondKey.blurCount} blur event(s)`,
    );
  }
  if (afterSecondKey.activationError !== "") {
    violations.push(`activation failed: ${afterSecondKey.activationError}`);
  }
  assert.deepEqual(
    violations,
    [],
    `Diff edit browser regression failed:\n${JSON.stringify(
      { attached, afterFirstKey, afterAckWindow, afterResize, afterSecondKey },
      null,
      2,
    )}`,
  );
  console.log("diff edit browser regression passed");
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

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = createTcpServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a Chrome debugging port"));
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
      // The server has not opened its port yet.
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
    const connectTimer = setTimeout(() => {
      socket.close();
      reject(new Error("Timed out connecting to the CDP socket"));
    }, 15_000);
    socket.addEventListener("error", () =>
      reject(new Error("CDP socket failed")),
    );
    socket.addEventListener("close", () => {
      clearTimeout(connectTimer);
      const failure = new Error("CDP socket closed before the request settled");
      for (const request of pending.values()) request.reject(failure);
      pending.clear();
      reject(failure);
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
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await evaluate(client, expression)) return;
    await delay(50);
  }
  const pageState = await evaluate(
    client,
    `({
      text: document.body.innerText,
      html: document.body.innerHTML.slice(0, 2000),
      viteError: document.querySelector("vite-error-overlay")?.shadowRoot?.textContent ?? "",
    })`,
  );
  throw new Error(
    `Timed out waiting for ${label}:\n${JSON.stringify(pageState, null, 2)}`,
  );
}

async function click(client, x, y, clickCount = 1) {
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
  });
  for (let count = 1; count <= clickCount; count += 1) {
    await client.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      buttons: 1,
      clickCount: count,
    });
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      buttons: 0,
      clickCount: count,
    });
  }
}

async function drag(client, start, end) {
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: start.x,
    y: start.y,
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: start.x,
    y: start.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: end.x,
    y: end.y,
    button: "left",
    buttons: 1,
  });
  const during = await getSelectionRangeCount(client);
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: end.x,
    y: end.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  const released = await getSelectionRangeCount(client);
  return { during, released };
}

async function getSelectionRangeCount(client) {
  return await evaluate(
    client,
    `document.querySelector("diffs-container")?.shadowRoot?.querySelectorAll("[data-selection-range]").length ?? 0`,
  );
}

async function clickShadowSelector(client, selector, label) {
  const point = await evaluate(
    client,
    `(() => {
      const element = document.querySelector("diffs-container")?.shadowRoot?.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLElement)) return null;
      element.scrollIntoView({ block: "center" });
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
    throw new Error(`Could not resolve ${label}`);
  }
  await click(client, point.x, point.y);
}

async function typeKey(client, key) {
  const upper = key.toUpperCase();
  const keyCode = upper.charCodeAt(0);
  await client.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key,
    code: `Key${upper}`,
    text: key,
    unmodifiedText: key,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
  });
  await client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key,
    code: `Key${upper}`,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
  });
}

async function snapshot(client) {
  const result = await evaluate(
    client,
    `(() => {
      const host = document.querySelector("diffs-container");
      const root = host?.shadowRoot;
      const line = root?.querySelector('[data-additions] [data-content] > [data-line="30"]');
      const caret = root?.querySelector("[data-caret]");
      const viewport = document.querySelector("[data-diffs-host] > div");
      const state = document.querySelector("#test-state");
      if (!(host instanceof HTMLElement) || !(line instanceof HTMLElement) ||
          !(caret instanceof HTMLElement) || !(viewport instanceof HTMLElement) ||
          !(state instanceof HTMLElement)) return null;
      const lineRect = line.getBoundingClientRect();
      const caretRect = caret.getBoundingClientRect();
      const viewportRect = viewport.getBoundingClientRect();
      return {
        lineText: line.textContent ?? "",
        editableText: root.querySelector('[contenteditable="true"]')?.textContent ?? "",
        lineTop: lineRect.top,
        caretTop: caretRect.top,
        caretOffset: caretRect.top - lineRect.top,
        caretLeft: caretRect.left,
        caretVisible: caretRect.top >= viewportRect.top - 1 && caretRect.bottom <= viewportRect.bottom + 1,
        scrollTop: viewport.scrollTop,
        focused: document.activeElement === host && root.activeElement?.getAttribute("contenteditable") === "true",
        sameHost: host === window.__traycerDiffHost,
        changeCount: Number(state.getAttribute("data-change-count")),
        blurCount: Number(state.getAttribute("data-blur-count")),
        attachCount: Number(state.getAttribute("data-attach-count")),
        contentsSettledCount: Number(
          state.getAttribute("data-contents-settled-count"),
        ),
        workerQuiet: state.getAttribute("data-worker-quiet") === "true",
        writeCount: Number(state.getAttribute("data-write-count")),
        comparisonIdentity: state.getAttribute("data-comparison-identity") ?? "",
        activationError: state.getAttribute("data-activation-error") ?? "",
      };
    })()`,
  );
  if (result === null) {
    throw new Error(
      "Could not capture diff editor snapshot: diffs-container, target line, caret, viewport, or #test-state is missing",
    );
  }
  return result;
}
