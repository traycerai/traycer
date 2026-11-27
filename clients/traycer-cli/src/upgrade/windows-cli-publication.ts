import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, rename, rm, type FileHandle } from "node:fs/promises";
import { isStrictlyNewerHostVersion } from "@traycer-clients/shared/host-version/compare-host-versions";
import { nonReleaseIdentityKind } from "@traycer-clients/shared/host-version/non-release-identity";
import { hashFileSha256 } from "../installer/sha256";
import {
  cliAssetVersion,
  currentCliPlatformKey,
  fetchCliVersions,
  resolveCliAsset,
  verifyArchivedCliFeed,
} from "../registry/cli-versions";
import { CLI_ERROR_CODES, cliError, isErrnoException } from "../runner/errors";
import type { ServiceLabel } from "../service/label";

export type WindowsCliCandidate =
  | {
      readonly kind: "release";
      readonly version: string;
      readonly sha256: string;
      readonly signedEnvelope?: string;
    }
  | {
      readonly kind: "pending";
      readonly version: string;
      readonly evidence?: "signed-feed-v1";
    }
  | { readonly kind: "anchor"; readonly runningSha256: string | null };

type WindowsCliPublication =
  | { readonly kind: "identical"; readonly sha256: string }
  | { readonly kind: "admitted"; readonly sha256: string | null };

