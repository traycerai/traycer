"use strict";

const {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { execFileSync, spawn } = require("node:child_process");

const workspaceRoot = path.resolve(__dirname, "..", "..");

// Per-checkout-unique dev bundle identity. Two checkouts (or git worktrees)
// previously code-signed their dev `Traycer.app` under the same hardcoded
// `ai.traycer.desktop.dev` id. macOS LaunchServices then resolved that shared
// id to whichever copy it preferred and launched it argument-free on any
// activation (protocol open, notification, reopen), so Electron fell through
// to its `default_app.asar` welcome window instead of loading the source-tree
// app. Deriving the id from the absolute checkout path keeps each checkout a
// distinct LaunchServices app, so activations always route to the running
// instance that was started with the workspace path argument. Nothing reads
// this id back (runtime uses `ai.traycer.desktop`; staging/prod set their own
// appId via electron-builder), so the suffix is free to vary.
const CHECKOUT_TAG = createHash("sha1")
  .update(workspaceRoot)
  .digest("hex")
  .slice(0, 8);
const DEV_BUNDLE_ID = `ai.traycer.desktop.dev.${CHECKOUT_TAG}`;
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

const electronBin = prepareElectronBinary(require("electron"));
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

function prepareElectronBinary(defaultElectronBinary) {
  if (process.platform !== "darwin") {
    return defaultElectronBinary;
  }

  return prepareMacDevBundle(defaultElectronBinary);
}

function prepareMacDevBundle(defaultElectronBinary) {
  const sourceAppPath = path.resolve(defaultElectronBinary, "..", "..", "..");
  const sourceInfoPlistPath = path.join(
    sourceAppPath,
    "Contents",
    "Info.plist",
  );
  const sourceExecutablePath = path.join(
    sourceAppPath,
    "Contents",
    "MacOS",
    "Electron",
  );
  const sourceIconPath = path.resolve(
    workspaceRoot,
    "resources",
    "bundle",
    "icon.icns",
  );
  const outputRoot = path.resolve(workspaceRoot, "dist", "dev-macos");
  const devAppPath = path.join(outputRoot, "Traycer.app");
  const devExecutablePath = path.join(
    devAppPath,
    "Contents",
    "MacOS",
    "Electron",
  );
  const metadataPath = path.join(outputRoot, "bundle-state.json");
  const nextState = JSON.stringify(
    {
      bundleLayoutVersion: 4,
      devBundleId: DEV_BUNDLE_ID,
      electronVersion: require("electron/package.json").version,
      sourceInfoPlistMtimeMs: statSync(sourceInfoPlistPath).mtimeMs,
      sourceExecutableMtimeMs: statSync(sourceExecutablePath).mtimeMs,
      iconMtimeMs: statSync(sourceIconPath).mtimeMs,
    },
    null,
    2,
  );

  if (
    existsSync(devExecutablePath) &&
    existsSync(metadataPath) &&
    readFileSync(metadataPath, "utf8") === nextState
  ) {
    return devExecutablePath;
  }

  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(outputRoot, { recursive: true });
  execFileSync("ditto", [sourceAppPath, devAppPath]);

  copyFileSync(
    sourceIconPath,
    path.join(devAppPath, "Contents", "Resources", "traycer.icns"),
  );

  const plistPath = path.join(devAppPath, "Contents", "Info.plist");
  replacePlistString(plistPath, "CFBundleDisplayName", "Traycer");
  replacePlistString(plistPath, "CFBundleIconFile", "traycer.icns");
  replacePlistString(plistPath, "CFBundleIdentifier", DEV_BUNDLE_ID);
  replacePlistString(plistPath, "CFBundleName", "Traycer");
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", devAppPath]);

  writeFileSync(metadataPath, nextState);
  return devExecutablePath;
}

function replacePlistString(plistPath, key, value) {
  execFileSync("plutil", ["-replace", key, "-string", value, plistPath]);
}
