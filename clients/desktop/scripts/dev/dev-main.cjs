"use strict";

const { existsSync } = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  decideOzonePlatform,
  prepareElectronBinary,
  shouldDisableChromiumSandbox,
} = require("./electron-binary.cjs");
const {
  DEV_DESKTOP_DISPLAY_NAME_ENV,
  resolveDevDesktopDisplayName,
} = require("./dev-desktop-display-name.cjs");

const workspaceRoot = path.resolve(__dirname, "..", "..");
const bundledMainPath = path.resolve(workspaceRoot, "dist", "main", "index.js");
const bundledPreloadPath = path.resolve(
  workspaceRoot,
  "dist",
  "preload",
  "index.js",
);

if (!existsSync(bundledMainPath)) {
  throw new Error(`Desktop main bundle not found: ${bundledMainPath}`);
}
if (!existsSync(bundledPreloadPath)) {
  throw new Error(`Desktop preload bundle not found: ${bundledPreloadPath}`);
}

const devDesktopDisplayName = resolveDevDesktopDisplayName(process.env);
const electronBin = prepareElectronBinary(
  require("electron"),
  workspaceRoot,
  devDesktopDisplayName,
);
const childEnv = {
  ...process.env,
  TRAYCER_DESKTOP_DEV_APP_PATH: workspaceRoot,
  TRAYCER_DESKTOP_DEV: process.env.TRAYCER_DESKTOP_DEV ?? "1",
  TRAYCER_DESKTOP_DEV_URL:
    process.env.TRAYCER_DESKTOP_DEV_URL ?? "http://localhost:5173",
};
if (devDesktopDisplayName === null) {
  delete childEnv[DEV_DESKTOP_DISPLAY_NAME_ENV];
} else {
  childEnv[DEV_DESKTOP_DISPLAY_NAME_ENV] = devDesktopDisplayName;
}

delete childEnv.ELECTRON_RUN_AS_NODE;

if (
  childEnv.ELECTRON_DISABLE_SANDBOX === undefined &&
  shouldDisableChromiumSandbox(electronBin)
) {
  childEnv.ELECTRON_DISABLE_SANDBOX = "1";
  console.log(
    "[dev-main] this kernel restricts unprivileged user namespaces and the dev electron has no setuid sandbox helper — disabling the Chromium sandbox for this dev run",
  );
}

const remoteDebuggingSetting =
  process.env.TRAYCER_DESKTOP_REMOTE_DEBUGGING_PORT ?? "9222";
const remoteDebuggingPort =
  remoteDebuggingSetting === "off" || remoteDebuggingSetting === "0"
    ? null
    : remoteDebuggingSetting;

const electronArgs = [];
// See decideOzonePlatform: Chromium's own Wayland-preferring selection hangs
// without a log line on stale/unanswering compositor sockets, so the dev
// runner picks deterministically on Linux.
const ozonePlatform = decideOzonePlatform({
  platform: process.platform,
  ozonePlatformOverride: childEnv.TRAYCER_DESKTOP_OZONE_PLATFORM,
  display: childEnv.DISPLAY,
  waylandDisplay: childEnv.WAYLAND_DISPLAY,
});
if (ozonePlatform !== null) {
  electronArgs.push(`--ozone-platform=${ozonePlatform}`);
  console.log(
    `[dev-main] using --ozone-platform=${ozonePlatform}` +
      (ozonePlatform === "headless"
        ? " (no display detected — drive the app over the CDP endpoint)"
        : ""),
  );
}
if (remoteDebuggingPort !== null) {
  electronArgs.push(`--remote-debugging-port=${remoteDebuggingPort}`);
  // Chromium rejects DevTools WebSocket upgrades whose Origin header isn't
  // allowlisted; Playwright's connectOverCDP sends one, so permit any origin.
  electronArgs.push("--remote-allow-origins=*");
  console.log(
    `[dev-main] CDP endpoint at http://127.0.0.1:${remoteDebuggingPort} - Playwright can attach`,
  );
}
electronArgs.push(workspaceRoot);

const child = spawn(electronBin, electronArgs, {
  cwd: workspaceRoot,
  env: childEnv,
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal !== null) {
    console.error(`[dev-main] Electron exited due to ${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exit(code ?? 0);
});
