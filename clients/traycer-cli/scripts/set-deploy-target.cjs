#!/usr/bin/env bun
/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

// Stamp the release-time values onto `clients/traycer-cli/src/config.ts` for a production build, then `--restore` back to the committed source defaults.
// See ../../scripts/rewrite-config-target.cjs.
const DEFAULT_RELEASE_REPO = "traycerai/traycer";

const path = require("node:path");
const {
  runConfigTargetCli,
} = require("../../scripts/rewrite-config-target.cjs");

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
  target === "production" &&
  supportedHostVersion === null
) {
  console.error(
    "[set-deploy-target] TRAYCER_SUPPORTED_HOST_VERSION or --supported-host-version=<version> is required for production CLI builds (the released CLI must install a pinned host version by default). Pass --allow-unpinned-host only for local dogfood installs that side-load an unsigned host.",
  );
  process.exit(2);
}

runConfigTargetCli({
  sourcePath: path.resolve(__dirname, "..", "src", "config.ts"),
  stringFields: {
    releaseRepo: {
      dev: DEFAULT_RELEASE_REPO,
      production: releaseRepo,
    },
  },
  nullableStringFields: {
    supportedHostVersion: {
      dev: null,
      production: supportedHostVersion,
    },
  },
});
