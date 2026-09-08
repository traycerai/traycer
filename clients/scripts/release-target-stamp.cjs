/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

// Reads the small client projection emitted by the internal release-target
// descriptor. This is intentionally a shape check, not an attestation layer:
// the payload is produced from reviewed repository bytes by the same release
// workflow that consumes it.
const fs = require("node:fs");
const path = require("node:path");

const KNOWN_TARGETS = ["production", "staging"];
// The desktop `releaseChannel` each target must stamp. Mirrors the
// `desktop.releaseChannel` values in the build repo's `release-targets.json`;
// see the check in `readClientTargetStamp` for why this one is pinned to an
// exact value rather than merely required to be a string.
const REQUIRED_RELEASE_CHANNEL = {
  production: "stable",
  staging: "staging",
};
// The install identity each target must stamp, pinned to exact values for the
// same reason `releaseChannel` is - and for a sharper one.
//
// These two keys are the ONLY stamped values a SECOND process derives
// independently instead of reading: the CLI never consumes them. It computes
// its own from `config.environment` alone - `serviceLabelFor(env).id` and
// `windowsTaskName(serviceLabelFor(env))` in
// `clients/traycer-cli/src/service/label.ts`. The stamp's copies exist so the
// packaging path can name the CLI's registration without importing the CLI,
// and a value that merely IS a non-empty string satisfies every other check
// here while naming a service that does not exist:
//
//   - `windowsTaskName` is written into the NSIS uninstaller
//     (`TRAYCER_WINDOWS_TASK_NAME` / `_FOLDER` in
//     `release-target-electron-builder.cjs`). A typo such as
//     `\Traycer\Host-Stagin` passes, and the uninstaller then stops and
//     deletes a task the CLI never registered - leaving the real staging Host
//     scheduled to restart after the app is removed.
//   - `serviceLabelId` is the macOS half of the same bug. The internal repo's
//     `release-target.cjs` only checks it against `mac.launchAgentLabel`
//     (`<id>.agent`), so a typo that is spelled consistently in BOTH is
//     self-consistent there and still mismatches the LaunchAgent the CLI
//     registers.
//
// Pinned rather than cross-checked against the CLI, because these values are
// read by build tooling that cannot import the CLI's TypeScript. The lockstep
// is asserted from the CLI side instead, in
// `clients/traycer-cli/src/service/__tests__/label.test.ts`, so a change to
// `serviceLabelFor`/`windowsTaskName` reddens there rather than shipping a
// silent divergence.
//   - the install roots are the same bug with a filesystem instead of a
//     service registry. The CLI computes them from the environment alone
//     (`environmentSubdir` in `clients/traycer-cli/src/store/paths.ts`:
//     production keeps the base, every other environment takes a subdirectory
//     named after itself), so `~/.traycer/cli/stagng` is a well-formed
//     home-relative path that passes every shape check here and names a
//     directory the CLI never reads or writes.
const REQUIRED_INSTALL_IDENTITY = {
  production: {
    serviceLabelId: "ai.traycer.host",
    windowsTaskName: "\\Traycer\\Host",
    cliInstallRoot: "~/.traycer/cli",
    hostInstallRoot: "~/.traycer/host",
  },
  staging: {
    serviceLabelId: "ai.traycer.host.staging",
    windowsTaskName: "\\Traycer\\Host-Staging",
    cliInstallRoot: "~/.traycer/cli/staging",
    hostInstallRoot: "~/.traycer/host/staging",
  },
};

/**
 * The LaunchAgent label the desktop's in-bundle plist must be named.
 *
 * DERIVED, not a third column, because the runtime derives it the same way:
 * `host-login-item.ts` computes
 * `smAppServiceAgentLabelId(labelForEnvironment(config.environment).id)` -
 * literally `<serviceLabelId>.agent` - and SMAppService then resolves the
 * in-bundle plist by that EXACT filename. Spelling it out per target would
 * make the agent label a value that can disagree with the service label it is
 * built from, which is the whole failure being closed.
 *
 * The desktop stamp carries `mac.launchAgentLabel` and no `serviceLabelId`,
 * so this is the only place the desktop's half of the label is pinned at all.
 */
