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

// `build:main` (esbuild) produces these two self-contained CommonJS bundles
// before this script is invoked. Both dev and production now load the same
// bundles - dropping the prior tsx-shim path means we lose hot-reload for
// the main process, but main edits already required an Electron restart
// to take effect, and the renderer keeps Vite HMR independently.
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
  // This is the dev runner, so it always loads the renderer from the Vite dev
  // server. Default these here rather than via an inline `VAR=1 ... bun run`
  // prefix in the package.json `dev` script - that POSIX shell syntax isn't
  // understood by cmd.exe, so on Windows it failed with "'TRAYCER_DESKTOP_DEV'
  // is not recognized". Any caller-provided value still wins.
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

// See shouldDisableChromiumSandbox: on Linux kernels that restrict
// unprivileged user namespaces, an un-setuid dev Electron aborts at launch
// rather than run unsandboxed. Scoped to this dev child (trusted local code);
// a caller-provided value still wins.
if (
  childEnv.ELECTRON_DISABLE_SANDBOX === undefined &&
  shouldDisableChromiumSandbox(electronBin)
) {
  childEnv.ELECTRON_DISABLE_SANDBOX = "1";
  console.log(
    "[dev-main] this kernel restricts unprivileged user namespaces and the dev electron has no setuid sandbox helper — disabling the Chromium sandbox for this dev run",
  );
}

// Expose a Chromium remote-debugging (CDP) endpoint on loopback so browser
// automation (the Playwright MCP) can attach to the live app window. This is
// the dev-only runner and the port stays bound to 127.0.0.1, so the open
// endpoint is a local affordance. On by default so `make dev-desktop` is
// drivable without remembering a flag; set the port to "off" (or "0") to
// disable it, or to another value to avoid a clash when two desktop slots run
// at once. Kept at a fixed default because the Playwright MCP's static
// `--cdp-endpoint` can't chase a per-slot port.
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
  electronOzoneHint: childEnv.ELECTRON_OZONE_PLATFORM_HINT,
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
