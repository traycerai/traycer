/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

// Reads the small client projection emitted by the internal release-target
// descriptor. This is intentionally a shape check, not an attestation layer:
// the payload is produced from reviewed repository bytes by the same release
// workflow that consumes it.
const fs = require("node:fs");
const path = require("node:path");

const KNOWN_TARGETS = ["production", "staging"];
// Scalar keys must be non-empty strings; structured keys are checked by shape
// below. Keeping the two sets apart is what makes a `null` scalar fail here
// instead of being packaged as `appId: null` or `schemes: [null]`.
const COMMON_SCALAR_KEYS = [
  "target",
  "environment",
  "sentryEnvironment",
  "cliFeedTag",
  "hostDiscoveryTag",
  "credentialEnvironmentVariable",
];
const COMMON_STRUCTURED_KEYS = [
  "cloud",
  "credentialSources",
  "authorizedOrigins",
];
const COMPONENT_KEYS = {
  cli: {
    scalar: [
      "cliInstallRoot",
      "hostInstallRoot",
      "serviceLabelId",
      "windowsTaskName",
    ],
    structured: [],
  },
  desktop: {
    scalar: [
      "appId",
      "productName",
      "protocolScheme",
      "releaseChannel",
      "updaterPackageName",
      "updaterCacheDirName",
      "updaterChannel",
      // The NSIS uninstaller removes the CLI-installed host autostart, so the
      // desktop stamp carries the CLI's install identity too.
      "cliInstallRoot",
      "windowsTaskName",
    ],
    structured: ["mac", "windows", "linux", "updaterChannelFiles"],
  },
};

class ClientTargetStampError extends Error {
  constructor(message) {
    super(message);
    this.name = "ClientTargetStampError";
  }
}

function requireRecord(value, where) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ClientTargetStampError(`${where} must be an object`);
  }
  return value;
}

function requireKeys(value, keys, where) {
  const record = requireRecord(value, where);
  for (const key of keys) {
    if (!(key in record)) {
      throw new ClientTargetStampError(`${where} is missing ${key}`);
    }
  }
  return record;
}

function requireString(value, where) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ClientTargetStampError(`${where} must be a non-empty string`);
  }
}

/**
 * Every named key must be present AND hold a non-empty string.
 *
 * `requireKeys` checks presence only, which is not enough for the NESTED
 * records: the stampers interpolate these leaves straight into `config.ts`, so
 * a `cloud.authnApiUrl: null` is baked as the literal string `"null"` and the
 * release ships with an unusable authentication endpoint that nothing fails on
 * until a user tries to sign in.
 */
function requireScalarKeys(value, keys, where) {
  const record = requireKeys(value, keys, where);
  for (const key of keys) {
    requireString(record[key], `${where}.${key}`);
  }
  return record;
}

/** A non-empty array whose every entry is a non-empty string. */
function requireStringArray(value, where) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ClientTargetStampError(`${where} must be a non-empty array`);
  }
  value.forEach((entry, index) => requireString(entry, `${where}[${index}]`));
}