function requiredLaunchAgentLabel(target) {
  return `${REQUIRED_INSTALL_IDENTITY[target].serviceLabelId}.agent`;
}
// Scalar keys must be non-empty strings; structured keys are checked by shape
// below. Keeping the two sets apart is what makes a `null` scalar fail here
// instead of being packaged as `appId: null` or `schemes: [null]`.
//
// `credentialEnvironmentVariable` is deliberately NOT here. It is the one
// stamped scalar whose absence is meaningful: a target that reaches its
// release repository anonymously has no credential variable, and production
// emits `null` for exactly that reason. Requiring a non-empty string rejected
// every production desktop stamp - see `requireCredentialEnvironmentVariable`.
const COMMON_SCALAR_KEYS = [
  "target",
  "environment",
  "sentryEnvironment",
  "cliFeedTag",
  "hostDiscoveryTag",
];

/**
 * The credential variable, checked against whether the target authenticates.
 *
 * TWO failures, opposite directions, and the shape check caught neither:
 *
 *   - ABSENT WHEN NEEDED, or named anything at all. No stamper consumes this
 *     field; `GitHubReleaseCredentialResolver` reads the hard-coded
 *     `STAGING_RELEASE_TOKEN_ENV` from `clients/shared/github-release-auth`.
 *     So a descriptor that renamed it would build a release that cannot
 *     authenticate, while the stamp looked complete. Pinned to the one name
 *     the resolver actually reads.
 *   - PRESENT WHEN NOT NEEDED. Production reaches a public repository
 *     anonymously (`credentialSources: []`) and correctly emits `null`; a
 *     non-empty value there would advertise a credential nothing supplies.
 *
 * `credentialSources` is the discriminator because it is the same field the
 * resolver consults to decide whether to look for a credential at all, so the
 * two cannot disagree about whether this target authenticates.
 */
const STAGING_RELEASE_TOKEN_ENV = "TRAYCER_STAGING_RELEASE_TOKEN";

// The only channel `platformChannelFile()` in
// `src/electron-main/app/desktop-release-feed.ts` ever asks for.
const DISCOVERABLE_UPDATER_CHANNEL = "latest";

function requireCredentialPolicy(stamp) {
  const value = stamp.credentialEnvironmentVariable;
  const authenticates = stamp.credentialSources.length > 0;
  if (!authenticates) {
    if (value !== null && value !== undefined) {
      throw new ClientTargetStampError(
        `client target stamp credentialEnvironmentVariable ${JSON.stringify(value)} is set, but this target declares no credentialSources and reaches its release repository anonymously. An unused credential variable is a claim nothing honours.`,
      );
    }
    if (stamp.authorizedOrigins.length > 0) {
      throw new ClientTargetStampError(
        `client target stamp authorizedOrigins ${JSON.stringify(stamp.authorizedOrigins)} is non-empty, but this target declares no credentialSources. Origins exist to bound where a credential may be SENT, so listing them without one describes a rule with no subject.`,
      );
    }
    return;
  }
  if (value !== STAGING_RELEASE_TOKEN_ENV) {
    throw new ClientTargetStampError(
      `client target stamp credentialEnvironmentVariable ${JSON.stringify(value)} is not ${JSON.stringify(STAGING_RELEASE_TOKEN_ENV)}. No stamper reads this field: the shared credential resolver reads that exact variable, so any other name builds a release that cannot authenticate.`,
    );
  }
  if (stamp.authorizedOrigins.length === 0) {
    throw new ClientTargetStampError(
      "client target stamp authorizedOrigins is empty while credentialSources is not. A target that carries a credential must say where it may be sent; an empty list would leave the send-site unbounded.",
    );
  }
}
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