export async function admitWindowsCliPublication(opts: {
  readonly label: ServiceLabel;
  readonly stagedBinaryPath: string;
  readonly currentBinaryPath: string | null;
  readonly candidate: WindowsCliCandidate;
  readonly legacyDetached?: boolean;
}): Promise<WindowsCliPublication> {
  const { candidate, stagedBinaryPath } = opts;
  const { retryWindowsRegistrationMode } =
    await import("../service/platforms/windows");
  const mode = await retryWindowsRegistrationMode(opts.label);
  if (mode === "unavailable") {
    throw cliError({
      code: CLI_ERROR_CODES.CLI_UPGRADE_BOOT_TASK_UNSUPPORTED,
      message: WINDOWS_TASK_UNAVAILABLE_MESSAGE,
      details: null,
      exitCode: 1,
    });
  }
  if (
    opts.legacyDetached === true &&
    (candidate.kind !== "pending" ||
      candidate.evidence !== undefined ||
      mode === "unattended")
  ) {
    throw unverifiedWindowsCliPublication();
  }
  const archived =
    candidate.kind === "pending"
      ? await readWindowsCliEvidence(stagedBinaryPath).catch(() => {
          throw unverifiedWindowsCliPublication();
        })
      : null;
  if (
    candidate.kind === "pending" &&
    candidate.evidence !== undefined &&
    archived === null
  ) {
    throw unverifiedWindowsCliPublication();
  }
  const archivedDigest =
    archived === null
      ? null
      : await hashFileSha256(stagedBinaryPath, null).catch(() => null);
  if (archived !== null && candidate.kind === "pending") {
    const archivedVersion =
      archivedDigest === null
        ? null
        : await archivedReleaseVersion(archived, archivedDigest);
    if (archivedVersion !== candidate.version)
      throw unverifiedWindowsCliPublication();
  }
  if (mode === "absent" || mode === "logon") {
    return {
      kind: "admitted",
      sha256: candidate.kind === "release" ? candidate.sha256 : archivedDigest,
    };
  }

  // Authenticate the exact file the publisher will rename. External and
  // pending bytes need a signed feed digest. A byte-identical live slot
  // needs neither authentication nor publication. For self-publication,
  // hash the complete running SEA and require its digest on the private
  // staged copy. Unattended registration requires authenticated bytes
  // before a marker can establish compatibility.
  const sha256 =
    archivedDigest ??
    (await hashFileSha256(stagedBinaryPath, null).catch(() => null));
  if (sha256 === null) throw unverifiedWindowsCliPublication();
  const installedDigest =
    opts.currentBinaryPath === null
      ? null
      : await hashFileSha256(opts.currentBinaryPath, null).catch(() => null);
  if (installedDigest === sha256) {
    return { kind: "identical", sha256 };
  }
  const runningImage =
    candidate.kind === "anchor" && candidate.runningSha256 === sha256;
  const authenticatedVersion = runningImage
    ? null
    : archived !== null && candidate.kind === "pending"
      ? candidate.version
      : await authenticateWindowsCliRelease(candidate, sha256);
  if (!runningImage && authenticatedVersion === null)
    throw unverifiedWindowsCliPublication();
  if (await hasAuthenticatedWindowsBootMarker(stagedBinaryPath, sha256)) {
    return { kind: "admitted", sha256 };
  }
  if (
    opts.currentBinaryPath !== null &&
    installedDigest !== null &&
    authenticatedVersion !== null
  ) {
    // The running executable's path can have been replaced since launch.
    // A signed receipt ties the installed version to the bytes we read.
    const installedVersion = await readWindowsCliEvidence(
      opts.currentBinaryPath,
    )
      .then((body) => archivedReleaseVersion(body, installedDigest))
      .catch(() => null);
    if (
      installedVersion !== null &&
      nonReleaseIdentityKind(installedVersion) === null &&
      nonReleaseIdentityKind(authenticatedVersion) === null &&
      isStrictlyNewerHostVersion(authenticatedVersion, installedVersion) &&
      (await hasAuthenticatedWindowsBootMarker(
        opts.currentBinaryPath,
        installedDigest,
      ))
    ) {
      return { kind: "admitted", sha256 };
    }
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

const WINDOWS_TASK_UNAVAILABLE_MESSAGE =
  "Windows did not confirm how the host task starts. Retry the CLI upgrade when Task Scheduler is available.";

export function publicWindowsCliDiagnostic(
  message: string,
  fallback: string,
): string {
  return message === UNVERIFIED_WINDOWS_CLI_MESSAGE ||
    message === WINDOWS_TASK_UNAVAILABLE_MESSAGE
    ? message
    : fallback;
}

export function unverifiedWindowsCliPublication(): Error {
  return cliError({
    code: CLI_ERROR_CODES.CLI_UPGRADE_BOOT_TASK_UNSUPPORTED,
    message: UNVERIFIED_WINDOWS_CLI_MESSAGE,
    details: null,
    exitCode: 1,
  });
}

export async function readWindowsCliEvidence(
  binaryPath: string,
): Promise<string | null> {
  let handle: FileHandle;
  try {
    handle = await open(`${binaryPath}.release-evidence.json`, "r");
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return null;
    throw error;
  }
  try {
    const stat = await handle.stat();
    const maxBytes = 8 * 1024 * 1024;
    if (!stat.isFile() || stat.size > maxBytes)
      throw unverifiedWindowsCliPublication();
    let body = "";
    for await (const chunk of handle.createReadStream({
      end: maxBytes,
      autoClose: false,
      encoding: "utf8",
    })) {
      if (typeof chunk !== "string") throw unverifiedWindowsCliPublication();
      body += chunk;
    }
    if (Buffer.byteLength(body) > maxBytes)
      throw unverifiedWindowsCliPublication();
    return body;
  } finally {
    await handle.close();
  }
}

export async function saveWindowsCliEvidence(
  binaryPath: string,
  envelope: string,
): Promise<void> {
  const path = `${binaryPath}.release-evidence.json`;
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(envelope, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

async function archivedReleaseVersion(
  body: string | null,
  sha256: string,
): Promise<string | null> {
  if (body === null) return null;
  try {
    const feed = await verifyArchivedCliFeed(body);
    return resolveCliAsset(feed, currentCliPlatformKey()).sha256 === sha256
      ? cliAssetVersion(feed)
      : null;
  } catch {
    return null;
  }
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
