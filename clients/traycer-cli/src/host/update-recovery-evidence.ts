import { createHash } from "node:crypto";
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type {
  AttemptRecoveryArtifactEvidence,
  AttemptRecoveryEvidence,
  AttemptRecoveryRunningEvidence,
} from "@traycer-clients/shared/host-update";
import { callHostRpcAtEndpoint } from "../internal/host-rpc";
import { readHostInstallRecord } from "../manifest/host-install";
import { readHostStagedRecord } from "../manifest/host-staged";
import type { Environment } from "../runner/environment";
import { getPublishedProcessIdentityVerdict } from "../store/process-identity";
import {
  hostHomeDir,
  hostInstallDir,
  hostPidMetadataPath,
  hostStagedDir,
  hostStagedRecordPath,
} from "../store/paths";
import {
  isValidLocalHostWebsocketUrl,
  readHostPidMetadata,
  type HostPidMetadata,
} from "./pid-metadata";

/**
 * A lock-scoped recovery observation plus opaque fingerprints used to prove
 * that the decisive install/stage/running facts did not change before the
 * recover write. The durable record intentionally receives only `evidence`;
 * paths, pids, hashes, and generation identifiers remain process-local.
 */
export interface AttemptRecoveryEvidenceObservation {
  readonly evidence: AttemptRecoveryEvidence;
  readonly fingerprint: string;
}

/**
 * Collect recovery evidence under an already-held attempt capability. This
 * compatibility helper exposes only the pure algebra's facts; executor code
 * must use `observeAttemptRecoveryEvidence` so it can compare the decisive
 * proof again at the final recover-write boundary.
 */
export async function readAttemptRecoveryEvidence(
  environment: Environment,
  canonicalHostHomeDir: string,
): Promise<AttemptRecoveryEvidence> {
  return (
    await observeAttemptRecoveryEvidence(environment, canonicalHostHomeDir)
  ).evidence;
}

/**
 * Read an attested install generation/placed-byte proof and an authenticated,
 * healthy exact-version host proof. Any missing attestation or inconsistent
 * snapshot is unreadable—not a weaker version of verified evidence.
 */
export async function observeAttemptRecoveryEvidence(
  environment: Environment,
  canonicalHostHomeDir: string,
): Promise<AttemptRecoveryEvidenceObservation> {
  if (resolve(hostHomeDir(environment)) !== resolve(canonicalHostHomeDir)) {
    return unreadableObservation();
  }
  const installed = await readInstalledObservation(environment);
  const staged = await readStagedObservation(environment);
  const runningBefore = await readRunningObservation(environment);
  // A host restart while collecting evidence is itself an ambiguity. Re-read
  // the live RPC/metadata proof rather than comparing just the release string.
  const runningAfter = await readRunningObservation(environment);
  const running =
    runningBefore.fingerprint === runningAfter.fingerprint
      ? runningAfter.evidence
      : { kind: "unreadable" as const };
  const evidence = {
    installed: installed.evidence,
    staged: staged.evidence,
    running,
  };
  return {
    evidence,
    fingerprint: JSON.stringify({
      installed: installed.fingerprint,
      staged: staged.fingerprint,
      running:
        running.kind === "unreadable" ? "unreadable" : runningAfter.fingerprint,
    }),
  };
}

export function sameAttemptRecoveryEvidenceObservation(
  a: AttemptRecoveryEvidenceObservation,
  b: AttemptRecoveryEvidenceObservation,
): boolean {
  return a.fingerprint === b.fingerprint;
}

type ArtifactObservation = {
  readonly evidence: AttemptRecoveryArtifactEvidence;
  readonly fingerprint: string;
};

