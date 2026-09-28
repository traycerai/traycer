// Browser regression: the message queue is never a pill (staging round 2,
// G1-G2). While it holds anything it sits attached directly above the
// composer - its rows, their actions and Pause - with no click, in every
// preset; the pill row, when there is one, stands above it; and when it empties
// it leaves no gap behind.
//
// Drives `src/__tests__/browser/composer-queue-dock.tsx` - the real tile's dock
// derivation and the real `ChatLowerDock` over the real composer shell - with
// real key input, in the Compact and Default presets, light and dark. Every
// one-line queue row, a badged agent reply included, is also held to the dock's
// one row metric (L-171, L-172). Todo is
// the fixture's other dock member, so the queue is always read beside a
// surface that folds into a pill in Compact.
//
// Staging round 4 adds two things. An agent's reply is a queued row like any
// other, attached with no click in every preset and never counted by the
// Active agents pill. And the pill row starts at the composer's left edge,
// every pill fully drawn, for every combination of pills and after a pill
// returns while another is still leaving.
//
// Usage: node scripts/composer-queue-dock-browser.mjs [--out DIR]
//   --out DIR   also write a screenshot of the lower surface per step into DIR.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  findChrome,
  launchChromeWithDevTools,
  terminateProcessTree,
} from "./chrome-launcher.mjs";
import { connectCdp } from "./cdp-client.mjs";

const PRESETS = ["compact", "default"];
const THEMES = ["light", "dark"];
// Sub-pixel layout, compared at a pixel.
const EPSILON = 1;
// Row heights are stated, not emergent (L-171), so they are compared tighter.
const ROW_EPSILON = 0.5;
// The pills' arrival (`PILL_ENTER_TRANSITION`, 140ms) and then some, so a
// reading never catches a pill mid-scale.
const PILL_ARRIVAL_MS = 250;
// Every non-empty combination of the pill-able members the fixture carries.
const MEMBER_COMBINATIONS = [1, 2, 3, 4, 5, 6, 7].map((bits) => ({
  todo: (bits & 1) !== 0,
  changes: (bits & 2) !== 0,
  agents: (bits & 4) !== 0,
}));

/**
 * The one-line row every dock panel is held to (L-171): the fixture's own
 * recipe string on a throwaway row with one line of text, measured by the same
 * engine. A queue row that measures anything else - a floated toolbar that
 * outgrew its budget, a provenance badge that wrapped (L-172) - moves the
 * composer's upper edge whenever the queue changes.
 */
const ROW_REFERENCE = `(() => {
  const row = document.createElement("div");
  row.className = window.__probeRowRecipe;
  row.style.width = "420px";
  row.textContent = "x";
  document.body.append(row);
  const height = row.getBoundingClientRect().height;
  row.remove();
  return height;
})()`;

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outDir =
  outIndex === -1 ? null : path.resolve(args[outIndex + 1] ?? "queue-shots");

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const fixtureUrlPath = "/src/__tests__/browser/composer-queue-dock.html";
const chromePath = await findChrome("the composer queue dock regression");
const vitePort = await freePort();
let chrome;
let chromeProfilePath;
let client;
let viteProcess;
let viteConfigDir;

/**
 * One reading of the lower surface: the pill row, the queue, the composer, the
 * queue pill if any, and where focus is.
 */