function readClientTargetStamp(inputPath, expectedTarget, component) {
  const componentKeys = COMPONENT_KEYS[component];
  if (componentKeys === undefined) {
    throw new ClientTargetStampError(`unknown client component ${component}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  } catch (error) {
    throw new ClientTargetStampError(
      `cannot read target stamp ${inputPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const stamp = requireKeys(
    parsed,
    [
      ...COMMON_SCALAR_KEYS,
      ...COMMON_STRUCTURED_KEYS,
      ...componentKeys.scalar,
      ...componentKeys.structured,
    ],
    "client target stamp",
  );
  for (const key of [...COMMON_SCALAR_KEYS, ...componentKeys.scalar]) {
    requireString(stamp[key], `client target stamp.${key}`);
  }
  for (const key of ["credentialSources", "authorizedOrigins"]) {
    requireStringArray(stamp[key], `client target stamp.${key}`);
  }
  if (
    !KNOWN_TARGETS.includes(stamp.target) ||
    stamp.target !== expectedTarget
  ) {
    throw new ClientTargetStampError(
      `client target stamp target ${JSON.stringify(stamp.target)} does not match ${JSON.stringify(expectedTarget)}`,
    );
  }
  if (stamp.environment !== stamp.target) {
    throw new ClientTargetStampError(
      "client target stamp environment must equal target",
    );
  }
  requireScalarKeys(
    stamp.cloud,
    ["traycerServerBaseUrl", "authnApiUrl", "cloudUiBaseUrl", "relayAttachUrl"],
    "client target stamp.cloud",
  );
  if (component === "desktop") {
    requireStringArray(
      stamp.updaterChannelFiles,
      "client target stamp.updaterChannelFiles",
    );
    requireScalarKeys(
      stamp.mac,
      ["bundleName", "helperBundleId", "launchAgentLabel"],
      "client target stamp.mac",
    );
    requireScalarKeys(
      stamp.windows,
      ["appUserModelId", "executableName", "installerDisplayName"],
      "client target stamp.windows",
    );
    const linux = requireKeys(
      stamp.linux,
      ["deb", "rpm", "executableName", "desktopEntryName"],
      "client target stamp.linux",
    );
    requireString(
      linux.executableName,
      "client target stamp.linux.executableName",
    );
    requireString(
      linux.desktopEntryName,
      "client target stamp.linux.desktopEntryName",
    );
    requireScalarKeys(
      linux.deb,
      ["packageName"],
      "client target stamp.linux.deb",
    );
    requireScalarKeys(
      linux.rpm,
      ["packageName"],
      "client target stamp.linux.rpm",
    );
  }
  return stamp;
}

function targetInputFromArg(argv, expectedTarget, required, component) {
  const arg = argv.find((value) => value.startsWith("--target-input="));
  if (arg === undefined) {
    if (required) {
      throw new ClientTargetStampError(
        `--target-input=<path> is required for ${expectedTarget} release builds`,
      );
    }
    return null;
  }
  const inputPath = arg.slice("--target-input=".length);
  if (inputPath.length === 0) {
    throw new ClientTargetStampError("--target-input requires a path");
  }
  return readClientTargetStamp(
    path.resolve(inputPath),
    expectedTarget,
    component,
  );
}

/**
 * The publish/update coordinate a build is stamped with, resolved ONCE so the
 * three stampers cannot disagree about what a staging build is allowed to
 * point at.
 *
 * Three ways this refuses, and each one is a shipped-and-broken release
 * otherwise:
 *
 *   - ABSENT on staging. A staging client stamps staging-only feed tags; against
 *     the production repository every discovery lookup 404s at runtime.
 *   - THE PRODUCTION COORDINATE on staging, spelled explicitly. Rejecting only
 *     the absent case leaves the misconfiguration that actually reaches the
 *     public repository - a staging build resolving updates from, or publishing
 *     into, production. Compared case-insensitively, because GitHub treats
 *     `owner/repo` that way and `TraycerAI/Traycer` is the same destination.
 *   - MALFORMED, on any target. A full clone URL or an `owner/repo/extra` typo
 *     is baked as-is; the CLI then builds invalid manifest URLs and a null
 *     authentication policy, and the failure only surfaces after the release
 *     has shipped. Only the desktop packaging path validated the shape before.
 *
 * Returns a result rather than throwing so each caller can phrase its own exit;
 * `--restore` paths need no coordinate at all and never call this.
 */
const PRODUCTION_RELEASE_REPO = "traycerai/traycer";
const REPO_COORDINATE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function resolveReleaseRepoForTarget(raw, releaseTarget) {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (trimmed.length === 0) {
    if (releaseTarget === "staging") {
      return {
        ok: false,
        reason:
          "TRAYCER_RELEASE_REPO (or RELEASE_REPO) is required for a staging build; the production repository is never a staging destination.",
      };
    }
    return { ok: true, repo: PRODUCTION_RELEASE_REPO };
  }
  if (!REPO_COORDINATE.test(trimmed)) {
    return {
      ok: false,
      reason: `TRAYCER_RELEASE_REPO (or RELEASE_REPO) must be an owner/repo coordinate, got ${JSON.stringify(trimmed)}.`,
    };
  }
  if (
    releaseTarget === "staging" &&
    trimmed.toLowerCase() === PRODUCTION_RELEASE_REPO
  ) {
    return {
      ok: false,
      reason: `TRAYCER_RELEASE_REPO (or RELEASE_REPO) resolved to the production repository ${JSON.stringify(trimmed)}, which is never a staging destination.`,
    };
  }
  return { ok: true, repo: trimmed };
}

module.exports = {
  ClientTargetStampError,
  PRODUCTION_RELEASE_REPO,
  readClientTargetStamp,
  resolveReleaseRepoForTarget,
  targetInputFromArg,
};