async function readInstalledObservation(
  environment: Environment,
): Promise<ArtifactObservation> {
  let record;
  try {
    record = await readHostInstallRecord(environment);
  } catch {
    return unreadableArtifact();
  }
  if (record === null) return absentArtifact();
  if (!containedPath(hostInstallDir(environment), record.executablePath)) {
    return unreadableArtifact();
  }
  const placed = await placedFileFingerprint(record.executablePath);
  if (placed === null) {
    return {
      evidence: { kind: "missing", version: record.version },
      fingerprint: `missing:${record.version}`,
    };
  }
  if (placed === "unreadable") return unreadableArtifact();
  if (
    record.installId === null ||
    record.archiveSha256 === null ||
    typeof record.executableSha256 !== "string" ||
    placed.sha256 !== record.executableSha256
  ) {
    return unreadableArtifact();
  }
  // `install.json` is materialized in the promoted tree with the signed
  // artifact's generation. The executable's stable digest ties that durable
  // generation to exactly the bytes observed for this recovery decision.
  return {
    evidence: { kind: "verified", version: record.version },
    fingerprint: JSON.stringify({
      version: record.version,
      installId: record.installId,
      installedAt: record.installedAt,
      archiveSha256: record.archiveSha256,
      executableSha256: record.executableSha256,
      signatureVerifiedAt: record.signatureVerifiedAt,
      signatureKeyId: record.signatureKeyId,
      placed,
    }),
  };
}

async function readStagedObservation(
  environment: Environment,
): Promise<ArtifactObservation> {
  let record;
  try {
    record = await readHostStagedRecord(environment);
  } catch {
    return unreadableArtifact();
  }
  if (record === null) {
    const absent = await pathAbsentOrUnreadable(
      hostStagedRecordPath(environment),
    );
    return absent ? absentArtifact() : unreadableArtifact();
  }
  const stagedDir = hostStagedDir(environment);
  const executablePath = join(stagedDir, record.executablePath);
  if (!containedPath(stagedDir, executablePath)) return unreadableArtifact();
  const placed = await placedFileFingerprint(executablePath);
  if (placed === null) {
    return {
      evidence: { kind: "missing", version: record.version },
      fingerprint: `missing:${record.version}`,
    };
  }
  if (placed === "unreadable") return unreadableArtifact();
  if (
    record.stageId === null ||
    record.archiveSha256 === null ||
    typeof record.executableSha256 !== "string" ||
    placed.sha256 !== record.executableSha256
  ) {
    return unreadableArtifact();
  }
  return {
    evidence: { kind: "verified", version: record.version },
    fingerprint: JSON.stringify({
      version: record.version,
      stageId: record.stageId,
      archiveSha256: record.archiveSha256,
      executableSha256: record.executableSha256,
      signatureVerifiedAt: record.signatureVerifiedAt,
      signatureKeyId: record.signatureKeyId,
      placed,
    }),
  };
}

type RunningObservation = {
  readonly evidence: AttemptRecoveryRunningEvidence;
  readonly fingerprint: string;
};

async function readRunningObservation(
  environment: Environment,
): Promise<RunningObservation> {
  const metadata = await readHostPidMetadata(environment);
  if (metadata === null) {
    const absent = await pathAbsentOrUnreadable(
      hostPidMetadataPath(environment),
    );
    return absent ? absentRunning() : unreadableRunning();
  }
  if (
    metadata.processStartIdentity === null ||
    !isValidLocalHostWebsocketUrl(metadata.websocketUrl)
  ) {
    return unreadableRunning();
  }
  const identity = await getPublishedProcessIdentityVerdict(
    metadata.pid,
    metadata.processStartIdentity,
  );
  if (identity === "dead" || identity === "mismatch") return absentRunning();
  if (identity !== "current") return unreadableRunning();

  let status;
  try {
    status = await callHostRpcAtEndpoint(
      "host.status",
      {},
      { hostId: metadata.hostId, websocketUrl: metadata.websocketUrl },
    );
  } catch {
    return unreadableRunning();
  }
  if (!status.ready || status.hostVersion !== metadata.version) {
    return unreadableRunning();
  }

  // Bind the successful health response to the same pid-recorded process and
  // endpoint. A restart/recycled pid during the RPC is ambiguity, not proof.
  const after = await readHostPidMetadata(environment);
  if (!sameRunningMetadata(metadata, after)) return unreadableRunning();
  const afterIdentity = await getPublishedProcessIdentityVerdict(
    metadata.pid,
    metadata.processStartIdentity,
  );
  if (afterIdentity !== "current") return unreadableRunning();
  return {
    evidence: {
      kind: "verified",
      version: status.hostVersion,
      owner: "host-home-bound",
    },
    fingerprint: JSON.stringify({
      pid: metadata.pid,
      processStartIdentity: metadata.processStartIdentity,
      hostId: metadata.hostId,
      websocketUrl: metadata.websocketUrl,
      version: status.hostVersion,
    }),
  };
}