/**
 * An install root the consumers may treat as home-relative.
 *
 * `windowsLauncherPath` in `release-target-electron-builder.cjs` does
 * `cliInstallRoot.slice(2)` to drop a leading `~/` before joining it onto
 * `$PROFILE`. An absolute value such as `/opt/traycer/cli` survives every
 * other check here and then loses its first two characters instead, producing
 * `$PROFILE\pt\traycer\cli\...` - so the NSIS uninstaller deletes nothing and
 * leaves the registered launcher behind. Refuse the shape rather than let a
 * consumer assume it.
 *
 * The prefix alone is not the whole property: `~/../shared` also starts with
 * `~/` and still resolves outside the home directory, which is the same escape
 * by a different spelling, and a bare `~/` names the home directory itself
 * rather than a root under it. A guard called "home-relative" has to mean it.
 *
 * SEGMENTS ARE ALLOWLISTED RATHER THAN SCREENED, because the two escapes this
 * has to stop are not reachable by enumerating spellings of `..`:
 *
 *   - `windowsLauncherPath` converts `/` to `\`, so a BACKSLASH in the value is
 *     already a separator on the Windows side. `~/..\shared` is a single
 *     segment to `split("/")`, passes a `..` check, and lands as
 *     `$PROFILE\..\shared\...` - outside the profile.
 *   - the result is interpolated into `!define TRAYCER_HOST_LAUNCHER "<here>"`,
 *     and NSIS has no escape for its own delimiter, so a `"` in the value ends
 *     the string early and the remainder is parsed as installer script.
 *
 * A blocklist would have to anticipate both, plus whatever the next consumer
 * treats as special. `[A-Za-z0-9._-]` covers every value the descriptor has
 * ever carried (`.traycer`, `cli`, `host`, `staging`) and cannot express a
 * separator, a quote, or a shell metacharacter at all. If a real path ever
 * needs a wider charset, this fails loudly at build time with the offending
 * segment named - which is the right place to have that argument.
 */
const HOME_RELATIVE_SEGMENT = /^[A-Za-z0-9._-]+$/u;

function requireHomeRelativePath(value, where) {
  requireString(value, where);
  if (!value.startsWith("~/")) {
    throw new ClientTargetStampError(
      `${where} must be home-relative and start with "~/", got ${JSON.stringify(value)}`,
    );
  }
  const segments = value.slice(2).split("/");
  if (segments.some((segment) => segment.length === 0)) {
    throw new ClientTargetStampError(
      `${where} must name a directory under the home directory, got ${JSON.stringify(value)}`,
    );
  }
  if (segments.includes("..")) {
    throw new ClientTargetStampError(
      `${where} must stay inside the home directory, got ${JSON.stringify(value)}`,
    );
  }
  // The `..` branch above owns its own message; this catches every OTHER
  // dots-only segment, which the allowlist below cannot: `.` is a legal
  // character in a plain name (`.traycer`), so `^[A-Za-z0-9._-]+$` accepts a
  // bare `.` and every longer run of dots.
  //
  // `~/.` is the empty-segment defect above wearing a different spelling - it
  // resolves to the home directory ITSELF rather than a root under it, which
  // the emptiness check already refuses for `~/`. `~/.traycer/./cli` is worse
  // than merely redundant: these values are compared and joined as STRINGS by
  // consumers that never normalize (`windowsLauncherPath` does a literal
  // `slice(2)` + `replaceAll("/", "\\")`), so a second spelling of the same
  // directory is a value that resolves equal and compares unequal. `...` and
  // longer runs go with them because Windows silently trims trailing dots, so
  // such a segment names a different directory there than on POSIX.
  const navigationSegment = segments.find((segment) => /^\.+$/u.test(segment));
  if (navigationSegment !== undefined) {
    throw new ClientTargetStampError(
      `${where} path segment ${JSON.stringify(navigationSegment)} names no directory; every segment must be a real directory name under the home directory. Got ${JSON.stringify(value)}`,
    );
  }
  const offending = segments.find(
    (segment) => !HOME_RELATIVE_SEGMENT.test(segment),
  );
  if (offending !== undefined) {
    throw new ClientTargetStampError(
      `${where} path segment ${JSON.stringify(offending)} is not a plain name; only [A-Za-z0-9._-] is allowed, so that a consumer converting "/" to "\\" or quoting the value cannot be made to leave the install root. Got ${JSON.stringify(value)}`,
    );
  }
}

/** A non-empty array whose every entry is a non-empty string. */
function requireStringArray(value, where) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ClientTargetStampError(`${where} must be a non-empty array`);
  }
  value.forEach((entry, index) => requireString(entry, `${where}[${index}]`));
}

