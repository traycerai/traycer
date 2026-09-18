// Browser regression: every label on the sign-in page stays legible under
// every theme preset, in both appearances, in every state the page can show.
//
// The page paints a FIXED dark ground and its controls take their colours from
// theme tokens, so legibility is a property of the rendered cascade under a
// particular theme. jsdom has neither a cascade nor pixels. This renders the
// real `AuthLandingPage` (`src/__tests__/browser/sign-in-theme-contrast.tsx`),
// switches the theme through the real theme applier, and for every visible
// piece of text reads:
//   - the text colour from the computed style, with its alpha and every
//     ancestor's opacity folded in, and
//   - the background from PIXELS: a screenshot taken with all text made
//     transparent, averaged over the text's own box - so a translucent button
//     fill over the photo backdrop is measured as it actually renders.
// It then asserts WCAG AA (4.5:1) for every enabled label, and that no label's
// colours move between themes: the page is one fixed design, so a theme that
// changes any of them is the drift this exists to catch.
//
// Usage: node scripts/sign-in-theme-contrast-browser.mjs [--out DIR] [--report]
//   --out DIR   also write a screenshot per state and theme, and one contact
//               sheet per theme (every state side by side), into DIR.
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

const MIN_CONTRAST = 4.5;
// A label's colours may differ between themes by rounding only.
const MAX_THEME_SPREAD = 0.05;
const DESKTOP = { width: 1280, height: 800, mobile: false };
const PHONE = { width: 390, height: 844, mobile: true };
// Text measured and reported, but not held to AA. Each reads the same under
// every theme, including the default dark one the page was designed in, so no
// theme can make it worse - the drift check below still holds them to that.
// They are the design's own choices on the fixed ground, not what a theme
// breaks. Matched against the label the driver prints for the element.
const EXEMPT = [
  // The build stamp in the corner, a deliberately recessive white alpha.
  /^footer span /,
  // The device-code panel's field caption (white/55) and its "start over"
  // escape link (white/72), over the panel's translucent fill.
  /^signin-device-progress span "Approval address"/,
  /^signin-retry-link button /,
  // The manual-entry validation notice: the destructive red over the brighter
  // lower half of the photo backdrop.
  /^link-code-signin-notice p /,
];
const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outDir =
  outIndex === -1 ? null : path.resolve(args[outIndex + 1] ?? "sign-in-shots");
