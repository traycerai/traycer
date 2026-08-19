// The boot-family GALLERY: renders every face a launch can show, screenshots
// each one, and reads the card's box so "one geometry across the launch" is a
// measured claim rather than a described one.
//
// Manual instrument, not a CI gate. Run it when touching the boot-card family:
//
//   bun scripts/host-boot-family-gallery-browser.mjs [--out DIR] [--dark] [--viewport WxH]
//
// It writes `<face>.png` (and `<face>.dark.png` with --dark) into DIR (default:
// a fresh temp dir, printed), then prints one row per face: the card's left,
// top, width and height in CSS px at deviceScaleFactor 1, and whether the face
// is drawn through the shared `HostBootCard`. The rows a reader should expect:
//
//  - every family face has the SAME width (the shared card's `max-w-sm`) and
//    the SAME left edge - the card does not change shape as the launch hands
//    off between surfaces;
//  - the WAIT faces (runtime, attach, restoring, narrator-idle) additionally
//    share the same top and height - the card does not MOVE between them;
//  - the `dialog` face is the CONTROL: a different, wider box on purpose. A
//    run in which it matches the family is a run from an instrument that
//    cannot see width, and its table means nothing.
//
// Structure copied from `window-host-modal-alignment-browser.mjs` (vite +
// headless Chrome over CDP).
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const FACES = [
  "runtime",
  "attach",
  "restoring",
  "narrator-idle",
  "narrator-lane",
  "narrator-slow",
  "narrator-failed",
  "narrator-no-host",
  "narrator-plan",
  "narrator-update",
  "gate-provisioning-error",
  "gate-removed",
  "dialog",
];
/**
 * The faces that must not MOVE relative to one another (same top + height):
 * every healthy wait, INCLUDING the narrator with a lane reporting at 42% -
 * a launch crosses all five and the bar is on every one of them, so a lane
 * starting to report changes the sentence and the fill, not the box.
 * `narrator-slow` is deliberately not here: it grows a Retry action row,
 * which is a real state change on its own clock, not a hand-off.
 */
const WAIT_FACES = new Set([
  "runtime",
  "attach",
  "restoring",
  "narrator-idle",
  "narrator-lane",
]);

const args = process.argv.slice(2);
const dark = args.includes("--dark");
/** The value after `--flag`, or a usage error - never `undefined` into `split`. */
const flagValue = (flag) => {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
};
const viewportValue = flagValue("--viewport");
const [viewportWidth, viewportHeight] =
  viewportValue === null
    ? [1200, 900]
    : viewportValue.split("x").map((n) => Number(n));
if (
  !Number.isInteger(viewportWidth) ||
  !Number.isInteger(viewportHeight) ||
  viewportWidth <= 0 ||
  viewportHeight <= 0
) {
  throw new Error("--viewport expects WIDTHxHEIGHT, e.g. 1200x900");
}
const outValue = flagValue("--out");

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const fixtureUrlPath = "/src/__tests__/browser/host-boot-family-gallery.html";
const chromePath = await findChrome();
const profilePath = await mkdtemp(path.join(tmpdir(), "traycer-gallery-"));
const outDir =
  outValue === null
    ? await mkdtemp(path.join(tmpdir(), "traycer-boot-gallery-"))
    : path.resolve(outValue);
await mkdir(outDir, { recursive: true });
const vitePort = await freePort();
let devtoolsPort = await freePort();
while (devtoolsPort === vitePort) devtoolsPort = await freePort();
let chrome;
let client;
let viteProcess;