/**
 * An array of non-empty strings that MAY itself be empty.
 *
 * Separate from `requireStringArray` because emptiness means opposite things
 * for the two callers. `updaterChannelFiles` is a list of files that must
 * exist, so empty is a mistake. The credential arrays describe how a target
 * reaches its release repository, and "no credential sources" is the correct,
 * deliberate description of an anonymous public download - production's.
 * Whether empty is ALLOWED here is a shape question; whether it is CORRECT for
 * this target is decided together with the credential variable, below.
 */
function requireOptionalStringArray(value, where) {
  if (!Array.isArray(value)) {
    throw new ClientTargetStampError(`${where} must be an array`);
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
      // Required to be PRESENT even though it may be null: a stamp that omits
      // it entirely has lost the field rather than declared "no credential".
      "credentialEnvironmentVariable",
      ...componentKeys.scalar,
      ...componentKeys.structured,
    ],
    "client target stamp",
  );
  for (const key of [...COMMON_SCALAR_KEYS, ...componentKeys.scalar]) {
    requireString(stamp[key], `client target stamp.${key}`);
  }
  for (const key of ["credentialSources", "authorizedOrigins"]) {
    requireOptionalStringArray(stamp[key], `client target stamp.${key}`);
  }
  // After the arrays, since `credentialSources` is the discriminator.
  requireCredentialPolicy(stamp);
  // Both components carry `cliInstallRoot`; only the CLI stamp carries
  // `hostInstallRoot`. Every consumer of either treats them as home-relative.
  for (const key of ["cliInstallRoot", "hostInstallRoot"]) {
    if (key in stamp) {
      requireHomeRelativePath(stamp[key], `client target stamp.${key}`);
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
  // Below the target check, because the target is what these are derived from.
  // Applied per key IF PRESENT, because the two components carry different
  // subsets: the CLI stamp has all four, the desktop stamp has
  // `cliInstallRoot` and `windowsTaskName` (its NSIS uninstaller removes the
  // CLI-installed host autostart) and neither `serviceLabelId` nor
  // `hostInstallRoot`.
  const requiredIdentity = REQUIRED_INSTALL_IDENTITY[stamp.target];
  for (const key of [
    "serviceLabelId",
    "windowsTaskName",
    "cliInstallRoot",
    "hostInstallRoot",
  ]) {
    if (!(key in stamp)) continue;
    if (stamp[key] !== requiredIdentity[key]) {
      throw new ClientTargetStampError(
        `client target stamp ${key} ${JSON.stringify(stamp[key])} is not the ${JSON.stringify(stamp.target)} ${key} ${JSON.stringify(requiredIdentity[key])}. The CLI derives this value from its environment and never reads the stamp, so a build stamped with anything else names a service or directory the CLI never touches.`,
      );
    }
  }
  requireScalarKeys(
    stamp.cloud,
    ["traycerServerBaseUrl", "authnApiUrl", "cloudUiBaseUrl", "relayAttachUrl"],
    "client target stamp.cloud",
  );
  if (component === "desktop") {
    // `releaseChannel` is the one stamped value the updater compares against a
    // LITERAL rather than merely carrying: `effectiveChannelMode()` returns
    // `explicit-prerelease` for exactly `"staging"` and falls through to the
    // stable path for anything else. So a staging descriptor that said
    // `"stable"` - or `"Staging"`, or a typo - would pass every other check
    // here, bake verbatim, and produce a build that authenticates against a
    // private repository while looking for stable releases in it. Being a
    // non-empty string is not enough for a value with that consequence.
    const requiredReleaseChannel = REQUIRED_RELEASE_CHANNEL[stamp.target];
    if (stamp.releaseChannel !== requiredReleaseChannel) {
      throw new ClientTargetStampError(
        `client target stamp releaseChannel ${JSON.stringify(stamp.releaseChannel)} is not the ${JSON.stringify(stamp.target)} channel ${JSON.stringify(requiredReleaseChannel)}`,
      );
    }
    requireStringArray(
      stamp.updaterChannelFiles,
      "client target stamp.updaterChannelFiles",
    );
    requireScalarKeys(
      stamp.mac,
      ["bundleName", "helperBundleId", "launchAgentLabel"],
      "client target stamp.mac",
    );
    // `inject-host-launch-agent.cjs` only asks that this END IN `.agent`, and
    // then writes it as the in-bundle plist's filename and strips the suffix
    // back off for the legacy label. Both halves of that are satisfied by any
    // `<anything>.agent`, so a suffix check cannot tell the right service from
    // a plausible-looking neighbour. SMAppService resolves the plist by exact
    // filename, so a packaged app whose plist is named anything else simply
    // cannot register its host login item - and nothing before runtime says so.
    const expectedAgentLabel = requiredLaunchAgentLabel(stamp.target);
    if (stamp.mac.launchAgentLabel !== expectedAgentLabel) {
      throw new ClientTargetStampError(
        `client target stamp.mac.launchAgentLabel ${JSON.stringify(stamp.mac.launchAgentLabel)} is not the ${JSON.stringify(stamp.target)} agent label ${JSON.stringify(expectedAgentLabel)}. The desktop derives this from its environment as \`<serviceLabelId>.agent\` and asks SMAppService for that exact plist filename, so a bundle stamped with anything else can never register its host login item.`,
      );
    }
    requireScalarKeys(
      stamp.windows,
      ["appUserModelId", "executableName", "installerDisplayName"],
      "client target stamp.windows",
    );
    // TWO STAMPED VALUES THAT DUPLICATE A NEIGHBOUR, pinned to it rather than
    // to a literal. Neither is read by any stamper, and both have a consumer
    // that reads the OTHER field - so an edit here changes nothing, which is
    // worse than being wrong: the descriptor reads like configuration that
    // works.
    //
    //   - `appUserModelId`: the runtime calls `app.setAppUserModelId` with
    //     `DESKTOP_APP_USER_MODEL_ID`, which is `config.appId`. Windows
    //     attributes toasts by AUMID and drops those it cannot match, and
    //     `lifecycle.ts` says the id must equal the one baked into the
    //     installer - so these two disagreeing is a silent notification loss.
    //   - `installerDisplayName`: NSIS derives its shortcut and uninstall
    //     entry names from `productName`, which the generated config already
    //     stamps.
    for (const [key, mirrors] of [
      ["appUserModelId", "appId"],
      ["installerDisplayName", "productName"],
    ]) {
      if (stamp.windows[key] !== stamp[mirrors]) {
        throw new ClientTargetStampError(
          `client target stamp.windows.${key} ${JSON.stringify(stamp.windows[key])} does not equal ${mirrors} ${JSON.stringify(stamp[mirrors])}. Nothing reads windows.${key}; the value that reaches the build comes from ${mirrors}, so a difference here is a change that silently does not happen.`,
        );
      }
    }
    // The updater PUBLISHES under `updaterChannel` but DISCOVERS with
    // `platformChannelFile()`, which hard-codes `latest.yml` /
    // `latest-mac.yml` / `latest-linux*.yml`. Any other channel publishes
    // manifests the installed app never asks for, and it reports itself up to
    // date forever rather than failing. The descriptor already says both
    // targets use `latest` on purpose - staging's isolation comes from its own
    // repository and tag grammar, not from renaming channel files - so this
    // holds the document to the one value discovery can actually find.
    if (stamp.updaterChannel !== DISCOVERABLE_UPDATER_CHANNEL) {
      throw new ClientTargetStampError(
        `client target stamp updaterChannel ${JSON.stringify(stamp.updaterChannel)} is not ${JSON.stringify(DISCOVERABLE_UPDATER_CHANNEL)}. Update discovery requests \`latest*.yml\` unconditionally, so publishing under any other channel produces a build that can never see its own releases.`,
      );
    }
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
  // Exported for the lockstep assertion in the CLI's own
  // `service/__tests__/label.test.ts`, which is the only place both this table
  // and `serviceLabelFor`/`windowsTaskName` are reachable at once. Nothing in
  // the build path reads it from here.
  REQUIRED_INSTALL_IDENTITY,
  // Same reason, for the derived half: the CLI-side lockstep compares this
  // against `smAppServiceAgentLabelId`, so the `.agent` suffix living in two
  // packages cannot drift in one of them.
  requiredLaunchAgentLabel,
  readClientTargetStamp,
  resolveReleaseRepoForTarget,
  targetInputFromArg,
};
