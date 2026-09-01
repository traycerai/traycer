#!/usr/bin/env bun
/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

// Stamp the release-time values onto `clients/traycer-cli/src/config.ts` for a
// production or staging build, then `--restore` back to the source defaults.
// See ../../scripts/rewrite-config-target.cjs.
//
// The OSS build commits its production endpoints AND the host trust root
// (`hostTrustedPubkeys`) directly in source, so this script no longer rewrites
// them - `--restore` leaves them untouched. It only stamps the values that
// genuinely vary per release: `environment`, `version`, `supportedHostVersion`
// (the exact host this CLI installs by default), and `releaseRepo` (so a
// forked/relocated build fetches from the repo it publishes to, via
// RELEASE_REPO).
const DEFAULT_RELEASE_REPO = "traycerai/traycer";

const path = require("node:path");
const {
  runConfigTargetCli,
} = require("../../scripts/rewrite-config-target.cjs");
const {
  ClientTargetStampError,
  targetInputFromArg,
} = require("../../scripts/release-target-stamp.cjs");

function parseSupportedHostVersion(argv, raw) {
  const arg = argv.find((item) => item.startsWith("--supported-host-version="));
  const value =
    arg === undefined ? raw : arg.slice("--supported-host-version=".length);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function parseReleaseRepo(raw) {
  if (typeof raw !== "string") return DEFAULT_RELEASE_REPO;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? DEFAULT_RELEASE_REPO : trimmed;
}

const supportedHostVersion = parseSupportedHostVersion(
  process.argv,
  process.env.TRAYCER_SUPPORTED_HOST_VERSION,
);
const releaseRepo = parseReleaseRepo(
  process.env.TRAYCER_RELEASE_REPO ?? process.env.RELEASE_REPO,
);

const allowUnpinnedHost = process.argv.includes("--allow-unpinned-host");
const targetArg = process.argv.find((arg) => arg.startsWith("--target="));
const target =
  targetArg === undefined ? null : targetArg.slice("--target=".length);

if (
  !allowUnpinnedHost &&
  (target === "production" || target === "staging") &&
  supportedHostVersion === null
) {
  console.error(
    "[set-deploy-target] TRAYCER_SUPPORTED_HOST_VERSION or --supported-host-version=<version> is required for released CLI builds. Pass --allow-unpinned-host only for local dogfood installs that side-load an unsigned host.",
  );
  process.exit(2);
}

let targetInput = null;
try {
  if (!process.argv.includes("--restore") && target !== null) {
    targetInput = targetInputFromArg(
      process.argv,
      target,
      target === "staging",
      "cli",
    );
  }
} catch (error) {
  console.error(
    `[set-deploy-target] ${error instanceof ClientTargetStampError ? error.message : String(error)}`,
  );
  process.exit(2);
}

const production = {
  cloud: {
    authnApiUrl: "https://authn.traycer.ai",
    cloudUiBaseUrl: "https://platform.traycer.ai",
  },
  hostDiscoveryTag: "released-host-versions",
  cliFeedTag: "cli-manifest",
};

runConfigTargetCli({
  sourcePath: path.resolve(__dirname, "..", "src", "config.ts"),
  stringFields: {
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
    releaseRepo: {
      dev: DEFAULT_RELEASE_REPO,
      staging: releaseRepo,
      production: releaseRepo,
    },
    hostDiscoveryTag: {
      dev: production.hostDiscoveryTag,
      staging: targetInput === null ? "" : targetInput.hostDiscoveryTag,
      production: production.hostDiscoveryTag,
    },
    cliFeedTag: {
      dev: production.cliFeedTag,
      staging: targetInput === null ? "" : targetInput.cliFeedTag,
      production: production.cliFeedTag,
    },
  },
  nullableStringFields: {
    supportedHostVersion: {
      dev: null,
      staging: supportedHostVersion,
      production: supportedHostVersion,
    },
  },
});
