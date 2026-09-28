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
const fixturePath = "/src/__tests__/browser/panel-motion-position.html";
const chromePath = await findChrome("the panel motion positioning regression");
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
    "traycer-panel-motion-",
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
  await client.send("Runtime.enable", undefined);
  await client.send("Page.enable", undefined);
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: 1000,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await waitFor(
    client,
    "the real and synthetic floating surfaces",
    `window.__panelMotionProbe?.ready === true`,
  );

  const violations = [];
  const initialProbe = await evaluate(
    client,
    `({ initialTransformSlots: window.__panelMotionProbe.initialTransformSlots,
        initialSidecar: window.__panelMotionProbe.initialSidecar,
        initialQuotePopover: window.__panelMotionProbe.initialQuotePopover })`,
  );
  const initial = await evaluate(
    client,
    "window.__panelMotionProbe.snapshot()",
  );
  verifyPositionSet(
    violations,
    "first Floating UI placement",
    initialProbe.initialTransformSlots,
    120.5,
    204.25,
  );
  verifyPosition(
    violations,
    "first sidecar placement",
    initialProbe.initialSidecar,
    120.5,
    204.25,
  );
  if (initialProbe.initialQuotePopover === null) {
    violations.push(
      "QuoteSelectionPopover did not expose its first transform placement",
    );
  } else {
    verifyQuotePosition(
      violations,
      "first QuoteSelectionPopover placement",
      initialProbe.initialQuotePopover,
    );
  }
  verifyPopoverWrapper(
    violations,
    "first Radix Popover placement",
    initial.radixPopover,
  );
  verifyPositionSet(
    violations,
    "first placement transition duration",
    initialProbe.initialTransformSlots,
    120.5,
    204.25,
    0,
  );
  verifyPosition(
    violations,
    "first sidecar transition duration",
    initialProbe.initialSidecar,
    120.5,
    204.25,
    0,
  );

  const defaultMotion = await evaluate(
    client,
    "window.__panelMotionProbe.snapshot()",
  );
  verifyMotionDurations(violations, "default", defaultMotion, 100);

  await evaluate(
    client,
    `document.documentElement.style.setProperty("--panel-animation-duration", "800ms")`,
  );
  const longMotion = await evaluate(
    client,
    "window.__panelMotionProbe.snapshot()",
  );
  verifyMotionDurations(violations, "long", longMotion, 800);

  await evaluate(
    client,
    `document.documentElement.setAttribute("data-reduce-panel-motion", "")`,
  );
  const appReducedMotion = await evaluate(
    client,
    "window.__panelMotionProbe.snapshot()",
  );
  verifyMotionDurations(violations, "app reduced motion", appReducedMotion, 0);

  await evaluate(
    client,
    `document.documentElement.removeAttribute("data-reduce-panel-motion")`,
  );
  await client.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  const osReducedMotion = await evaluate(
    client,
    "window.__panelMotionProbe.snapshot()",
  );
  verifyMotionDurations(violations, "OS reduced motion", osReducedMotion, 0);

  await client.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
  });
  await evaluate(
    client,
    `(async () => {
      await window.__panelMotionProbe.moveTo(440.25, 360.5);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    })()`,
  );
  const reanchored = await evaluate(
    client,
    "window.__panelMotionProbe.snapshot()",
  );
  verifyPositionSet(
    violations,
    "immediate Floating UI re-anchor",
    reanchored.transformSlots,
    440.25,
    384.5,
  );
  verifyPosition(
    violations,
    "immediate sidecar re-anchor",
    reanchored.sidecar,
    440.25,
    384.5,
  );
  verifyPositionSet(
    violations,
    "re-anchor transition duration",
    reanchored.transformSlots,
    440.25,
    384.5,
    0,
  );
  verifyPosition(
    violations,
    "sidecar re-anchor transition duration",
    reanchored.sidecar,
    440.25,
    384.5,
    0,
  );
  verifyPopoverWrapper(
    violations,
    "re-anchored Radix Popover",
    reanchored.radixPopover,
  );
  verifyQuotePosition(
    violations,
    "re-anchored QuoteSelectionPopover",
    reanchored.quotePopover,
  );

  await evaluate(
    client,
    `document.documentElement.style.removeProperty("--panel-animation-duration")`,
  );
  const restoredDefault = await evaluate(
    client,
    "window.__panelMotionProbe.snapshot()",
  );
  verifyMotionDurations(violations, "restored default", restoredDefault, 100);

  assert.deepEqual(
    violations,
    [],
    `Panel motion positioning regression failed:\n${JSON.stringify(
      {
        violations,
        initialProbe,
        initial,
        defaultMotion,
        longMotion,
        appReducedMotion,
        osReducedMotion,
        reanchored,
        restoredDefault,
      },
      null,
      2,
    )}`,
  );
  console.log("panel motion positioning regression passed");
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

function verifyPosition(
  violations,
  label,
  surface,
  x,
  y,
  expectedTransitionMs,
) {
  if (surface === undefined) {
    violations.push(`${label}: surface snapshot is missing`);
    return;
  }
  near(violations, `${label} x`, surface.rect.x, x);
  near(violations, `${label} y`, surface.rect.y, y);
  if (expectedTransitionMs !== undefined) {
    duration(
      violations,
      `${label} transition`,
      surface.transitionDuration,
      expectedTransitionMs,
    );
  }
}