const READ = `(() => {
  const box = (element) => {
    if (element === null) return null;
    const rect = element.getBoundingClientRect();
    return {
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      height: rect.height,
    };
  };
  const pills = [...document.querySelectorAll("[data-chat-dock-chip]")];
  const agentsPill = document.querySelector('[data-testid="chat-dock-chip-activeAgents"]');
  const composer = document.querySelector("[data-probe-composer]");
  const frame = composer.closest("[data-composer-editor-frame]") ?? composer;
  return {
    strip: box(document.querySelector('[data-testid="chat-dock-compact-strip"]')),
    queuePill: document.querySelector('[data-testid="chat-dock-chip-queue"]') !== null,
    queue: box(document.querySelector('[data-testid="queued-message-rows"]')),
    rows: document.querySelectorAll('[data-testid="queued-message-row"]').length,
    pause: document.querySelector('[data-testid="pause-queue-button"]') !== null,
    composer: box(frame.closest("[data-composer-shell]") ?? frame),
    rowHeights: [...document.querySelectorAll('[data-testid="queued-message-row"]')].map(
      (row) => row.getBoundingClientRect().height,
    ),
    provenance: document.querySelector('[data-testid="queued-message-provenance-chip"]') !== null,
    focused: document.activeElement === composer,
    firstPillLeft:
      pills.length === 0
        ? null
        : Math.min(...pills.map((pill) => pill.getBoundingClientRect().left)),
    agentsPill: agentsPill === null ? null : agentsPill.textContent,
    pillCount: pills.length,
    // The lowest opacity any pill is drawn at, its own and its ancestors' up to
    // the pill row: a pill at 0 is a box the row still lays out.
    faintestPill: Math.min(
      1,
      ...pills.map((pill) => {
        let opacity = 1;
        for (
          let node = pill;
          node !== null && node.dataset.testid !== "chat-dock-compact-strip";
          node = node.parentElement
        ) {
          opacity *= Number(getComputedStyle(node).opacity);
        }
        return opacity;
      }),
    ),
  };
})()`;