try {
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
  const baseUrl = `http://127.0.0.1:${vitePort}${fixtureUrlPath}`;
  await waitForHttp(baseUrl, viteProcess, () => viteError, "Vite");

  chrome = spawn(
    chromePath,
    [
      "--headless=new",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-features=Translate",
      "--disable-sync",
      "--no-default-browser-check",
      "--no-first-run",
      "--no-sandbox",
      `--remote-debugging-port=${devtoolsPort}`,
      `--user-data-dir=${profilePath}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let chromeError = "";
  chrome.stderr.setEncoding("utf8");
  chrome.stderr.on("data", (chunk) => {
    chromeError += chunk;
  });
  await waitForHttp(
    `http://127.0.0.1:${devtoolsPort}/json/version`,
    chrome,
    () => chromeError,
    "Chrome DevTools",
  );
  const targetResponse = await fetch(
    `http://127.0.0.1:${devtoolsPort}/json/new?about:blank`,
    { method: "PUT" },
  );
  if (!targetResponse.ok) {
    throw new Error(`Chrome could not open a page: ${targetResponse.status}`);
  }
  const target = await targetResponse.json();
  client = await connectCdp(target.webSocketDebuggerUrl);
  await client.send("Runtime.enable");
  await client.send("Page.enable");
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: viewportWidth,
    height: viewportHeight,
    deviceScaleFactor: 1,
    mobile: false,
  });

  const rows = [];
  for (const theme of dark ? ["light", "dark"] : ["light"]) {
    for (const face of FACES) {
      const url = `${baseUrl}?face=${face}${theme === "dark" ? "&theme=dark" : ""}`;
      await client.send("Page.navigate", { url });
      await waitFor(
        client,
        `face ${face} to be painted`,
        `Boolean(document.querySelector('[data-gallery-face="${face}"]')) &&
         Boolean(document.querySelector('[data-testid="window-host-modal"], [data-surface="host-boot-card"]'))`,
      );
      // Radix animates the dialog in; the startup card fades in. A rect read
      // mid-transform is a position the user never sees.
      await evaluate(client, `new Promise((r) => setTimeout(r, 700))`);
      const measured = await evaluate(
        client,
        `(() => {
          const card =
            document.querySelector('[data-testid="window-host-modal"]') ??
            document.querySelector('[data-surface="host-boot-card"]');
          const band = document.querySelector('[data-gallery-header-band]');
          const r = card.getBoundingClientRect();
          const round = (n) => Number(n.toFixed(1));
          // CAN THE USER GET TO ALL OF IT? A tall card is only a problem when
          // some of it cannot be brought into view, and which of those it is
          // depends entirely on what encloses it: a card in a column that GROWS
          // just makes the page scroll, the same card under a clipping or
          // fixed ancestor loses whatever falls outside. That is the whole
          // question behind \`viewportCapped\`, and it was argued rather than
          // measured until this.
          //
          // A \`fixed\` ancestor pins the card to the viewport, so the viewport
          // IS the bound (the narrator's layer - hence its cap). Otherwise the
          // bound is the document's scrollable height, narrowed by any
          // ancestor that CLIPS. \`auto\`/\`scroll\` ancestors do not narrow it:
          // the user can scroll those.
          const reach = (() => {
            // The card can also hide its OWN content: capped height plus
            // \`overflow-y: hidden\` clips the controls while the card's
            // rectangle still sits comfortably inside every ancestor, so a
            // check that only compares rectangles reports ok on a card whose
            // buttons are gone. \`auto\`/\`scroll\` is the capped card's actual
            // spelling and stays reachable - the user scrolls inside it.
            const own = getComputedStyle(card).overflowY;
            const cutInside =
              (own === 'hidden' || own === 'clip') &&
              card.scrollHeight > card.clientHeight + 0.5;
            let fixed = false;
            for (let el = card; el !== null; el = el.parentElement) {
              if (getComputedStyle(el).position === 'fixed') { fixed = true; break; }
            }
            const scrollRoot = document.scrollingElement;
            let top = 0;
            let bottom = fixed ? window.innerHeight : scrollRoot.scrollHeight;
            if (!fixed) {
              for (let el = card.parentElement; el !== null; el = el.parentElement) {
                const overflowY = getComputedStyle(el).overflowY;
                if (overflowY !== 'hidden' && overflowY !== 'clip') continue;
                const box = el.getBoundingClientRect();
                top = Math.max(top, box.top + window.scrollY);
                bottom = Math.min(bottom, box.top + window.scrollY + el.clientHeight);
              }
            }
            // Fixed cards are already measured against the viewport, so their
            // rect needs no scroll offset; everything else does.
            const cardTop = fixed ? r.top : r.top + window.scrollY;
            return {
              bound: round(bottom - top),
              cutAbove: cardTop < top - 0.5,
              cutBelow: cardTop + r.height > bottom + 0.5,
              cutInside,
            };
          })();
          return {
            reachBound: reach.bound,
            cutAbove: reach.cutAbove,
            cutBelow: reach.cutBelow,
            cutInside: reach.cutInside,
            sharedCard: card.getAttribute('data-surface') === 'host-boot-card',
            left: round(r.left),
            top: round(r.top),
            width: round(r.width),
            height: round(r.height),
            centerY: round(r.top + r.height / 2),
            bandHeight: band === null ? null : round(band.getBoundingClientRect().height),
            // By LABEL, not by testid: the escape hatch is a user-facing
            // promise ("Open settings" is on every card), and each surface
            // carries it under its own testid.
            openSettings: Array.from(document.querySelectorAll('button')).filter(
              (b) => b.textContent.trim() === 'Open settings',
            ).length,
            showDetails: document.querySelectorAll('[data-testid="local-host-loading-toggle-details"]').length,
            text: card.innerText.replace(/\\s+/g, ' ').trim().slice(0, 90),
          };
        })()`,
      );
      const shot = await client.send("Page.captureScreenshot", {
        format: "png",
      });
      const file = path.join(
        outDir,
        `${face}${theme === "dark" ? ".dark" : ""}.png`,
      );
      await writeFile(file, Buffer.from(shot.data, "base64"));
      rows.push({ face, theme, ...measured, file });
    }
  }

  // The report. Printed as a table, then judged.
  const pad = (s, n) => String(s).padEnd(n);
  console.log(
    `\nviewport ${viewportWidth}x${viewportHeight}, out ${outDir}\n` +
      [
        pad("face", 26),
        pad("theme", 6),
        pad("shared", 7),
        pad("left", 7),
        pad("top", 7),
        pad("width", 7),
        pad("height", 7),
        pad("cY", 7),
        pad("bound", 7),
        pad("reach", 8),
        pad("settings", 9),
        pad("details", 8),
        "text",
      ].join(" "),
  );
  for (const row of rows) {
    console.log(
      [
        pad(row.face, 26),
        pad(row.theme, 6),
        pad(row.sharedCard ? "yes" : "NO", 7),
        pad(row.left, 7),
        pad(row.top, 7),
        pad(row.width, 7),
        pad(row.height, 7),
        pad(row.centerY, 7),
        pad(row.reachBound, 7),
        pad(
          row.cutAbove || row.cutBelow || row.cutInside
            ? `CUT ${row.cutAbove ? "^" : ""}${row.cutBelow ? "v" : ""}${row.cutInside ? "in" : ""}`
            : "ok",
          8,
        ),
        pad(row.openSettings, 9),
        pad(row.showDetails, 8),
        row.text,
      ].join(" "),
    );
  }

  const family = rows.filter((row) => row.face !== "dialog");
  const control = rows.filter((row) => row.face === "dialog");
  const widths = new Set(family.map((row) => row.width));
  const lefts = new Set(family.map((row) => row.left));
  const controlSeesWidth = control.every((row) => !widths.has(row.width));
  const waits = family.filter((row) => WAIT_FACES.has(row.face));
  const waitBoxes = new Set(
    waits.map((row) => `${row.theme}:${row.top}:${row.height}`),
  );
  const waitBoxesPerTheme = dark ? 2 : 1;
  const everyFamilyShared = family.every((row) => row.sharedCard);
  const everyFamilyHasSettings = family.every((row) => row.openSettings >= 1);
  const findings = [];
  if (!controlSeesWidth) {
    findings.push(
      "CONTROL FAILED: the dialog measures the same width as the family - the instrument cannot see width; ignore this table.",
    );
  }
  if (widths.size !== 1) {
    findings.push(`family widths differ: ${[...widths].join(", ")}`);
  }
  if (lefts.size !== 1) {
    findings.push(`family left edges differ: ${[...lefts].join(", ")}`);
  }
  if (waitBoxes.size !== waitBoxesPerTheme) {
    findings.push(
      `wait faces do not share one box (top:height): ${[...waitBoxes].join(", ")}`,
    );
  }
  const unreachable = rows.filter(
    (row) => row.cutAbove || row.cutBelow || row.cutInside,
  );
  if (unreachable.length > 0) {
    findings.push(
      `content the user cannot scroll to: ${unreachable
        .map(
          (row) =>
            `${row.face}${row.cutAbove ? " (above)" : ""}${row.cutBelow ? " (below)" : ""}${row.cutInside ? " (clipped by the card)" : ""}`,
        )
        .join(", ")}`,
    );
  }
  if (!everyFamilyShared) {
    findings.push(
      `not drawn through HostBootCard: ${family
        .filter((row) => !row.sharedCard)
        .map((row) => row.face)
        .join(", ")}`,
    );
  }
  if (!everyFamilyHasSettings) {
    findings.push(
      `Open settings missing on: ${family
        .filter((row) => row.openSettings === 0)
        .map((row) => row.face)
        .join(", ")}`,
    );
  }
  console.log("");
  if (findings.length === 0) {
    console.log(
      `OK: ${family.length} family faces share one card (width ${[...widths][0]}, left ${[...lefts][0]}); ${waits.length} wait faces share one box; control differs (${control.map((r) => r.width).join("/")}).`,
    );
  } else {
    for (const finding of findings) console.log(`FINDING: ${finding}`);
    process.exitCode = 1;
  }
} finally {
  client?.close();
  chrome?.kill("SIGKILL");
  viteProcess?.kill("SIGKILL");
  await delay(300);
  try {
    await rm(profilePath, { recursive: true, force: true });
  } catch {
    // A leftover temp profile is not a measurement result.
  }
}

async function findChrome() {
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error("No Chrome/Chromium binary found");
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
    // A socket that dies mid-run must FAIL the run, not hang it: every
    // in-flight request is rejected on close/error, and a send on a socket
    // that is not open rejects immediately, so a Chrome crash surfaces as an
    // error with a message rather than as a driver that never exits.
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
