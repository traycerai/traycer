#!/usr/bin/env bun
/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

// Stamp the release-time values onto `clients/desktop/src/config.ts` for a
// production or staging build, then `--restore` back to the source defaults.
// See ../../scripts/rewrite-config-target.cjs.
//
// The OSS build commits its production endpoints directly in source, so this
// script stamps `environment`, `version`, the per-environment app identity
// (app name / OAuth scheme / AppUserModelId), and the Sentry DSNs - the
// per-build crash-reporting secrets sourced from the CI env
// (TRAYCER_DESKTOP_SENTRY_DSN) so they never live in committed source (empty in
// source / on --restore).

const fs = require("node:fs");
const path = require("node:path");
const {
  runConfigTargetCli,
} = require("../../scripts/rewrite-config-target.cjs");
const {
  ClientTargetStampError,
  targetInputFromArg,
} = require("../../scripts/release-target-stamp.cjs");

const sentryDsn = process.env.TRAYCER_DESKTOP_SENTRY_DSN ?? "";
const sentryRendererDsn = process.env.TRAYCER_DESKTOP_SENTRY_RENDERER_DSN ?? "";
const targetArg = process.argv.find((arg) => arg.startsWith("--target="));
const target =
  targetArg === undefined ? null : targetArg.slice("--target=".length);
const stampPath = path.resolve(__dirname, "..", ".release-target-stamp.json");
const generatedNsisIncludePath = path.resolve(
  __dirname,
  "..",
  "resources",
  "bundle",
  ".release-target-uninstall-host-autostart.nsh",
);
function releaseRepoFromEnv() {
  const raw =
    process.env.TRAYCER_RELEASE_REPO ?? process.env.RELEASE_REPO ?? "";
  const trimmed = raw.trim();
  return trimmed.length === 0 ? "traycerai/traycer" : trimmed;
}

let targetInput = null;
try {
  if (!process.argv.includes("--restore") && target !== null) {
    targetInput = targetInputFromArg(
      process.argv,
      target,
      target === "staging",
      "desktop",
    );
  }
} catch (error) {
  console.error(
    `[set-deploy-target] ${error instanceof ClientTargetStampError ? error.message : String(error)}`,
  );
  process.exit(2);
}

// The stamp file is what `release-target-electron-builder.cjs` and the
// `afterPack` hook read to package under the target's identity; `--restore`
// removes it together with the generated NSIS include so a later local
// `bun run package` builds the unstamped dev app again.
if (process.argv.includes("--restore")) {
  fs.rmSync(stampPath, { force: true });
  fs.rmSync(generatedNsisIncludePath, { force: true });
} else if (targetInput !== null) {
  fs.writeFileSync(stampPath, `${JSON.stringify(targetInput)}\n`, "utf8");
}

const production = {
  cloud: {
    authnApiUrl: "https://authn.traycer.ai",
    cloudUiBaseUrl: "https://platform.traycer.ai",
    relayAttachUrl: "wss://relay.traycer.ai/attach",
  },
  appId: "ai.traycer.desktop",
  productName: "Traycer",
  protocolScheme: "traycer",
  releaseChannel: "stable",
};

runConfigTargetCli({
  sourcePath: path.resolve(__dirname, "..", "src", "config.ts"),
  stringFields: {
    // Per-environment app identity (drives the userData dir + single-instance
    // lock, the OAuth scheme, and the Windows AppUserModelId). Source holds the
    // dev values; a production build stamps the shipped identity.
    appName: {
      dev: "Traycer Dev",
      staging: targetInput === null ? "" : targetInput.productName,
      production: production.productName,
    },
    protocolScheme: {
      dev: "traycer-dev",
      staging: targetInput === null ? "" : targetInput.protocolScheme,
      production: production.protocolScheme,
    },
    appId: {
      dev: "ai.traycer.desktop",
      staging: targetInput === null ? "" : targetInput.appId,
      production: production.appId,
    },
    authnBaseUrl: {
      dev: production.cloud.authnApiUrl,
      staging: targetInput === null ? "" : targetInput.cloud.authnApiUrl,
      production: production.cloud.authnApiUrl,
    },
    cloudUiBaseUrl: {
      dev: production.cloud.cloudUiBaseUrl,
      staging: targetInput === null ? "" : targetInput.cloud.cloudUiBaseUrl,
      production: production.cloud.cloudUiBaseUrl,
    },
    relayBaseUrl: {
      dev: production.cloud.relayAttachUrl,
      staging: targetInput === null ? "" : targetInput.cloud.relayAttachUrl,
      production: production.cloud.relayAttachUrl,
    },
    releaseRepo: {
      dev: "traycerai/traycer",
      staging: releaseRepoFromEnv(),
      production: releaseRepoFromEnv(),
    },
    releaseChannel: {
      dev: "dev",
      staging: targetInput === null ? "" : targetInput.releaseChannel,
      production: production.releaseChannel,
    },
    sentryDsn: {
      dev: "",
      staging: sentryDsn,
      production: sentryDsn,
    },
    sentryRendererDsn: {
      dev: "",
      staging: sentryRendererDsn,
      production: sentryRendererDsn,
    },
  },
});