try {
  if (outDir !== null) await mkdir(outDir, { recursive: true });
  const baseUrl = `http://127.0.0.1:${vitePort}${fixtureUrlPath}`;
  const requireFromHere = createRequire(import.meta.url);
  const viteManifestPath = requireFromHere.resolve("vite/package.json");
  const viteManifest = requireFromHere(viteManifestPath);
  const viteEntry = path.resolve(
    path.dirname(viteManifestPath),
    viteManifest.bin.vite,
  );
  // File watching off, through a wrapper around the shared config: the run
  // never needs to follow an edit, and in a tree several agents write at once
  // a watcher invalidates the fixture mid-load on a peer's save (the pattern
  // `layout-editor-browser.mjs` records in its `spawnVite`).
  viteConfigDir = await mkdtemp(path.join(tmpdir(), "composer-queue-vite-"));
  const viteConfigPath = path.join(viteConfigDir, "vite.no-watch.config.mjs");
  await writeFile(
    viteConfigPath,
    [
      `import base from ${JSON.stringify(path.join(projectRoot, "vitest.config.ts"))};`,
      "export default { ...base, server: { ...base.server, watch: null } };",
      "",
    ].join("\n"),
  );
  viteProcess = spawn(
    "node",
    [
      viteEntry,
      "--config",
      viteConfigPath,
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
  await waitForHttp(baseUrl, viteProcess, () => viteError, "Vite");

  const launched = await launchChromeWithDevTools(
    chromePath,
    "traycer-composer-queue-dock-",
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
    new URL(`/json/new?about:blank`, devtoolsUrl),
    { method: "PUT" },
  );
  if (!targetResponse.ok) {
    throw new Error(`Chrome could not open a page: ${targetResponse.status}`);
  }
  const target = await targetResponse.json();
  client = await connectCdp(target.webSocketDebuggerUrl);
  await client.send("Runtime.enable");
  await client.send("Page.enable");
  // A module that fails to load renders nothing and says why only here.
  await client.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__probeErrors = [];
      addEventListener("error", (event) => window.__probeErrors.push(String(event.message ?? event.target?.src ?? event.target?.href ?? event)), true);
      addEventListener("unhandledrejection", (event) => window.__probeErrors.push(String(event.reason)));`,
  });
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: 900,
    height: 700,
    deviceScaleFactor: 2,
    mobile: false,
  });

  const failures = [];
  for (const preset of PRESETS) {
    for (const theme of THEMES) {
      const where = `${preset}/${theme}`;
      // The layout store persists its preset; each case starts from nothing.
      // `about:blank` (the first case) has no storage and nothing to clear.
      await evaluate(client, "try { localStorage.clear() } catch {}");
      await navigate(client, baseUrl);
      await waitFor(client, "the fixture", "window.__probeReady === true");
      await evaluate(
        client,
        `window.__probePreset(${JSON.stringify(preset)}); window.__probeTheme(${JSON.stringify(theme)})`,
      );
      await settle(client);
      const empty = await evaluate(client, READ);
      const rowReference = await evaluate(client, ROW_REFERENCE);
      await shoot(client, `${where}.0-empty`);

      await evaluate(
        client,
        `document.querySelector("[data-probe-composer]").focus()`,
      );
      for (const [count, text] of [
        [1, "hi"],
        [2, "and then the tests"],
      ]) {
        await client.send("Input.insertText", { text });
        await pressEnter(client);
        await settle(client);
        const reading = await evaluate(client, READ);
        await shoot(client, `${where}.${count}-queued`);
        const step = `${where} after queueing ${count}`;
        if (reading.queuePill) failures.push(`${step}: the queue is a pill`);
        if (reading.queue === null) {
          failures.push(
            `${step}: the queue is not attached above the composer`,
          );
        } else {
          if (reading.rows !== count) {
            failures.push(`${step}: ${reading.rows} rows drawn, not ${count}`);
          }
          if (!reading.pause) failures.push(`${step}: no Pause`);
          for (const height of reading.rowHeights) {
            if (Math.abs(height - rowReference) > ROW_EPSILON) {
              failures.push(
                `${step}: a one-line row measures ${height}px, not the ${rowReference}px row metric`,
              );
            }
          }
          // Directly above the composer: the frame tucks into it with `-mb-px`.
          if (
            Math.abs(reading.queue.bottom - reading.composer.top) >
            EPSILON + 1
          ) {
            failures.push(
              `${step}: queue ends at ${reading.queue.bottom}, composer starts at ${reading.composer.top}`,
            );
          }
          if (
            reading.strip !== null &&
            reading.strip.bottom > reading.queue.top + EPSILON
          ) {
            failures.push(`${step}: the pill row is not above the queue`);
          }
        }
        if (preset === "compact" && reading.strip === null) {
          failures.push(`${step}: the Todo pill row is gone`);
        }
        if (!reading.focused) failures.push(`${step}: focus left the composer`);
      }

      for (const remaining of [1, 0]) {
        const step = `${where} after deleting down to ${remaining}`;
        const deleted = await evaluate(
          client,
          `(() => {
             const button = document.querySelector('[aria-label="Delete queued message"]');
             button?.click();
             return button !== null;
           })()`,
        );
        if (!deleted) {
          failures.push(
            `${step}: no row's Delete is reachable without a click`,
          );
          break;
        }
        await settle(client);
        const reading = await evaluate(client, READ);
        await shoot(
          client,
          `${where}.${3 - remaining}-deleted-to-${remaining}`,
        );
        if (remaining > 0 && reading.rows !== remaining) {
          failures.push(`${step}: ${reading.rows} rows drawn`);
        }
        if (remaining === 0) {
          if (reading.queue !== null)
            failures.push(`${step}: queue still drawn`);
          // No leftover gap: everything sits exactly where it did before the
          // first message was queued.
          if (Math.abs(reading.composer.top - empty.composer.top) > EPSILON) {
            failures.push(
              `${step}: composer at ${reading.composer.top}, was ${empty.composer.top} before queueing`,
            );
          }
          if (
            (reading.strip === null) !== (empty.strip === null) ||
            (reading.strip !== null &&
              Math.abs(reading.strip.bottom - empty.strip.bottom) > EPSILON)
          ) {
            failures.push(`${step}: the pill row moved`);
          }
        }
      }
      // An agent's reply carries the provenance badge (L-172), and it is a
      // queued message like any other (staging round 4): attached above the
      // composer with no click in every preset, never folded into the Active
      // agents pill - whether or not this chat has agents of its own running.
      // Agents running is Compact only: Default draws them as a full row,
      // which needs a live host runtime this fixture does not provide, and
      // has no pill for the reply to fold into.
      for (const agents of preset === "compact" ? [false, true] : [false]) {
        await evaluate(
          client,
          `window.__probeDock({ todo: true, changes: false, agents: ${agents} })`,
        );
        if (!agents) {
          await evaluate(client, `window.__probeQueueAgentReply("ok")`);
        }
        await settle(client);
        const reading = await evaluate(client, READ);
        await shoot(client, `${where}.4-agent-reply${agents ? "-agents" : ""}`);
        const step = `${where} with an agent's reply queued${agents ? " and agents running" : ""}`;
        if (reading.queue === null) {
          failures.push(
            `${step}: the reply is not attached above the composer`,
          );
        }
        if (!reading.provenance) failures.push(`${step}: no provenance badge`);
        if (reading.rowHeights.length !== 1) {
          failures.push(`${step}: ${reading.rowHeights.length} rows drawn`);
        } else if (
          Math.abs(reading.rowHeights[0] - rowReference) > ROW_EPSILON
        ) {
          failures.push(
            `${step}: the badged row measures ${reading.rowHeights[0]}px, not the ${rowReference}px row metric`,
          );
        }
        if (reading.agentsPill !== null && !agents) {
          failures.push(
            `${step}: an Active agents pill "${reading.agentsPill}" stands for the queue`,
          );
        }
        if (reading.agentsPill?.includes("·")) {
          failures.push(
            `${step}: the Active agents pill "${reading.agentsPill}" also counts the queue`,
          );
        }
      }

      // The pill row starts at the composer's left edge whatever combination
      // of pills it holds, a lone pill included, with the queue full or empty.
      // Compact only: Default draws every member as a full row.
      for (const queued of preset === "compact" ? [true, false] : []) {
        if (!queued) {
          await evaluate(client, "window.__probeQueueClear()");
        }
        for (const members of MEMBER_COMBINATIONS) {
          await evaluate(
            client,
            `window.__probeDock(${JSON.stringify(members)})`,
          );
          await settle(client);
          await delay(PILL_ARRIVAL_MS);
          const reading = await evaluate(client, READ);
          const name = Object.keys(members)
            .filter((key) => members[key])
            .join("+");
          const step = `${where} with ${name} ${queued ? "and a queued reply" : "and an empty queue"}`;
          await shoot(
            client,
            `${where}.5-pills-${name}${queued ? "-queued" : ""}`,
          );
          checkPillRow(reading, step);
        }
      }

      // A pill whose section comes back while another pill's exit is still
      // running (staging round 4, the lone pill off the left edge), from an
      // empty pill row so the sequence meets a fresh row every time: Files
      // changed leaves as Todo arrives, Todo leaves 80ms later - before that
      // 110ms exit has finished - and Files changed returns 90ms after that,
      // once its own exit is over and while Todo's is not. It must come back
      // as a pill you can see, not as an invisible box holding its width in
      // front of the rest.
      if (preset === "compact") {
        await evaluate(
          client,
          `(async () => {
             const steps = [
               [{ todo: false, changes: false, agents: false }, 400],
               [{ todo: false, changes: true, agents: true }, 400],
               [{ todo: true, changes: false, agents: true }, 80],
               [{ todo: false, changes: false, agents: true }, 90],
               [{ todo: false, changes: true, agents: true }, 0],
             ];
             for (const [members, ms] of steps) {
               window.__probeDock(members);
               await new Promise((resolve) => setTimeout(resolve, ms));
             }
           })()`,
        );
        await delay(PILL_ARRIVAL_MS * 3);
        const reading = await evaluate(client, READ);
        await shoot(client, `${where}.6-pill-returns-mid-exit`);
        const step = `${where} after Files changed returns mid-exit`;
        if (reading.pillCount !== 2) {
          failures.push(`${step}: ${reading.pillCount} pills, not 2`);
        }
        checkPillRow(reading, step);
      }
      console.log(`${where}: done (row metric ${rowReference}px)`);

      function checkPillRow(reading, step) {
        if (reading.firstPillLeft === null) {
          failures.push(`${step}: no pill row`);
          return;
        }
        if (
          Math.abs(reading.firstPillLeft - reading.composer.left) > ROW_EPSILON
        ) {
          failures.push(
            `${step}: the pill row starts at ${reading.firstPillLeft}px, the composer at ${reading.composer.left}px`,
          );
        }
        if (reading.faintestPill < 1) {
          failures.push(
            `${step}: a pill is drawn at opacity ${reading.faintestPill}, holding its width unseen`,
          );
        }
      }
    }
  }

  for (const failure of failures) console.log(`FAIL ${failure}`);
  assert.equal(failures.length, 0, "the queue measured wrong - see above");
  console.log("composer queue dock regression passed");
} catch (error) {
  console.error("MEASUREMENT FAILED:", error);
  process.exitCode = 1;
} finally {
  client?.close();
  viteProcess?.kill("SIGTERM");
  if (viteConfigDir !== undefined) {
    await rm(viteConfigDir, { recursive: true, force: true });
  }
  if (chrome !== undefined) {
    try {
      await terminateProcessTree(chrome);
    } catch (error) {
      console.error("Chrome termination failed:", error);
      process.exitCode = 1;
    }
  }
  if (chromeProfilePath !== undefined) {
    await rm(chromeProfilePath, {
      recursive: true,
      force: true,
      maxRetries: 3,
    });
  }
}

