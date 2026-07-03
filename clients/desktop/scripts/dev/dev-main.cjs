"use strict";

const { existsSync } = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { prepareElectronBinary } = require("./electron-binary.cjs");

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

const electronBin = prepareElectronBinary(require("electron"), workspaceRoot);
const childEnv = {
  ...process.env,
  TRAYCER_DESKTOP_DEV_APP_PATH: workspaceRoot,
};

delete childEnv.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBin, [workspaceRoot], {
  cwd: workspaceRoot,
  env: childEnv,
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
