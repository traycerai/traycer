/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

/**
 * Real-Electron regression check: View > Reload / Force Reload (and, on macOS
 * with the optional addon, the real Cmd+R key equivalent) must hit the page
 * that owns keyboard focus - the app, or exactly one guest, including when a
 * detached DevTools window has focus - never another guest. Drives the PRODUCTION menu (`buildApplicationMenu`), not a copy.
 *
 *   electron scripts/dev/reload-focus-diagnostic.cjs [bundle.cjs] [--addon=reload-focus-native-key.node]
 *   (Linux headless: prefix with xvfb-run -a)
 *
 * With no bundle argument the menu is bundled with esbuild into the OS temp
 * dir. The addon (see reload-focus-native-key.m) is optional and macOS-only;
 * without it only the menu-item click path runs. Every case builds fresh
 * windows, so retained-guest state never depends on an earlier app reload.
 * 9 scenarios x {Reload, Force Reload} = 18 cases per trigger (36 with the
 * addon). Exit 0 = all passed.
 */

const {
  app,
  BaseWindow,
  BrowserWindow,
  Menu,
  webContents,
} = require("electron");
const os = require("node:os");
const path = require("node:path");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const args = process.argv.slice(2);
const addonArg = args.find((a) => a.startsWith("--addon="));
const bundleArg = args.find((a) => !a.startsWith("--"));
app.setPath(
  "userData",
  path.join(os.tmpdir(), `reload-focus-diagnostic-${process.pid}`),
);

function loadMenuBundle() {
  let file = bundleArg;
  if (!file) {
    file = path.join(os.tmpdir(), `reload-focus-menu-${process.pid}.cjs`);
    const root = path.resolve(__dirname, "../..");
    require("esbuild").buildSync({
      stdin: {
        contents:
          'export { buildApplicationMenu } from "./src/electron-main/menu/menu-builder";',
        resolveDir: root,
        loader: "ts",
      },
      bundle: true,
      platform: "node",
      format: "cjs",
      external: ["electron"],
      outfile: file,
    });
  }
  return require(path.resolve(file));
}

// Per-webContents counters: JS-level reload calls and finished loads.
const recs = new Map();
app.on("web-contents-created", (_e, wc) => {
  const rec = { loads: 0, reload: 0, force: 0 };
  recs.set(wc.id, rec);
  wc.on("did-finish-load", () => rec.loads++);
  const reload = wc.reload.bind(wc);
  const force = wc.reloadIgnoringCache.bind(wc);
  wc.reload = () => (rec.reload++, reload());
  wc.reloadIgnoringCache = () => (rec.force++, force());
});

const until = async (cond, ms) => {
  for (let t = 0; t < ms && !cond(); t += 50) await delay(50);
  return cond();
};

// A custom or built-in inspector may never emit did-finish-load for our
// counters, so judge it by state: not loading and a real URL.
const inspectorReady = (wc) =>
  !!wc && !wc.isDestroyed() && !wc.isLoading() && wc.getURL() !== "";