async function pressEnter(client) {
  for (const type of ["keyDown", "keyUp"]) {
    await client.send("Input.dispatchKeyEvent", {
      type,
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      text: type === "keyDown" ? "\r" : undefined,
    });
  }
}

/** The lower surface alone: the pill row down to the composer's bottom. */
async function shoot(client, name) {
  if (outDir === null) return;
  const clip = await evaluate(
    client,
    `(() => {
       const bottom = document.querySelector("[data-probe-composer]").closest(".shrink-0").getBoundingClientRect();
       const top = Math.max(0, bottom.top - 360);
       return { x: 0, y: top, width: window.innerWidth, height: bottom.bottom - top };
     })()`,
  );
  const shot = await client.send("Page.captureScreenshot", {
    format: "png",
    clip: { ...clip, scale: 1 },
  });
  await writeFile(
    path.join(outDir, `${name.replace("/", "-")}.png`),
    Buffer.from(shot.data, "base64"),
  );
}

async function navigate(client, url) {
  try {
    await evaluate(client, "window.__probeStaleDocument = true");
  } catch (error) {
    if (!isNavigationContextError(error)) throw error;
  }
  await client.send("Page.navigate", { url });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const ready = await evaluate(
        client,
        `window.__probeStaleDocument !== true && document.readyState === "complete"`,
      );
      if (ready) return;
    } catch (error) {
      if (!isNavigationContextError(error)) throw error;
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for the navigation to ${url}`);
}

function isNavigationContextError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /context was destroyed|Cannot find context|Inspected target navigated/i.test(
    message,
  );
}

function settle(client) {
  return evaluate(
    client,
    `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50))))`,
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
    `({ errors: window.__probeErrors, text: document.body.innerText, html: document.body.innerHTML.slice(0, 3000) })`,
  );
  throw new Error(
    `Timed out waiting for ${label}:\n${JSON.stringify(pageState, null, 2)}`,
  );
}
