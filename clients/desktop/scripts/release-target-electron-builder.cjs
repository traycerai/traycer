/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

// electron-builder config for a descriptor-stamped release cell. The normal
// package.json remains the production-compatible local default.
const fs = require("node:fs");
const path = require("node:path");
const {
  readClientTargetStamp,
  resolveReleaseRepoForTarget,
} = require("../../scripts/release-target-stamp.cjs");

const projectDir = path.resolve(__dirname, "..");
const stampPath = path.join(projectDir, ".release-target-stamp.json");
const generatedNsisIncludePath = path.join(
  projectDir,
  "resources",
  "bundle",
  ".release-target-uninstall-host-autostart.nsh",
);

const configSource = fs.readFileSync(
  path.join(projectDir, "src", "config.ts"),
  "utf8",
);
const environmentMatch = /environment:\s*"(production|staging)"/.exec(
  configSource,
);
if (environmentMatch === null || !fs.existsSync(stampPath)) {
  throw new Error(
    "release-target-electron-builder requires a release-stamped config and .release-target-stamp.json",
  );
}

const target = readClientTargetStamp(stampPath, environmentMatch[1], "desktop");
const pkg = JSON.parse(
  fs.readFileSync(path.join(projectDir, "package.json"), "utf8"),
);
const base = pkg.build ?? {};
// Absent, malformed, or the production coordinate on staging - all three
// refused by the one resolver the CLI and desktop stampers also use, so the
// packaging path and the config-stamping path cannot disagree about what a
// staging build may point at.
const releaseRepoResult = resolveReleaseRepoForTarget(
  process.env.TRAYCER_RELEASE_REPO ?? process.env.RELEASE_REPO,
  target.target,
);
if (!releaseRepoResult.ok) {
  throw new Error(releaseRepoResult.reason);
}
const releaseRepo = releaseRepoResult.repo;
const [owner, repo] = releaseRepo.split("/");

function windowsLauncherPath(cliInstallRoot) {
  return `$PROFILE\\${cliInstallRoot.slice(2).replaceAll("/", "\\")}\\host-start-hidden.vbs`;
}

function windowsTaskFolder(taskName) {
  const match = /^\\([^\\]+)\\[^\\]+$/u.exec(taskName);
  if (match === null) {
    throw new Error("client target windowsTaskName must use one task folder");
  }
  return match[1];
}

// The uninstaller removes the host autostart the CLI registered, so it takes
// the CLI's install identity from the same stamp rather than a literal that
// could drift from the descriptor.
function writeTargetNsisInclude() {
  const contents = [
    `!define TRAYCER_WINDOWS_TASK_NAME "${target.windowsTaskName}"`,
    `!define TRAYCER_WINDOWS_TASK_FOLDER "${windowsTaskFolder(target.windowsTaskName)}"`,
    `!define TRAYCER_HOST_LAUNCHER "${windowsLauncherPath(target.cliInstallRoot)}"`,
    '!include "uninstall-host-autostart.nsh"',
    "",
  ].join("\n");
  fs.writeFileSync(generatedNsisIncludePath, contents, "utf8");
}

writeTargetNsisInclude();

const config = {
  ...base,
  appId: target.appId,
  productName: target.productName,
  protocols: [{ name: target.productName, schemes: [target.protocolScheme] }],
  mac: {
    ...base.mac,
    executableName: target.mac.bundleName,
  },
  win: {
    ...base.win,
    executableName: target.windows.executableName,
  },
  linux: {
    ...base.linux,
    executableName: target.linux.executableName,
  },
  // Keep the historical production package identities exactly: Debian is
  // lowercase `traycer`, while the RPM header is case-sensitive `Traycer`.
  deb: {
    ...base.deb,
    packageName: target.linux.deb.packageName,
  },
  rpm: {
    ...base.rpm,
    packageName: target.linux.rpm.packageName,
  },
  ...(target.target === "staging"
    ? {
        // app-update.yml derives updaterCacheDirName from package metadata.
        extraMetadata: {
          ...base.extraMetadata,
          name: target.updaterPackageName,
        },
      }
    : {}),
  nsis: {
    ...base.nsis,
    include: ".release-target-uninstall-host-autostart.nsh",
  },
  publish: [
    {
      provider: "github",
      owner,
      repo,
      channel: target.updaterChannel,
    },
  ],
};

module.exports = config;
