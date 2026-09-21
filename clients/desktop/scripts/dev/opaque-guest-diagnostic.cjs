"use strict";

/**
 * Real-Electron regression check for the shared webview guest background.
 * It extracts and calls the production guest hardener, then checks initial
 * navigation, reload, navigation/back, dark pages, and raw/composed captures.
 *
 *   electron scripts/dev/opaque-guest-diagnostic.cjs
 *   # Linux headless: xvfb-run -a electron scripts/dev/opaque-guest-diagnostic.cjs
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, nativeTheme, webContents } = require("electron");
const { stripTypeScriptTypes } = require("node:module");
const vm = require("node:vm");

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "traycer-opaque-guest-"));
app.setPath("userData", profile);
app.commandLine.appendSwitch("disable-gpu");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (predicate) => {
  const timeout = 8000;
  for (let elapsed = 0; elapsed < timeout; elapsed += 50) {
    if (predicate()) return;
    await wait(50);
  }
  throw new Error("timed out waiting for Electron state");
};

function loadProductionHardener() {
  const file = path.join(
    __dirname,
    "..",
    "..",
    "src",
    "electron-main",
    "browser-view",
    "webview-guest-birth.ts",
  );
  const source = fs.readFileSync(file, "utf8");
  const allowStart = source.indexOf("const HARDENED_GUEST_PREFERENCE_KEYS");
  const allowEnd = source.indexOf("]);", allowStart) + 3;
  const functionStart = source.indexOf("function hardenGuestPreferences");
  const functionEnd =
    source.indexOf("\n}\n\n/**\n * The renderer", functionStart) + 2;
  if (allowStart < 0 || allowEnd < 3 || functionStart < 0 || functionEnd < 2)
    throw new Error("could not locate production guest hardener");
  const snippet = stripTypeScriptTypes(
    source.slice(allowStart, allowEnd) +
      "\n" +
      source.slice(functionStart, functionEnd),
    { mode: "strip" },
  );
  return vm.runInNewContext(
    "(() => { " + snippet + "; return hardenGuestPreferences; })()",
  );
}

const pixel = (image, x, y) => {
  const { width } = image.getSize();
  const bitmap = image.toBitmap();
  const offset = (y * width + x) * 4;
  return {
    r: bitmap[offset + 2],
    g: bitmap[offset + 1],
    b: bitmap[offset],
    a: bitmap[offset + 3],
  };
};

function assertCapture(label, raw, composed) {
  const rawBitmap = raw.toBitmap();
  for (let i = 3; i < rawBitmap.length; i += 4) {
    if (rawBitmap[i] !== 255)
      throw new Error(`${label}: raw capture has transparent pixels`);
  }
  const p = pixel(composed, 180, 120);
  if (p.r > 220 && p.b > 220 && p.g < 50) {
    throw new Error(
      `${label}: composed capture exposes magenta backing ${JSON.stringify(p)}`,
    );
  }
}

const pages = [
  ["light-default", "<body style='margin:0;color:#111'>light</body>"],
  [
    "scheme-dark",
    "<style>:root{color-scheme:dark}body{margin:0;color:CanvasText}</style><body>dark scheme</body>",
  ],
  [
    "light-dark",
    "<style>:root{color-scheme:light dark}body{margin:0;color:CanvasText}</style><body>adaptive</body>",
  ],
  [
    "explicit-dark",
    "<style>html,body{margin:0;background:#17172a;color:white}</style><body>dark surface</body>",
  ],
];

const dataPage = (html) =>
  `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

async function run() {
  const hardenGuestPreferences = loadProductionHardener();
  let cases = 0;
  let captures = 0;
  for (const theme of ["light", "dark"]) {
    nativeTheme.themeSource = theme;
    for (const [index, [name, html]] of pages.entries()) {
      const partition =
        "persist:opaque-guest-" + process.pid + "-" + theme + "-" + index;
      const initialUrl = dataPage(html);
      const win = new BrowserWindow({
        width: 400,
        height: 300,
        show: true,
        backgroundColor: "#ff00ff",
        webPreferences: {
          contextIsolation: true,
          sandbox: true,
          webviewTag: true,
        },
      });
      win.webContents.on("will-attach-webview", (_event, prefs) =>
        hardenGuestPreferences(prefs, partition),
      );
      try {
        const host =
          '<body style="margin:0;background:#ff00ff"><webview id="guest" style="width:360px;height:240px" partition="' +
          partition +
          '" webpreferences="transparent=true" src="' +
          initialUrl +
          '"></webview></body>';
        await win.loadURL(dataPage(host));
        const guestId = await win.webContents.executeJavaScript(
          'document.getElementById("guest").getWebContentsId()',
        );
        await waitFor(
          () =>
            Number.isInteger(guestId) && webContents.fromId(guestId) !== null,
        );
        const guest = webContents.fromId(guestId);
        if (!guest)
          throw new Error(theme + "/" + name + ": guest did not materialize");
        await waitFor(
          () => !guest.isLoading() && guest.getURL() === initialUrl,
        );
        const load = (action) =>
          new Promise((resolve, reject) => {
            const fail = (_event, code, description) =>
              reject(
                new Error(
                  theme +
                    "/" +
                    name +
                    ": load failed " +
                    code +
                    " " +
                    description,
                ),
              );
            guest.once("did-finish-load", resolve);
            guest.once("did-fail-load", fail);
            action();
          });
        const capture = async (stage, expected) => {
          captures += 2;
          await wait(200);
          const raw = await guest.capturePage({
            x: 0,
            y: 0,
            width: 360,
            height: 240,
          });
          const composed = await win.webContents.capturePage({
            x: 0,
            y: 0,
            width: 400,
            height: 300,
          });
          assertCapture(theme + "/" + name + "/" + stage, raw, composed);
          const rawPixel = pixel(raw, 180, 120);
          for (const [label, image] of [
            ["raw", raw],
            ["composed", composed],
          ]) {
            const actual = pixel(image, 180, 120);
            if (expected === null) {
              if (
                actual.r !== rawPixel.r ||
                actual.g !== rawPixel.g ||
                actual.b !== rawPixel.b
              )
                throw new Error(
                  theme +
                    "/" +
                    name +
                    "/" +
                    stage +
                    ": " +
                    label +
                    " pixel differs from the opaque guest reference " +
                    JSON.stringify(rawPixel),
                );
              continue;
            }
            if (
              actual.r !== expected[0] ||
              actual.g !== expected[1] ||
              actual.b !== expected[2]
            )
              throw new Error(
                theme +
                  "/" +
                  name +
                  "/" +
                  stage +
                  ": " +
                  label +
                  " " +
                  JSON.stringify(actual) +
                  " expected " +
                  expected.join(","),
              );
          }
        };
        const expectedFor = (pageName) =>
          pageName === "explicit-dark" ? [23, 23, 42] : null;
        const expected = expectedFor(name);
        await capture("initial", expected);
        await load(() => guest.reload());
        await capture("reload", expected);
        await load(() =>
          guest.loadURL(dataPage(pages[(index + 1) % pages.length][1])),
        );
        await capture(
          "navigation",
          expectedFor(pages[(index + 1) % pages.length][0]),
        );
        await load(() => guest.navigationHistory.goBack());
        await capture("back", expected);
        cases += 1;
        console.log(
          "PASS " +
            theme +
            "/" +
            name +
            ": initial/reload/navigation/back/raw+composed captures",
        );
      } finally {
        if (!win.isDestroyed()) win.destroy();
        await wait(200);
      }
    }
  }
  console.log(
    "PASS summary: Electron " +
      process.versions.electron +
      "; " +
      cases +
      " cases; " +
      captures +
      " raw+composed captures",
  );
}

app.on("window-all-closed", () => {});
app.on("will-quit", () => fs.rmSync(profile, { recursive: true, force: true }));
const timeout = setTimeout(() => {
  console.error("opaque guest diagnostic timed out");
  app.exit(1);
}, 120000);
timeout.unref();
app
  .whenReady()
  .then(run)
  .then(() => app.quit())
  .catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
    app.quit();
  });
