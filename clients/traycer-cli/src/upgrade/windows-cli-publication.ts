import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { isStrictlyNewerHostVersion } from "@traycer-clients/shared/host-version/compare-host-versions";
import { nonReleaseIdentityKind } from "@traycer-clients/shared/host-version/non-release-identity";
import { CLI_CLIENT_IDENTITY } from "../cli-version";
import { hashFileSha256 } from "../installer/sha256";
import {
  cliAssetVersion,
  currentCliPlatformKey,
  fetchCliVersions,
  resolveCliAsset,
} from "../registry/cli-versions";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";
import type { ServiceLabel } from "../service/label";

export type WindowsCliCandidate =
  | {
      readonly kind: "release";
      readonly version: string;
      readonly sha256: string;
    }
  | { readonly kind: "pending"; readonly version: string }
  | { readonly kind: "anchor"; readonly runningBinaryPath: string | null };

type WindowsCliPublication =
  | { readonly kind: "identical" }
  | { readonly kind: "admitted"; readonly sha256: string | null };

export async function admitWindowsCliPublication(opts: {
  readonly label: ServiceLabel;
  readonly stagedBinaryPath: string;
  readonly currentBinaryPath: string | null;
  readonly installedVersion: string | null;
  readonly candidate: WindowsCliCandidate;
}): Promise<WindowsCliPublication> {
  const { candidate, stagedBinaryPath, installedVersion } = opts;
  const isNewer = (version: string): boolean =>
    installedVersion !== null &&
    nonReleaseIdentityKind(installedVersion) === null &&
    nonReleaseIdentityKind(version) === null &&
    isStrictlyNewerHostVersion(version, installedVersion);

  // The release digest comes from the verified feed, not the install record.
  const newerRelease =
    candidate.kind === "release" && isNewer(candidate.version);
  const { retryWindowsRegistrationMode } =
    await import("../service/platforms/windows");
  const mode = newerRelease
    ? null
    : await retryWindowsRegistrationMode(opts.label);
  if (mode === "absent" || mode === "logon") {
    return {
      kind: "admitted",
      sha256: candidate.kind === "release" ? candidate.sha256 : null,
    };
  }

  // Authenticate the exact file the publisher will rename. External and
  // pending bytes need a signed feed digest. A byte-identical live slot
  // needs neither authentication nor publication. For self-publication,
  // hash the complete running SEA and require its digest on the private
  // staged copy. Unauthenticated replacements are refused in either
  // protected mode; only then can a marker establish compatibility.
  const sha256 = await hashFileSha256(stagedBinaryPath, null).catch(() => null);
  if (sha256 === null) throw unverifiedWindowsCliPublication();
  if (
    opts.currentBinaryPath !== null &&
    (await hashFileSha256(opts.currentBinaryPath, null).catch(() => null)) ===
      sha256
  ) {
    return { kind: "identical" };
  }
  const runningImage =
    candidate.kind === "anchor" &&
    candidate.runningBinaryPath !== null &&
    (await hashFileSha256(candidate.runningBinaryPath, null).catch(
      () => null,
    )) === sha256;
  const authenticatedVersion = runningImage
    ? CLI_CLIENT_IDENTITY.appVersion
    : await authenticateWindowsCliRelease(candidate, sha256);
  if (authenticatedVersion === null) throw unverifiedWindowsCliPublication();
  if (!runningImage && isNewer(authenticatedVersion)) {
    return { kind: "admitted", sha256 };
  }
  if (mode === "unavailable") {
    throw cliError({
      code: CLI_ERROR_CODES.CLI_UPGRADE_BOOT_TASK_UNSUPPORTED,
      message:
        "Windows did not confirm how the host task starts. Retry the CLI upgrade when Task Scheduler is available.",
      details: null,
      exitCode: 1,
    });
  }
  if (await hasAuthenticatedWindowsBootMarker(stagedBinaryPath, sha256)) {
    return { kind: "admitted", sha256 };
  }
  throw cliError({
    code: CLI_ERROR_CODES.CLI_UPGRADE_BOOT_TASK_UNSUPPORTED,
    message:
      "This CLI cannot manage a host that starts when Windows starts. Retry with a CLI that supports --start-at-boot.",
    details: null,
    exitCode: 1,
  });
}

export const UNVERIFIED_WINDOWS_CLI_MESSAGE =
  "Traycer could not verify the CLI binary for the Windows host task. Retry with 'traycer cli upgrade'.";

function unverifiedWindowsCliPublication(): Error {
  return cliError({
    code: CLI_ERROR_CODES.CLI_UPGRADE_BOOT_TASK_UNSUPPORTED,
    message: UNVERIFIED_WINDOWS_CLI_MESSAGE,
    details: null,
    exitCode: 1,
  });
}

async function authenticateWindowsCliRelease(
  candidate: WindowsCliCandidate,
  sha256: string,
): Promise<string | null> {
  if (candidate.kind === "release") {
    return sha256 === candidate.sha256 ? candidate.version : null;
  }
  try {
    const feed = await fetchCliVersions();
    const version = cliAssetVersion(feed);
    if (candidate.kind === "pending" && candidate.version !== version) {
      return null;
    }
    return resolveCliAsset(feed, currentCliPlatformKey()).sha256 === sha256
      ? version
      : null;
  } catch {
    return null;
  }
}

// The complete marker is only emitted as a Windows SEA asset. Keep its
// parts separate in the scanner so bundling the scanner cannot advertise it.
const WINDOWS_BOOT_MARKER = [
  "traycer:windows-unattended-service:",
  "1:ed362e23-7428-47cf-b857-ff24ea69d5d2\n",
];

async function hasAuthenticatedWindowsBootMarker(
  binaryPath: string,
  sha256: string,
): Promise<boolean> {
  const marker = Buffer.from(WINDOWS_BOOT_MARKER.join(""), "ascii");
  const hash = createHash("sha256");
  let tail = Buffer.alloc(0);
  let first = true;
  let validPe = false;
  let matches = 0;
  try {
    for await (const chunk of createReadStream(binaryPath)) {
      if (!Buffer.isBuffer(chunk)) return false;
      if (first) {
        first = false;
        if (chunk.length >= 64 && chunk.toString("ascii", 0, 2) === "MZ") {
          const peOffset = chunk.readUInt32LE(0x3c);
          validPe =
            peOffset >= 64 &&
            peOffset + 4 <= chunk.length &&
            chunk
              .subarray(peOffset, peOffset + 4)
              .equals(Buffer.from("PE\0\0"));
        }
      }
      hash.update(chunk);
      const bytes = Buffer.concat([tail, chunk]);
      for (
        let offset = bytes.indexOf(marker);
        offset !== -1;
        offset = bytes.indexOf(marker, offset + marker.length)
      ) {
        matches++;
      }
      tail = bytes.subarray(Math.max(0, bytes.length - marker.length + 1));
    }
    return validPe && matches === 1 && hash.digest("hex") === sha256;
  } catch {
    return false;
  }
}