function verifyPositionSet(
  violations,
  label,
  surfaces,
  x,
  y,
  expectedTransitionMs,
) {
  for (const [slot, surface] of Object.entries(surfaces ?? {})) {
    verifyPosition(
      violations,
      `${label} ${slot}`,
      surface,
      x,
      y,
      expectedTransitionMs,
    );
    if (surface.transitionProperty !== "all") {
      violations.push(
        `${label} ${slot}: expected default transition-property all, got ${surface.transitionProperty}`,
      );
    }
  }
}

function verifyQuotePosition(violations, label, quote) {
  if (quote === null || quote === undefined) {
    violations.push(`${label}: snapshot is missing`);
    return;
  }
  near(
    violations,
    `${label} x`,
    quote.surface.rect.x,
    Math.round(quote.anchor.x),
  );
  near(
    violations,
    `${label} y`,
    quote.surface.rect.y,
    Math.round(quote.anchor.y - quote.surface.rect.height - 6),
  );
  duration(
    violations,
    `${label} transition`,
    quote.surface.transitionDuration,
    0,
  );
}

function verifyPopoverWrapper(violations, label, popover) {
  const wrapper = popover?.wrapper;
  const anchor = popover?.anchor;
  if (wrapper === null || wrapper === undefined || anchor === undefined) {
    violations.push(`${label}: Radix Popper wrapper snapshot is missing`);
    return;
  }
  near(violations, `${label} x`, wrapper.rect.x, anchor.x);
  near(violations, `${label} y`, wrapper.rect.y, anchor.bottom + 4);
  duration(
    violations,
    `${label} wrapper transition`,
    wrapper.transitionDuration,
    0,
  );
  if (popover.content.animationName === "none") {
    violations.push(
      `${label}: expected the Radix open keyframe animation to remain active`,
    );
  }
}

function verifyMotionDurations(violations, label, state, expectedMs) {
  const animated = [
    ...Object.entries(state.transformSlots).map(([slot, surface]) => [
      `${slot} animation`,
      surface,
    ]),
    ["profile sidecar animation", state.sidecar],
    ["editor bubble animation", state.editorBubble],
    ["Radix keyframe animation", state.radixPopover.content],
    ["quote keyframe duration", state.quotePopover.surface],
  ];
  for (const [name, surface] of animated) {
    duration(
      violations,
      `${label} ${name}`,
      surface.animationDuration,
      expectedMs,
    );
  }
  const positioned = [
    ...Object.entries(state.transformSlots).map(([slot, surface]) => [
      `${slot} position`,
      surface,
    ]),
    ["profile sidecar position", state.sidecar],
    ["editor bubble position", state.editorBubble],
    ["quote popover position", state.quotePopover.surface],
    ["Radix Popper wrapper position", state.radixPopover.wrapper],
  ];
  for (const [name, surface] of positioned) {
    if (surface !== null && surface !== undefined) {
      duration(
        violations,
        `${label} ${name} transition`,
        surface.transitionDuration,
        0,
      );
    }
  }
  for (const [name, surface] of [
    ["sheet transition", state.sheet],
    ["sidebar transition", state.sidebar],
    ["drawer transition", state.drawer],
  ]) {
    duration(
      violations,
      `${label} ${name}`,
      surface.transitionDuration,
      expectedMs,
    );
  }
}

function duration(violations, label, value, expectedMs) {
  const actualMs = durationMs(value);
  if (actualMs === null || Math.abs(actualMs - expectedMs) > 1) {
    violations.push(`${label}: expected ${expectedMs}ms, got ${value}`);
  }
}

function durationMs(value) {
  const magnitude = Number.parseFloat(value);
  if (!Number.isFinite(magnitude)) return null;
  if (value.endsWith("ms")) return magnitude;
  if (value.endsWith("s")) return magnitude * 1000;
  return null;
}

function near(violations, label, actual, expected) {
  if (Math.abs(actual - expected) > 1) {
    violations.push(`${label}: expected ${expected}px, got ${actual}px`);
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
        reject(new Error("Could not allocate a free Vite port"));
        return;
      }
      server.close();
      resolve(address.port);
    });
  });
}

async function waitForHttp(url, child, readError, label) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`${label} exited before ready:\n${readError()}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The local server has not opened its port yet.
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}:\n${readError()}`);
}

async function evaluate(targetClient, expression) {
  const response = await targetClient.send("Runtime.evaluate", {
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

async function waitFor(targetClient, label, expression) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await evaluate(targetClient, expression)) return;
    await delay(50);
  }
  const state = await evaluate(
    targetClient,
    `({ body: document.body.innerHTML.slice(0, 4000), viteError: document.querySelector("vite-error-overlay")?.shadowRoot?.textContent ?? "" })`,
  );
  throw new Error(
    `Timed out waiting for ${label}:\n${JSON.stringify(state, null, 2)}`,
  );
}
