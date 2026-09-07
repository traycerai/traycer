#!/usr/bin/env bun
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
const { execFileSync } = require("node:child_process");

// A dev-loop Electron under node_modules can satisfy neither on kernels that restrict unprivileged userns (the Ubuntu 24.04+ AppArmor default): the helper is never root-owned setuid.
function decideDisableChromiumSandbox({
  platform,
  effectiveUid,
  apparmorRestrictsUserns,
  usernsCloneDisabled,
  sandboxHelperStat,
}) {
  if (platform !== "linux") {
    return false;
  }
  // Chromium refuses to start its browser process as root unless the sandbox
  // is off, regardless of what the namespace/helper situation looks like -
  // and root-owned dev containers are exactly where the headless path runs.
  if (effectiveUid === 0) {
    return true;
  }
  // With unprivileged userns available the namespace sandbox works and the
  // setuid helper is never consulted.
  if (!apparmorRestrictsUserns && !usernsCloneDisabled) {
    return false;
  }
  // Userns is restricted: only a root-owned setuid helper can still sandbox.
  if (sandboxHelperStat === null) {
    return true;
  }
  const isSetuidRoot =
    sandboxHelperStat.uid === 0 && (sandboxHelperStat.mode & 0o4000) !== 0;
  return !isSetuidRoot;
}

function readProcFlag(procPath) {
  try {
    return readFileSync(procPath, "utf8").trim();
  } catch {
    return null;
  }
}

function shouldDisableChromiumSandbox(electronBinaryPath) {
  let sandboxHelperStat = null;
  try {
    const stat = statSync(
      path.join(path.dirname(electronBinaryPath), "chrome-sandbox"),
    );
    sandboxHelperStat = { uid: stat.uid, mode: stat.mode };
  } catch {
    // Missing helper: same outcome as a non-setuid one.
  }
  return decideDisableChromiumSandbox({
    platform: process.platform,
    // `geteuid` is POSIX-only; the platform gate above makes this safe.
    effectiveUid:
      typeof process.geteuid === "function" ? process.geteuid() : -1,
    // Ubuntu 24.04+ ships this AppArmor knob defaulted on; processes without
    // a profile granting userns (any node_modules binary) are denied.
    apparmorRestrictsUserns:
      readProcFlag("/proc/sys/kernel/apparmor_restrict_unprivileged_userns") ===
      "1",
    // The older Debian-lineage kernel knob for the same restriction.
    usernsCloneDisabled:
      readProcFlag("/proc/sys/kernel/unprivileged_userns_clone") === "0",
    sandboxHelperStat,
  });
}

// The Ozone platforms an Electron build accepts for `--ozone-platform`.
const OZONE_PLATFORMS = ["auto", "headless", "wayland", "x11"];

function decideOzonePlatform({
  platform,
  ozonePlatformOverride,
  display,
  waylandDisplay,
}) {
  if (platform !== "linux") {
    return null;
  }
  if (
    typeof ozonePlatformOverride === "string" &&
    ozonePlatformOverride.length > 0
  ) {
    const accepted = OZONE_PLATFORMS.find(
      (candidate) => candidate === ozonePlatformOverride,
    );
    if (accepted === undefined) {
      throw new Error(
        `TRAYCER_DESKTOP_OZONE_PLATFORM must be one of: ${OZONE_PLATFORMS.join(", ")}`,
      );
    }
    return accepted;
  }
  if (typeof display === "string" && display.length > 0) {
    return "x11";
  }
  if (typeof waylandDisplay === "string" && waylandDisplay.length > 0) {
    return null;
  }
  return "headless";
}

function prepareElectronBinary(
  defaultElectronBinary,
  workspaceRoot,
  devDesktopDisplayName,
) {
  if (process.platform !== "darwin") {
    return defaultElectronBinary;
  }

  return prepareMacDevBundle(
    defaultElectronBinary,
    workspaceRoot,
    devDesktopDisplayName,
  );
}

function prepareMacDevBundle(
  defaultElectronBinary,
  workspaceRoot,
  devDesktopDisplayName,
) {
  const checkoutTag = createHash("sha1")
    .update(workspaceRoot)
    .digest("hex")
    .slice(0, 8);
  const devBundleId = `ai.traycer.desktop.dev.${checkoutTag}`;
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
  const bundleDisplayName = devDesktopDisplayName ?? "Traycer";
  const nextState = createDevBundleState({
    devBundleId,
    bundleDisplayName,
    electronVersion: require("electron/package.json").version,
    sourceInfoPlistMtimeMs: statSync(sourceInfoPlistPath).mtimeMs,
    sourceExecutableMtimeMs: statSync(sourceExecutablePath).mtimeMs,
    iconMtimeMs: statSync(sourceIconPath).mtimeMs,
  });

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
  replacePlistString(plistPath, "CFBundleDisplayName", bundleDisplayName);
  replacePlistString(plistPath, "CFBundleIconFile", "traycer.icns");
  replacePlistString(plistPath, "CFBundleIdentifier", devBundleId);
  replacePlistString(plistPath, "CFBundleName", bundleDisplayName);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", devAppPath]);

  writeFileSync(metadataPath, nextState);
  return devExecutablePath;
}

function createDevBundleState({
  devBundleId,
  bundleDisplayName,
  electronVersion,
  sourceInfoPlistMtimeMs,
  sourceExecutableMtimeMs,
  iconMtimeMs,
}) {
  return JSON.stringify(
    {
      bundleLayoutVersion: 5,
      devBundleId,
      bundleDisplayName,
      electronVersion,
      sourceInfoPlistMtimeMs,
      sourceExecutableMtimeMs,
      iconMtimeMs,
    },
    null,
    2,
  );
}

function replacePlistString(plistPath, key, value) {
  execFileSync("plutil", ["-replace", key, "-string", value, plistPath]);
}

module.exports = {
  createDevBundleState,
  decideDisableChromiumSandbox,
  decideOzonePlatform,
  prepareElectronBinary,
  shouldDisableChromiumSandbox,
};
