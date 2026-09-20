// Browser regression: Settings > Appearance's light/dark theme rows give the
// picker a usable width at every viewport, and never split a theme's name in
// the middle of a word.
//
// The row is two columns until it is not: below `md` the label's width floor
// pushes the control onto a line of its own, and what the control does with
// that line decides whether the name has room. That is flex line-breaking, a
// container query (`cqw`) and where a line box falls - none of which jsdom
// has. So this renders the real gallery
// (`src/__tests__/browser/theme-picker-narrow-row.tsx`) and measures:
//   - every word of the name, as laid-out lines: a word that sits on more than
//     one was split down the middle, which is the phone defect this exists to
//     catch;
//   - the control's box against the row's content box, once the row has
//     wrapped - a control that stays at its pointer-width share leaves the
//     name a sliver of the line it was given;
//   - the pointer-width geometry, which must not move: side by side with the
//     label, at the picker's `min(40cqw,24rem)` share.
// Each is read in every state the rows have - a built-in selection, a personal
// theme named in long words, one named as a single unbroken word, an open
// draft (both pencils disabled) and a library error.
//
// Usage: node scripts/theme-picker-narrow-row-browser.mjs [--out DIR] [--report]
//   --out DIR   also write a screenshot of the Themes card per case and
//               viewport into DIR.
//   --report    print every measurement, not only the failures.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
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

const PHONE = { label: "phone", width: 393, height: 852, mobile: true };
const DESKTOP = { label: "desktop", width: 1280, height: 800, mobile: false };
const VIEWPORTS = [PHONE, DESKTOP];
// The picker's pointer-width share of the `@container` it sits in, from
// `w-[min(40cqw,24rem)]`. Read back so a change to it is a change here too.
const DESKTOP_SHARE = 0.4;
const DESKTOP_SHARE_CAP = 384;
// Sub-pixel layout, compared at a pixel.
const EPSILON = 1;
/**
 * Injected into a page evaluation: each word of an element's own text, with
 * the number of LINES it sits on - the distinct tops of its client rects.
 * More than one is a word split across lines, which is the defect. Counting
 * the rects themselves would not do: a clipped or ellipsed run is several
 * rects on one line, and that is the intended rendering, not a break.
 */
const WORD_RECTS = `
  const wordRects = (element) => {
    const node = [...element.childNodes].find(
      (child) => child.nodeType === Node.TEXT_NODE && child.textContent.trim() !== "",
    );
    if (node === undefined) return [];
    const range = document.createRange();
    const out = [];
    for (const match of node.textContent.matchAll(/\\S+/g)) {
      range.setStart(node, match.index);
      range.setEnd(node, match.index + match[0].length);
      const tops = new Set(
        [...range.getClientRects()].map((rect) => Math.round(rect.top)),
      );
      out.push({ word: match[0], lines: tops.size });
    }
    return out;
  };
`;

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outDir =
  outIndex === -1
    ? null
    : path.resolve(args[outIndex + 1] ?? "theme-row-shots");
