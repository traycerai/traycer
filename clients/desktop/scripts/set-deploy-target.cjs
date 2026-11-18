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
  resolveReleaseRepoForTarget,
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
// `--restore` puts the committed config back and needs no coordinate, so it
// must not be blocked by a resolution the restore does not use.
const releaseRepoResult = resolveReleaseRepoForTarget(
  process.env.TRAYCER_RELEASE_REPO ?? process.env.RELEASE_REPO,
  target,
);
if (!releaseRepoResult.ok && !process.argv.includes("--restore")) {
  console.error(`[set-deploy-target] ${releaseRepoResult.reason}`);
  process.exit(2);
}
const releaseRepo = releaseRepoResult.ok ? releaseRepoResult.repo : null;

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

// The staging IAP service-account key, packaged under `resources/keys/` by
// `release-target-electron-builder.cjs` for a staging build only; the main
// process mints its `Proxy-Authorization` token from it
// (`src/electron-main/auth/iap-proxy-token.ts`, which looks for this name).
const IAP_KEY_FILENAME = "iap-service-account.json";
const iapKeyPath = path.resolve(
  __dirname,
  "..",
  "resources",
  "keys",
  IAP_KEY_FILENAME,
);
const iapAudience =
  targetInput === null ? "" : (targetInput.cloud.iapAudience ?? "");

// Written from `TRAYCER_IAP_SA_KEY` (the service-account JSON) and never
// committed, as the host build writes its own. A staging target that names an
// IAP audience fails here without the key rather than shipping a desktop whose
// every sandbox call IAP refuses. The value is a secret: no message here
// prints it or the parser's error, which quotes the input.
function writeStagingIapKey() {
  const raw = process.env.TRAYCER_IAP_SA_KEY;
  if (raw === undefined || raw.trim().length === 0) {
    console.error(
      "[set-deploy-target] this staging target is behind IAP and needs the IAP service-account key in TRAYCER_IAP_SA_KEY. Never commit the key.",
    );
    process.exit(2);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error(
      `[set-deploy-target] TRAYCER_IAP_SA_KEY is not valid JSON (length ${raw.length}); expected a GCP service-account key.`,
    );
    process.exit(2);
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    typeof parsed.private_key !== "string" ||
    typeof parsed.client_email !== "string"
  ) {
    console.error(
      "[set-deploy-target] TRAYCER_IAP_SA_KEY parsed as JSON but is not a service-account key: it needs private_key and client_email.",
    );
    process.exit(2);
  }
  fs.mkdirSync(path.dirname(iapKeyPath), { recursive: true });
  // World-readable on purpose: electron-builder keeps this mode in the copy
  // it packages, and a deb or rpm installs that copy as root, so 0600 would
  // leave the app's own user unable to read it and every staging sandbox call
  // refused. File mode is not what keeps the key; packaging it only into a
  // staging build is.
  fs.writeFileSync(iapKeyPath, raw, { mode: 0o644 });
  // The creation mode is masked by the umask; set it outright.
  fs.chmodSync(iapKeyPath, 0o644);
}

// The stamp file is what `release-target-electron-builder.cjs` and the
// `afterPack` hook read to package under the target's identity; `--restore`
// removes it together with the generated NSIS include and the IAP key so a
// later local `bun run package` builds the unstamped dev app again. Every
// stamp removes a key a previous one left, so only a staging stamp with an
// IAP audience leaves one behind.
fs.rmSync(iapKeyPath, { force: true });
if (process.argv.includes("--restore")) {
  fs.rmSync(stampPath, { force: true });
  fs.rmSync(generatedNsisIncludePath, { force: true });
} else if (targetInput !== null) {
  fs.writeFileSync(stampPath, `${JSON.stringify(targetInput)}\n`, "utf8");
  if (target === "staging" && iapAudience.length > 0) {
    writeStagingIapKey();
  }
}

const production = {
  cloud: {
    authnApiUrl: "https://authn.traycer.ai",
    traycerServerBaseUrl: "https://server.traycer.ai",
    cloudUiBaseUrl: "https://traycer.ai",
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
    serverBaseUrl: {
      dev: production.cloud.traycerServerBaseUrl,
      staging:
        targetInput === null ? "" : targetInput.cloud.traycerServerBaseUrl,
      production: production.cloud.traycerServerBaseUrl,
    },
    // Empty for a target not behind IAP; see `config.ts`.
    iapAudience: {
      dev: "",
      staging: iapAudience,
      production: "",
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
    // Empty for a target with no pool (production, until its address is
    // published), which synthesizes no pool entry.
    poolBaseUrl: {
      dev: "",
      staging: targetInput === null ? "" : (targetInput.cloud.poolUrl ?? ""),
      production: "",
    },
    releaseRepo: {
      dev: "traycerai/traycer",
      staging: releaseRepo ?? "",
      production: releaseRepo ?? "traycerai/traycer",
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
