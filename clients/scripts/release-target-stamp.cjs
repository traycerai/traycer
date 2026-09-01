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
    if (!Array.isArray(stamp[key])) {
      throw new ClientTargetStampError(
        `client target stamp.${key} must be an array`,
      );
    }
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
  requireKeys(
    stamp.cloud,
    ["traycerServerBaseUrl", "authnApiUrl", "cloudUiBaseUrl", "relayAttachUrl"],
    "client target stamp.cloud",
  );
  if (component === "desktop") {
    if (!Array.isArray(stamp.updaterChannelFiles)) {
      throw new ClientTargetStampError(
        "client target stamp.updaterChannelFiles must be an array",
      );
    }
    requireKeys(
      stamp.mac,
      ["bundleName", "helperBundleId", "launchAgentLabel"],
      "client target stamp.mac",
    );
    requireKeys(
      stamp.windows,
      ["appUserModelId", "executableName", "installerDisplayName"],
      "client target stamp.windows",
    );
    const linux = requireKeys(
      stamp.linux,
      ["deb", "rpm", "executableName", "desktopEntryName"],
      "client target stamp.linux",
    );
    requireKeys(linux.deb, ["packageName"], "client target stamp.linux.deb");
    requireKeys(linux.rpm, ["packageName"], "client target stamp.linux.rpm");
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

module.exports = {
  ClientTargetStampError,
  readClientTargetStamp,
  targetInputFromArg,
};
