import type { IncompatibilityUpgradeGuidance } from "@traycer/protocol/framework/index";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { isRemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import { appLogger } from "@/lib/logger";

export interface VersionSkewCopy {
  readonly title: string;
  /** The affordance label; never uses "Update required" (below-floor only). */
  readonly action: string;
  /** Machine-readable discriminant for which leg the handshake says is behind. */
  readonly direction: "host-outdated" | "client-outdated";
}

export interface VersionSkewInput {
  readonly hostAppVersion: string | null;
  readonly clientAppVersion: string | null;
  readonly guidance: IncompatibilityUpgradeGuidance | null;
}

/**
 * Direction-aware `INCOMPATIBLE` copy (Architecture §13, R4-D2): "every
 * supported app version can open a session to every host >= floor" is the
 * two-sided invariant, so above the floor an `INCOMPATIBLE` failure is a
 * genuine bug, not routine drift — the failure copy names the leg that's
 * actually behind instead of a generic fatal.
 *
 * Prefer the directory/status DTO's host `appVersion` against this app's build
 * manifest version. The handshake's `upgradeGuidance` is only a secondary hint
 * for surfaces that do not have DTO version evidence available.
 *
 * "Update required" is deliberately never used here — that copy is reserved
 * for a host below the global support floor (`updateState: "required"`), a
 * different failure this function's caller must not conflate with a version
 * skew above the floor.
 */
export function describeVersionSkew(input: VersionSkewInput): VersionSkewCopy {
  const comparison = compareAppVersions(
    input.hostAppVersion,
    input.clientAppVersion,
  );
  if (comparison === "host-behind") {
    return {
      title: "Host update needed",
      action: "Update now",
      direction: "host-outdated",
    };
  }
  if (comparison === "client-behind") {
    return {
      title: "Your app is too old",
      action: "Update the app",
      direction: "client-outdated",
    };
  }
  if (
    input.guidance !== null &&
    input.guidance.hostShouldUpgrade &&
    !input.guidance.clientShouldUpgrade
  ) {
    return {
      title: "Host update needed",
      action: "Update now",
      direction: "host-outdated",
    };
  }
  if (
    input.guidance !== null &&
    input.guidance.clientShouldUpgrade &&
    !input.guidance.hostShouldUpgrade
  ) {
    return {
      title: "Your app is too old",
      action: "Update the app",
      direction: "client-outdated",
    };
  }
  // Reached only when `guidance` doesn't single out one leg — either both
  // flags are set (multiple incompatible methods diverging in opposite
  // directions) or neither is (no guidance at all, with an unparsable/"same"
  // comparison). Per this function's own doc comment, an `INCOMPATIBLE`
  // failure above the floor is "a genuine bug, not routine drift", so this
  // fallback is worth a log rather than a silent default.
  appLogger.warn(
    "[version-skew] ambiguous guidance; defaulting to host-update copy",
    {
      comparison,
      guidance:
        input.guidance === null
          ? null
          : {
              hostShouldUpgrade: input.guidance.hostShouldUpgrade,
              clientShouldUpgrade: input.guidance.clientShouldUpgrade,
            },
    },
  );
  return {
    title: "Host update needed",
    action: "Update now",
    direction: "host-outdated",
  };
}

export function hostAppVersionFromDirectoryEntry(
  entry: HostDirectoryEntry | null,
): string | null {
  if (entry === null) {
    return null;
  }
  if (isRemoteHostDirectoryEntry(entry)) {
    return cleanVersion(entry.remoteStatus.appVersion);
  }
  return cleanVersion(entry.version);
}

type VersionComparison = "host-behind" | "client-behind" | "same";

function compareAppVersions(
  hostAppVersion: string | null,
  clientAppVersion: string | null,
): VersionComparison | null {
  const host = versionParts(hostAppVersion);
  const client = versionParts(clientAppVersion);
  if (host === null || client === null) {
    return null;
  }
  for (let index = 0; index < host.length; index += 1) {
    if (host[index] < client[index]) {
      return "host-behind";
    }
    if (host[index] > client[index]) {
      return "client-behind";
    }
  }
  return "same";
}

function cleanVersion(version: string | null): string | null {
  if (version === null) {
    return null;
  }
  const trimmed = version.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function versionParts(
  version: string | null,
): readonly [number, number, number] | null {
  const clean = cleanVersion(version);
  if (clean === null) {
    return null;
  }
  const matched = /^v?\d+(?:\.\d+){0,2}/i.exec(clean);
  if (matched === null) {
    return null;
  }
  const segments = matched[0].replace(/^v/i, "").split(".");
  const major = parseVersionSegment(segments[0]);
  if (major === null) {
    return null;
  }
  const minor = segments.length < 2 ? 0 : parseVersionSegment(segments[1]);
  if (minor === null) {
    return null;
  }
  const patch = segments.length < 3 ? 0 : parseVersionSegment(segments[2]);
  if (patch === null) {
    return null;
  }
  return [major, minor, patch];
}

function parseVersionSegment(segment: string): number | null {
  const parsed = Number.parseInt(segment, 10);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}