async function makeWindow(label) {
  const win = new BrowserWindow({
    width: 700,
    height: 420,
    title: `reload diagnostic ${label}`,
    webPreferences: {
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const html =
    `<input id="app-input"><div id="a-wrap"><webview id="a" src="data:text/html,${label}A" style="width:200px;height:120px"></webview></div>` +
    `<div id="b-wrap"><webview id="b" src="data:text/html,${label}B" style="width:200px;height:120px"></webview></div>`;
  try {
    return await prepareWindow(win, label, html);
  } catch (e) {
    win.destroy();
    throw e;
  }
}

async function prepareWindow(win, label, html) {
  await win.loadURL("data:text/html," + encodeURIComponent(html));
  // getWebContentsId throws until the guest's dom-ready, so poll.
  let ids;
  for (let t = 0; t < 8000 && !ids; t += 100) {
    ids = await win.webContents
      .executeJavaScript(
        `['a','b'].map(id => document.getElementById(id).getWebContentsId())`,
      )
      .catch(() => delay(100).then(() => undefined));
  }
  if (!ids || !ids.every(Number.isInteger))
    throw new Error(`${label}: guest ids never became available`);
  const w = {
    win,
    extras: [],
    host: win.webContents,
    a: webContents.fromId(ids[0]),
    b: webContents.fromId(ids[1]),
  };
  if (!w.a || !w.b)
    throw new Error(`${label}: guest webContents not found for ids ${ids}`);
  if (
    !(await until(
      () => [w.host, w.a, w.b].every((wc) => recs.get(wc.id)?.loads >= 1),
      8000,
    ))
  ) {
    throw new Error(
      `${label}: host and both guests did not finish their initial load`,
    );
  }
  const page = (code) =>
    win.webContents.executeJavaScript(code).then(() => delay(150));
  w.focusApp = () =>
    page(
      `document.activeElement.blur(); document.getElementById('app-input').focus()`,
    );
  w.focusGuest = (id) => page(`document.getElementById('${id}').focus()`);
  // Task switch: guests stay mounted but blurred, off-screen, inert.
  w.retainHidden = () =>
    page(
      `document.activeElement.blur(); for (const id of ['a-wrap','b-wrap']) { const x = document.getElementById(id); x.style.cssText = 'position:fixed;left:-10000px;opacity:0;pointer-events:none;display:block'; x.inert = true } document.getElementById('app-input').focus()`,
    );
  w.removeGuests = () =>
    page(
      `document.querySelectorAll('webview').forEach(v => v.remove()); document.getElementById('app-input').focus()`,
    );
  return w;
}

// windows: how many to open (default 1); setup prepares focus; fire/fireWin:
// window (index or picker) that triggers the action; keepInspectorFocus: the
// menu gets BaseWindow.getFocusedWindow() and the native key does not re-focus
// a window; target(ws): the one webContents that must reload.
const SCENARIOS = [
  {
    name: "app focused, two guests",
    setup: async ([w]) => w.focusApp(),
    target: ([w]) => w.host,
  },
  {
    name: "guest A focused",
    setup: async ([w]) => w.focusGuest("a"),
    target: ([w]) => w.a,
  },
  {
    name: "guest B focused",
    setup: async ([w]) => w.focusGuest("b"),
    target: ([w]) => w.b,
  },
  {
    name: "hidden inert retained guests, app focused",
    setup: async ([w]) => w.retainHidden(),
    target: ([w]) => w.host,
  },
  {
    name: "no guests",
    setup: async ([w]) => w.removeGuests(),
    target: ([w]) => w.host,
  },
  {
    // Traycer's custom detached DevTools window: the inspector owns keyboard
    // focus, the menu fires from ITS window, and the inspected guest must reload.
    name: "guest's detached DevTools window focused",
    setup: async ([w]) => {
      const inspector = new BrowserWindow({
        width: 700,
        height: 420,
        title: "reload diagnostic inspector",
      });
      w.extras.push(inspector);
      w.a.setDevToolsWebContents(inspector.webContents);
      w.a.openDevTools({ mode: "detach" });
      // isDevToolsOpened() reports the managed docked/detached view, so it may
      // stay false for an external inspector; require the exact wc identity instead.
      const state = () => ({
        opened: w.a.isDevToolsOpened(),
        guestId: w.a.id,
        inspectorId: inspector.webContents.id,
        reportedInspectorId: w.a.devToolsWebContents?.id ?? null,
        url: inspector.webContents.getURL(),
        isLoading: inspector.webContents.isLoading(),
      });
      const ready = () =>
        w.a.devToolsWebContents?.id === inspector.webContents.id &&
        inspectorReady(inspector.webContents) &&
        inspector.webContents.getURL().startsWith("devtools://");
      if (!(await until(ready, 15000))) {
        throw new Error(
          `DevTools inspector did not open: ${JSON.stringify(state())}`,
        );
      }
      await delay(1000);
      inspector.focus();
      inspector.webContents.focus();
      await delay(300);
    },
    fireWin: ([w]) => w.extras[0],
    target: ([w]) => w.a,
  },
  {
    // Electron's built-in detached DevTools for the app itself. The inspector
    // is a WebContents, not a BaseWindow, so the menu callback's window is
    // whatever BaseWindow.getFocusedWindow() reports (possibly undefined) and
    // the native key must NOT re-focus the app window. Guest A is focused first so
    // the app's stale focusedFrame is a guest. Target: the app.
    name: "app's built-in detached DevTools focused",
    keepInspectorFocus: true,
    setup: async ([w]) => {
      // Last focused frame is guest A, so a stale focusedFrame would pick it.
      await w.focusGuest("a");
      // activate:true lets Electron focus the inspector natively; calling
      // inspector.focus() would focus its owner window (the app) first.
      w.host.openDevTools({ mode: "detach", activate: true });
      const opened = () =>
        w.host.isDevToolsOpened() && inspectorReady(w.host.devToolsWebContents);
      if (!(await until(opened, 15000))) {
        const dt = w.host.devToolsWebContents;
        throw new Error(
          `built-in DevTools inspector did not open: ${JSON.stringify({
            opened: w.host.isDevToolsOpened(),
            inspectorId: dt?.id ?? null,
            url: dt?.getURL() ?? null,
            isLoading: dt?.isLoading() ?? null,
          })}`,
        );
      }
      w.inspector = w.host.devToolsWebContents;
      await delay(1500);
      if (!w.host.isDevToolsFocused() || !w.inspector.isFocused())
        throw new Error(
          "built-in DevTools inspector did not take native focus",
        );
    },
    target: ([w]) => w.host,
  },
  ...[0, 1].map((fire) => ({
    name: `two windows, fire from window ${fire}`,
    windows: 2,
    fire,
    setup: async ([w0, w1]) => (await w0.focusGuest("a"), w1.focusGuest("b")),
    target: (ws) => (fire === 0 ? ws[0].a : ws[1].b),
  })),
];

async function runCase(mod, scenario, kind, trigger, addon) {
  const ws = [];
  try {
    for (let i = 0; i < (scenario.windows ?? 1); i++)
      ws.push(await makeWindow(`w${i}`));
    app.focus({ steal: true });
    ws[0].win.focus();
    if (!(await until(() => ws[0].win.isFocused(), 8000)))
      throw new Error("application window did not take native focus");
    const menu = mod.buildApplicationMenu(
      {
        appName: "Traycer",
        platform: process.platform,
        authSession: { status: "signed-out" },
        host: { status: "ready", version: "0.0.0" },
        windows: [],
        focusedWindowId: null,
        canCloseTab: true,
        canCheckForUpdates: false,
        canOpenDevTools: false,
        hostUpdateAvailableVersion: null,
      },
      {
        command() {},
        toggleAppDevTools() {},
        focusWindow() {},
        openExternal() {},
      },
    );
    Menu.setApplicationMenu(menu);
    await scenario.setup(ws);
    const fireWin = scenario.fireWin
      ? scenario.fireWin(ws)
      : ws[scenario.fire ?? 0].win;
    // Built-in inspector: Electron hands the menu callback the focused BaseWindow only.
    const clickWin = scenario.keepInspectorFocus
      ? (BaseWindow.getFocusedWindow() ?? undefined)
      : fireWin;
    const target = scenario.target(ws);
    const before = new Map(
      ws
        .flatMap((w) => [
          w.host,
          w.a,
          w.b,
          ...w.extras.map((x) => x.webContents),
          ...(w.inspector ? [w.inspector] : []),
        ])
        .map((wc) => [wc.id, { ...recs.get(wc.id) }]),
    );
    const force = kind === "Force Reload";
    if (trigger === "native-key") {
      if (!scenario.keepInspectorFocus) {
        app.focus({ steal: true });
        fireWin.focus();
        if (!(await until(() => fireWin.isFocused(), 8000)))
          throw new Error("firing window did not take native focus");
      }
      await delay(300);
    }
    const frameWc = (wc) =>
      wc.focusedFrame
        ? (webContents.fromFrame(wc.focusedFrame)?.id ?? null)
        : null;
    console.log(
      `  focus [${trigger}] ${kind}: ${scenario.name} ` +
        JSON.stringify({
          baseWindowFocused: BaseWindow.getFocusedWindow()?.id ?? null,
          browserWindowFocused: BrowserWindow.getFocusedWindow()?.id ?? null,
          clickWindow: clickWin?.id ?? null,
          hosts: ws.map((w) => ({
            host: w.host.id,
            focusedFrameWc: frameWc(w.host),
            devToolsFocused: w.host.isDevToolsFocused(),
          })),
          firedWindowFocusedFrameWc: frameWc(fireWin.webContents),
          target: target.id,
        }),
    );
    if (trigger === "native-key") {
      if (addon.performReloadKeyEquivalent(force) !== true)
        return "native key equivalent was not handled";
    } else {
      const item = menu.items
        .find((i) => i.label === "View")
        .submenu.items.find((i) => i.label === kind);
      item.click({}, clickWin, clickWin?.webContents);
    }
    await until(
      () => recs.get(target.id).loads > before.get(target.id).loads,
      4000,
    );
    await delay(500);
    const problems = [];
    for (const [id, was] of before) {
      const now = recs.get(id);
      const want = id === target.id;
      const got = {
        reload: now.reload - was.reload,
        force: now.force - was.force,
        loads: now.loads - was.loads,
      };
      const exp = {
        reload: want && !force ? 1 : 0,
        force: want && force ? 1 : 0,
        loads: want ? 1 : 0,
      };
      if (JSON.stringify(got) !== JSON.stringify(exp)) {
        problems.push(
          `wc ${id}${want ? " (target)" : ""}: got ${JSON.stringify(got)}, expected ${JSON.stringify(exp)}`,
        );
      }
    }
    return problems.join("; ");
  } finally {
    for (const w of ws)
      [w.win, ...w.extras].forEach((x) => x.isDestroyed() || x.destroy());
  }
}

// Every case destroys its windows; without this Electron would quit between cases.
app.on("window-all-closed", () => {});

app
  .whenReady()
  .then(async () => {
    const mod = loadMenuBundle();
    console.log(
      `electron ${process.versions.electron} chrome ${process.versions.chrome} node ${process.versions.node} ` +
        `${process.platform}-${process.arch} addon=${addonArg ? addonArg.slice(8) : "none"} bundle=${bundleArg ?? "esbuild(temp)"}`,
    );
    const addon =
      addonArg && process.platform === "darwin"
        ? require(path.resolve(addonArg.slice(8)))
        : null;
    app.focus({ steal: true });
    let failures = 0;
    for (const trigger of addon
      ? ["menu-click", "native-key"]
      : ["menu-click"]) {
      for (const kind of ["Reload", "Force Reload"]) {
        for (const scenario of SCENARIOS) {
          const problem = await runCase(
            mod,
            scenario,
            kind,
            trigger,
            addon,
          ).catch((e) => `threw ${e.stack}`);
          failures += problem ? 1 : 0;
          console.log(
            `${problem ? "FAIL" : "PASS"} [${trigger}] ${kind}: ${scenario.name}${problem ? ` - ${problem}` : ""}`,
          );
        }
      }
    }
    console.log(failures ? `FAILED ${failures}` : "ALL PASSED");
    app.exit(failures ? 1 : 0);
  })
  .catch((e) => {
    console.error(e);
    app.exit(1);
  });
setTimeout(() => {
  console.error("timeout");
  app.exit(2);
}, 300000);