const report = args.includes("--report");

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const fixtureUrlPath = "/src/__tests__/browser/theme-picker-narrow-row.html";
const chromePath = await findChrome("the theme picker narrow-row regression");
const vitePort = await freePort();
let chrome;
let chromeProfilePath;
let client;
let viteProcess;

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
  await waitForHttp(baseUrl, viteProcess, () => viteError, "Vite");

  const launched = await launchChromeWithDevTools(
    chromePath,
    "traycer-theme-picker-row-",
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
    {
      method: "PUT",
    },
  );
  if (!targetResponse.ok) {
    throw new Error(`Chrome could not open a page: ${targetResponse.status}`);
  }
  const target = await targetResponse.json();
  client = await connectCdp(target.webSocketDebuggerUrl);
  await client.send("Runtime.enable");
  await client.send("Page.enable");

  await navigate(client, baseUrl);
  await waitFor(
    client,
    "the fixture to publish its probes",
    "Array.isArray(window.__probeNames) && window.__probeReady === true",
  );
  // Discovered from the fixture, so a name added there is covered here.
  const names = await evaluate(client, "window.__probeNames");
  const builtin = await evaluate(client, "window.__probeBuiltin");
  const cases = [
    ...names.map((name) => ({ name, draft: false, error: false })),
    { name: builtin, draft: true, error: false },
    { name: builtin, draft: false, error: true },
  ];

  const failures = [];
  const measured = [];
  for (const viewport of VIEWPORTS) {
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: viewport.mobile,
    });
    for (const probeCase of cases) {
      const caseKey = describeCase(probeCase);
      await evaluate(
        client,
        `window.__probeApply(${JSON.stringify(probeCase)})`,
      );
      await settle(client);
      for (const row of await measureRows(client)) {
        const reading = { viewport: viewport.label, case: caseKey, ...row };
        measured.push(reading);
        failures.push(...check(reading, viewport, probeCase, builtin));
      }
      if (outDir !== null) {
        await captureCard(
          client,
          path.join(outDir, `${viewport.label}.${caseKey}.png`),
        );
      }
    }

    // The popover's own rows are a separate list with its own width; read
    // under the longest name, at each viewport, so a defect there is seen.
    await evaluate(
      client,
      `window.__probeApply(${JSON.stringify({ name: names[names.length - 1], draft: false, error: false })})`,
    );
    await settle(client);
    for (const row of await measurePopoverRows(client)) {
      const reading = {
        viewport: viewport.label,
        case: "popover list",
        ...row,
      };
      measured.push(reading);
      for (const word of reading.words) {
        if (word.lines > 1) {
          failures.push(
            `${reading.viewport} ${reading.case} ${reading.which}: "${word.word}" broken across ${word.lines} lines`,
          );
        }
      }
    }
  }

  if (report) {
    for (const reading of measured) {
      console.log(
        `${reading.viewport.padEnd(8)} ${reading.case.padEnd(40)} ${reading.which.padEnd(12)} ` +
          `${reading.control === undefined ? "" : `control ${Math.round(reading.control)}/${Math.round(reading.rowContent)} wrapped=${reading.wrapped} `}` +
          `name ${Math.round(reading.nameBox)} (needs ${Math.round(reading.nameText)}) ` +
          `worst-word-lines ${Math.max(...reading.words.map((word) => word.lines), 0)}`,
      );
    }
  }

  console.log(
    `${VIEWPORTS.length} viewports x ${cases.length} cases, ${measured.length} row readings` +
      `${outDir === null ? "" : `, screenshots in ${outDir}`}`,
  );
  for (const failure of failures) console.log(`FAIL ${failure}`);
  assert.equal(failures.length, 0, "theme rows measured wrong - see above");
  console.log("theme picker narrow-row regression passed");
} catch (error) {
  console.error("MEASUREMENT FAILED:", error);
  process.exitCode = 1;
} finally {
  client?.close();
  // Vite first, and a Chrome that survives its kill must not strand the rest
  // of the cleanup: the dev server would keep its port and the profile its
  // directory.
  viteProcess?.kill("SIGTERM");
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

function describeCase(probeCase) {
  const suffix = probeCase.draft ? " +draft" : probeCase.error ? " +error" : "";
  return `${probeCase.name}${suffix}`;
}

/** Every failure this one reading is. */
function check(reading, viewport, probeCase, builtin) {
  const failures = [];
  const where = `${reading.viewport} ${reading.case} ${reading.which}`;
  for (const word of reading.words) {
    if (word.lines > 1) {
      failures.push(
        `${where}: "${word.word}" broken across ${word.lines} lines`,
      );
    }
  }
  if (viewport === PHONE) {
    // The row has stacked, and the control owns the line it was given.
    if (!reading.wrapped) {
      failures.push(`${where}: control did not wrap below the label`);
    }
    if (reading.control < reading.rowContent - EPSILON) {
      failures.push(
        `${where}: control is ${Math.round(reading.control)}px of the ${Math.round(reading.rowContent)}px line it wrapped onto`,
      );
    }
    // A built-in name is short and bounded: on a phone it reads in full.
    if (
      probeCase.name === builtin &&
      reading.nameText > reading.nameBox + EPSILON
    ) {
      failures.push(
        `${where}: "${builtin}" needs ${Math.round(reading.nameText)}px and has ${Math.round(reading.nameBox)}px`,
      );
    }
  } else {
    // Pointer width is untouched: beside the label, at the picker's share.
    if (reading.wrapped) {
      failures.push(`${where}: control wrapped below the label`);
    }
    const share = Math.min(
      reading.container * DESKTOP_SHARE,
      DESKTOP_SHARE_CAP,
    );
    if (Math.abs(reading.control - share) > EPSILON) {
      failures.push(
        `${where}: control is ${Math.round(reading.control)}px, not the ${Math.round(share)}px share of its container`,
      );
    }
  }
  return failures;
}

/**
 * One reading per theme row: the control's box, the row's content box, the
 * `@container` the share is measured against, whether the control wrapped
 * below the label, and every word of the name as laid-out line boxes.
 */
function measureRows(client) {
  return evaluate(
    client,
    `(() => {
       ${WORD_RECTS}
       const rows = [];
       for (const which of ["Light theme", "Dark theme"]) {
         const trigger = document.querySelector('button[aria-label="' + which + '"]');
         if (trigger === null) throw new Error("no picker for " + which);
         const cluster = trigger.parentElement;
         const wrapper = cluster.parentElement;
         const row = wrapper.parentElement;
         const label = row.firstElementChild;
         const name = trigger.querySelector('[id$="-value"]');
         const padding = getComputedStyle(row);
         // The panel body's own wrapper is the \`@container\` the picker's
         // \`cqw\` share is measured against.
         const container = document.querySelector("[data-settings-panel-body] > div");
         if (container === null) throw new Error("no @container above the row");
         rows.push({
           which,
           control: cluster.getBoundingClientRect().width,
           rowContent:
             row.getBoundingClientRect().width -
             parseFloat(padding.paddingLeft) -
             parseFloat(padding.paddingRight),
           container: container.getBoundingClientRect().width,
           wrapped:
             cluster.getBoundingClientRect().top >=
             label.getBoundingClientRect().bottom,
           nameBox: name.getBoundingClientRect().width,
           nameText: name.scrollWidth,
           words: wordRects(name),
         });
       }
       return rows;
     })()`,
  );
}

/** The same word reading for the rows inside the open picker popover. */
async function measurePopoverRows(client) {
  await evaluate(
    client,
    `document.querySelector('button[aria-label="Light theme"]').click()`,
  );
  await waitFor(
    client,
    "the theme popover",
    `document.querySelector('[data-slot="command-item"]') !== null`,
  );
  await settle(client);
  const rows = await evaluate(
    client,
    `(() => {
       ${WORD_RECTS}
       return [...document.querySelectorAll('[data-slot="command-item"]')].map((item) => {
         const name = item.querySelector(":scope > span:not([aria-hidden])");
         return {
           which: name.textContent.slice(0, 24),
           nameBox: name.getBoundingClientRect().width,
           nameText: name.scrollWidth,
           words: wordRects(name),
         };
       });
     })()`,
  );
  await evaluate(
    client,
    `document.querySelector('button[aria-label="Light theme"]').click()`,
  );
  await waitFor(
    client,
    "the theme popover to close",
    `document.querySelector('[data-slot="command-item"]') === null`,
  );
  assert.ok(rows.length > 0, "no rows measured in the theme popover");
  return rows;
}

/** The Themes card alone, so the shots show the rows rather than the page. */
async function captureCard(client, file) {
  const clip = await evaluate(
    client,
    `(() => {
       const card = document.querySelector('section[aria-label="Theme"]');
       const box = card.getBoundingClientRect();
       return { x: box.left, y: box.top, width: box.width, height: box.height };
     })()`,
  );
  const shot = await client.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
    clip: { ...clip, scale: 2 },
  });
  await writeFile(file, Buffer.from(shot.data, "base64"));
}

/**
 * Navigates and returns once the NEW document is the one being evaluated. The
 * old document carries a marker the new one cannot have, and a context
 * destroyed by the navigation is retried.
 */
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

function connectCdp(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    let nextId = 0;
    const connectTimer = setTimeout(
      () => reject(new Error("CDP connect timed out")),
      15_000,
    );
    const failAll = (reason) => {
      for (const [id, request] of pending) {
        pending.delete(id);
        request.reject(reason);
      }
    };
    socket.addEventListener("error", (event) => {
      const error = new Error(`CDP socket error: ${String(event)}`);
      reject(error);
      failAll(error);
    });
    socket.addEventListener("close", (event) => {
      failAll(new Error(`CDP socket closed (${event.code})`));
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
          if (socket.readyState !== WebSocket.OPEN) {
            return Promise.reject(
              new Error(`CDP socket not open for ${method}`),
            );
          }
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