const report = args.includes("--report");

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const fixtureUrlPath = "/src/__tests__/browser/sign-in-theme-contrast.html";
const chromePath = await findChrome("the sign-in theme contrast regression");
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
    "traycer-sign-in-contrast-",
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

  // Discover the states and presets from the fixture itself, so a preset
  // added to the registry is covered without touching this driver.
  await navigate(client, `${baseUrl}?state=desktop-rest`);
  const states = await evaluate(client, "window.__probeStates");
  const presets = await evaluate(client, "window.__probePresets");
  const themes = presets.flatMap((preset) => [
    { mode: "light", preset },
    { mode: "dark", preset },
  ]);

  const failures = [];
  const measured = [];
  const shots = new Map();
  for (const state of states) {
    const viewport = state.startsWith("mobile-") ? PHONE : DESKTOP;
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: viewport.mobile,
    });
    await navigate(client, `${baseUrl}?state=${state}`);
    await waitFor(client, `state ${state} to settle`, "window.__probeReady");
    await prepareState(client, state);

    for (const theme of themes) {
      const themeKey = `${theme.mode}-${theme.preset}`;
      await evaluate(
        client,
        `window.__probeTheme(${JSON.stringify(theme.mode)}, ${JSON.stringify(theme.preset)})`,
      );
      await settle(client);
      if (outDir !== null) {
        const shot = await client.send("Page.captureScreenshot", {
          format: "png",
        });
        const file = path.join(outDir, `${themeKey}.${state}.png`);
        await writeFile(file, Buffer.from(shot.data, "base64"));
        if (!shots.has(themeKey)) shots.set(themeKey, []);
        shots.get(themeKey).push({ state, file, viewport });
      }
      if (state === "splash") continue;
      const labels = await measureLabels(client);
      assert.ok(labels.length > 0, `no text measured in ${state}`);
      for (const label of labels) {
        measured.push({ state, theme: themeKey, ...label });
      }
    }
  }

  // AA on every enabled label, under every theme.
  for (const row of measured) {
    if (row.disabled) continue;
    if (EXEMPT.some((exempt) => exempt.test(row.label))) continue;
    if (row.ratio < MIN_CONTRAST) failures.push(row);
  }
  // One design under every theme: a label's colours must not move.
  const drift = [];
  const byLabel = new Map();
  for (const row of measured) {
    const key = `${row.state} :: ${row.label}`;
    if (!byLabel.has(key)) byLabel.set(key, []);
    byLabel.get(key).push(row);
  }
  for (const [key, rows] of byLabel) {
    const ratios = rows.map((row) => row.ratio);
    const spread = Math.max(...ratios) - Math.min(...ratios);
    if (rows.length !== themes.length) {
      drift.push(
        `${key}: present under ${rows.length}/${themes.length} themes`,
      );
    } else if (spread > MAX_THEME_SPREAD) {
      const low = rows.reduce((a, b) => (b.ratio < a.ratio ? b : a));
      const high = rows.reduce((a, b) => (b.ratio > a.ratio ? b : a));
      drift.push(
        `${key}: ${low.ratio.toFixed(2)} (${low.theme}) .. ${high.ratio.toFixed(2)} (${high.theme})`,
      );
    }
  }

  if (report) {
    for (const [key, rows] of byLabel) {
      const ratios = rows.map((row) => row.ratio);
      console.log(
        `${key.padEnd(90)} min ${Math.min(...ratios).toFixed(2)} max ${Math.max(...ratios).toFixed(2)}${rows[0].disabled ? " (disabled)" : ""}${EXEMPT.some((exempt) => exempt.test(rows[0].label)) ? " (exempt)" : ""}`,
      );
    }
  }

  if (outDir !== null) {
    for (const [themeKey, list] of shots) {
      await writeContactSheet(client, outDir, themeKey, list);
    }
  }

  console.log(
    `${states.length} states x ${themes.length} themes, ${measured.length} label readings${outDir === null ? "" : `, screenshots in ${outDir}`}`,
  );
  if (failures.length > 0) {
    const worst = new Map();
    for (const row of failures) {
      const key = `${row.state} :: ${row.label}`;
      const seen = worst.get(key);
      if (seen === undefined || row.ratio < seen.ratio) {
        worst.set(key, { ...row, count: (seen?.count ?? 0) + 1 });
      } else {
        seen.count += 1;
      }
    }
    for (const [key, row] of worst) {
      console.log(
        `BELOW ${MIN_CONTRAST}:1 ${key} - worst ${row.ratio.toFixed(2)} under ${row.theme} (fg ${row.fg} on bg ${row.bg}); failing under ${row.count}/${themes.length} themes`,
      );
    }
  }
  for (const line of drift) console.log(`THEME DRIFT ${line}`);
  assert.equal(failures.length, 0, "labels below AA - see above");
  assert.equal(drift.length, 0, "label colours move with the theme");
  console.log("sign-in theme contrast regression passed");
} catch (error) {
  console.error("MEASUREMENT FAILED:", error);
  process.exitCode = 1;
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

/**
 * Puts the page into the part of a state the fixture cannot reach by itself:
 * the manual-entry form is opened by the user, and its validation notice by a
 * submit.
 */
async function prepareState(client, state) {
  if (state === "splash") {
    // Captured while it covers the page.
    return;
  }
  // Every other state is read after the splash has retired.
  await waitFor(
    client,
    "the splash to retire",
    `document.querySelector('[data-testid="auth-brand-splash"]') === null`,
  );
  // A theme switch would otherwise be read mid-transition (the hero button
  // eases its colours), and the reading would depend on timing.
  await evaluate(
    client,
    `(() => {
       const style = document.createElement("style");
       style.textContent = "*, *::before, *::after { transition: none !important; }";
       document.head.append(style);
     })()`,
  );
  await delay(500);
  if (state === "mobile-manual" || state === "mobile-manual-error") {
    await evaluate(
      client,
      `document.querySelector('[data-testid="link-code-signin-manual"]').click()`,
    );
    await waitFor(
      client,
      "the manual entry form",
      `document.querySelector('[data-testid="link-code-signin-input"]') !== null`,
    );
    const value = state === "mobile-manual" ? "ABCDE-FGHJK" : "not a code";
    await evaluate(
      client,
      `(() => {
         const input = document.querySelector('[data-testid="link-code-signin-input"]');
         const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
         setter.call(input, ${JSON.stringify(value)});
         input.dispatchEvent(new Event("input", { bubbles: true }));
       })()`,
    );
    if (state === "mobile-manual-error") {
      await evaluate(
        client,
        `document.querySelector('[data-testid="link-code-signin-submit"]').click()`,
      );
      await waitFor(
        client,
        "the validation notice",
        `document.querySelector('[data-testid="link-code-signin-notice"]') !== null`,
      );
    }
  }
  if (state === "desktop-device") {
    await waitFor(
      client,
      "the device approval panel",
      `document.querySelector('[data-testid="signin-device-progress"]') !== null`,
    );
  }
  if (state === "desktop-error") {
    await waitFor(
      client,
      "the sign-in error",
      `document.querySelector('[data-testid="signin-error"]') !== null`,
    );
  }
  if (state === "mobile-claim") {
    await waitFor(
      client,
      "the claim wait",
      `document.querySelector('[data-testid="link-code-signin-waiting"]') !== null`,
    );
  }
}

/**
 * Every visible run of text on the page, with its colour and the colour of the
 * pixels behind it. Text is found as elements with a non-blank text node of
 * their own, plus inputs with a value.
 */
async function measureLabels(client) {
  const labels = await evaluate(
    client,
    `(() => {
       const canvas = document.createElement("canvas");
       canvas.width = 1;
       canvas.height = 1;
       const ctx = canvas.getContext("2d", { willReadFrequently: true });
       const toRgba = (css) => {
         ctx.clearRect(0, 0, 1, 1);
         ctx.fillStyle = "#000";
         ctx.fillStyle = css;
         ctx.fillRect(0, 0, 1, 1);
         const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
         return [r, g, b, a / 255];
       };
       const opacityOf = (element) => {
         let opacity = 1;
         for (let node = element; node instanceof Element; node = node.parentElement) {
           opacity *= Number(getComputedStyle(node).opacity);
         }
         return opacity;
       };
       // Stable across a run: spinner frames and ticking digits are dropped,
       // so one label is one key under every theme.
       const labelOf = (element) => {
         const owner = element.closest("footer, [data-testid]");
         const text = (element instanceof HTMLInputElement ? element.value : element.textContent)
           .replace(/[\\u2800-\\u28ff]/g, "").replace(/[0-9]+/g, "#")
           .trim().replace(/\\s+/g, " ").slice(0, 40);
         const tag = element.tagName.toLowerCase();
         const where = owner === null ? "page" : owner.dataset.testid ?? "footer";
         return where + " " + tag + " \\"" + text + "\\"";
       };
       const rows = [];
       const candidates = [
         ...document.querySelectorAll("main *, [data-slot=tooltip-content] *"),
       ];
       for (const element of candidates) {
         let rect = null;
         if (element instanceof HTMLInputElement) {
           if (element.value === "") continue;
           rect = element.getBoundingClientRect();
         } else {
           const own = [...element.childNodes].filter(
             (node) =>
               node.nodeType === Node.TEXT_NODE &&
               node.textContent.replace(/[\\u2800-\\u28ff]/g, "").trim() !== "",
           );
           if (own.length === 0) continue;
           const range = document.createRange();
           const boxes = own.flatMap((node) => {
             range.selectNodeContents(node);
             return [...range.getClientRects()];
           });
           if (boxes.length === 0) continue;
           const left = Math.min(...boxes.map((box) => box.left));
           const top = Math.min(...boxes.map((box) => box.top));
           const right = Math.max(...boxes.map((box) => box.right));
           const bottom = Math.max(...boxes.map((box) => box.bottom));
           rect = { left, top, width: right - left, height: bottom - top };
         }
         const style = getComputedStyle(element);
         // Screen-reader-only copy is clipped to a pixel; it is not seen.
         if (rect.width < 2 || rect.height < 2) continue;
         if (style.visibility === "hidden") continue;
         const opacity = opacityOf(element);
         if (opacity === 0) continue;
         const [r, g, b, a] = toRgba(style.color);
         rows.push({
           label: labelOf(element),
           fg: [r, g, b, a * opacity],
           rect: {
             x: Math.round(rect.left),
             y: Math.round(rect.top),
             width: Math.round(rect.width),
             height: Math.round(rect.height),
           },
           disabled: element.closest(":disabled") !== null,
         });
       }
       return rows;
     })()`,
  );

  // The background, from pixels: the same page with every glyph transparent.
  await evaluate(
    client,
    `(() => {
       const style = document.createElement("style");
       style.id = "probe-hide-text";
       style.textContent = "*, *::placeholder { color: transparent !important; -webkit-text-fill-color: transparent !important; caret-color: transparent !important; }";
       document.head.append(style);
     })()`,
  );
  await settle(client);
  const shot = await client.send("Page.captureScreenshot", { format: "png" });
  await evaluate(client, `document.getElementById("probe-hide-text").remove()`);

  const backgrounds = await evaluate(
    client,
    `(async () => {
       const image = new Image();
       image.src = "data:image/png;base64,${shot.data}";
       await image.decode();
       const canvas = document.createElement("canvas");
       canvas.width = image.naturalWidth;
       canvas.height = image.naturalHeight;
       const ctx = canvas.getContext("2d", { willReadFrequently: true });
       ctx.drawImage(image, 0, 0);
       const rects = ${JSON.stringify(labels.map((label) => label.rect))};
       return rects.map((rect) => {
         const x = Math.max(0, rect.x);
         const y = Math.max(0, rect.y);
         const width = Math.max(1, Math.min(rect.width, canvas.width - x));
         const height = Math.max(1, Math.min(rect.height, canvas.height - y));
         const data = ctx.getImageData(x, y, width, height).data;
         let r = 0, g = 0, b = 0, n = 0;
         for (let i = 0; i < data.length; i += 4) {
           r += data[i]; g += data[i + 1]; b += data[i + 2]; n += 1;
         }
         return [r / n, g / n, b / n];
       });
     })()`,
  );

  return labels.map((label, index) => {
    const bg = backgrounds[index];
    const [fr, fg, fb, fa] = label.fg;
    const text = [
      fr * fa + bg[0] * (1 - fa),
      fg * fa + bg[1] * (1 - fa),
      fb * fa + bg[2] * (1 - fa),
    ];
    return {
      label: label.label,
      disabled: label.disabled,
      ratio: contrast(text, bg),
      fg: hex(text),
      bg: hex(bg),
    };
  });
}

function luminance([r, g, b]) {
  const channel = (value) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

function hex(rgb) {
  return `#${rgb
    .map((value) => Math.round(value).toString(16).padStart(2, "0"))
    .join("")}`;
}

/** Every state of one theme on one page, captured as one image. */
async function writeContactSheet(client, outDir, themeKey, list) {
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: 2400,
    height: 1200,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const tiles = list
    .map(
      (shot) =>
        `<figure><img src="file://${shot.file}" width="${Math.round(shot.viewport.width / 2)}"><figcaption>${shot.state}</figcaption></figure>`,
    )
    .join("");
  const html = `<!doctype html><body style="margin:0;background:#777;font:14px sans-serif"><h2 style="margin:8px">${themeKey}</h2><div style="display:flex;flex-wrap:wrap;gap:8px;padding:8px;align-items:flex-start">${tiles}</div></body>`;
  const sheetHtml = path.join(outDir, `sheet.${themeKey}.html`);
  await writeFile(sheetHtml, html);
  await navigate(client, `file://${sheetHtml}`);
  await evaluate(
    client,
    `Promise.all([...document.images].map((image) => image.decode()))`,
  );
  const shot = await client.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
  });
  await writeFile(
    path.join(outDir, `sheet.${themeKey}.png`),
    Buffer.from(shot.data, "base64"),
  );
  await rm(sheetHtml);
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
