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

module.exports = { createDevBundleState, prepareElectronBinary };