function sameRunningMetadata(
  before: HostPidMetadata,
  after: HostPidMetadata | null,
): boolean {
  return (
    after !== null &&
    after.pid === before.pid &&
    after.processStartIdentity === before.processStartIdentity &&
    after.hostId === before.hostId &&
    after.websocketUrl === before.websocketUrl &&
    after.version === before.version
  );
}

async function placedFileFingerprint(
  path: string,
): Promise<
  { readonly bytes: number; readonly sha256: string } | null | "unreadable"
> {
  const noFollow =
    typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const nonBlock =
    typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;
  let pathBefore: Stats;
  try {
    pathBefore = await lstat(path);
  } catch (error) {
    return errorCode(error) === "ENOENT" ? null : "unreadable";
  }
  if (!pathBefore.isFile()) return "unreadable";
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | noFollow | nonBlock);
  } catch (error) {
    return errorCode(error) === "ENOENT" ? null : "unreadable";
  }
  try {
    const before = await handle.stat();
    if (!before.isFile()) return "unreadable";
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const pathStats = await lstat(path);
    if (
      !pathStats.isFile() ||
      !sameRegularFileIdentity(pathBefore, before) ||
      !sameRegularFileIdentity(before, after) ||
      !sameRegularFileIdentity(before, pathStats) ||
      pathBefore.size !== before.size ||
      before.size !== after.size ||
      before.size !== pathStats.size
    ) {
      return "unreadable";
    }
    return {
      bytes: before.size,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch {
    return "unreadable";
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * As with the durable attempt record reader, zero inode/device values are not
 * positive same-object evidence on Windows. Recovery would rather refuse than
 * attest bytes through a descriptor it cannot bind to the canonical pathname.
 *
 * SUPPORTED-FILESYSTEM POLICY, stated explicitly: the host install tree lives
 * under the user's home, and the filesystems that can host it on supported
 * platforms (NTFS/ReFS on Windows, the POSIX filesystems elsewhere) all
 * report non-zero file IDs through libuv, so this guard never fires there. A
 * filesystem that reports zero (FAT-family media, some network redirectors)
 * is deliberately REJECTED rather than given a weaker fallback: recovery
 * yields "unreadable", cannot mint "verified", and the attempt parks for an
 * ordinary re-install instead of attesting bytes it cannot positively bind.
 * That trade — no silent recovery on an identity-less filesystem — is the
 * point of the guard, not a gap in it.
 */
function sameRegularFileIdentity(
  a: Pick<Stats, "dev" | "ino">,
  b: Pick<Stats, "dev" | "ino">,
): boolean {
  return (
    a.dev !== 0 &&
    a.ino !== 0 &&
    b.dev !== 0 &&
    b.ino !== 0 &&
    a.dev === b.dev &&
    a.ino === b.ino
  );
}

function absentArtifact(): ArtifactObservation {
  return { evidence: { kind: "absent" }, fingerprint: "absent" };
}

function unreadableArtifact(): ArtifactObservation {
  return { evidence: { kind: "unreadable" }, fingerprint: "unreadable" };
}

function absentRunning(): RunningObservation {
  return { evidence: { kind: "absent" }, fingerprint: "absent" };
}

function unreadableRunning(): RunningObservation {
  return { evidence: { kind: "unreadable" }, fingerprint: "unreadable" };
}

function unreadableObservation(): AttemptRecoveryEvidenceObservation {
  return {
    evidence: {
      installed: { kind: "unreadable" },
      staged: { kind: "unreadable" },
      running: { kind: "unreadable" },
    },
    fingerprint: "unreadable",
  };
}

async function pathAbsentOrUnreadable(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    return errorCode(error) === "ENOENT";
  }
}

function containedPath(directory: string, path: string): boolean {
  const resolvedDirectory = resolve(directory);
  const resolvedPath = resolve(path);
  const nested = relative(resolvedDirectory, resolvedPath);
  return nested.length > 0 && !nested.startsWith("..") && !isAbsolute(nested);
}

function errorCode(error: unknown): string | null {
  if (error === null || typeof error !== "object") return null;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : null;
}
