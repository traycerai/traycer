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
import { isValidHostVersion } from "@traycer-clients/shared/host-version/compare-host-versions";
import type { InstallGenerationIdentity } from "@traycer-clients/shared/host-version/install-generation";
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
  /**
   * The install record's generation inputs exactly as this observation read
   * them, or `null` when no record could be read at all.
   *
   * Deliberately the encoder's OWN input shape rather than a pre-encoded
   * string: `encodeInstallGeneration` is the one producer every other writer
   * calls, and handing it the same four fields here is what makes a claim
   * baseline refreshed from this observation compare byte-equal with the
   * baseline an installer wrote.
   *
   * Populated from the install record as PARSED, independent of whether the
   * placed bytes attested - the same reading `readActivationState` performs.
   * A caller that needs attestation reads `evidence.installed`; the one
   * consumer today (the executor's recovery park) is reachable only behind a
   * `verified` installed leg.
   */
  readonly installIdentity: InstallGenerationIdentity | null;
  /**
   * The staged record's `stageId`, or `null` when nothing is staged (or the
   * stage record could not be read). The same value `resolveUpdatePlan`
   * carries as its plan identity's `stageFingerprint`.
   */
  readonly stageFingerprint: string | null;
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
  // The running leg is typed AGAINST the install record (D9), so the record
  // this observation already read is what classifies it - never a second
  // `install.json` read that could disagree with the installed leg beside it.
  const runningBefore = await readRunningObservation(
    environment,
    installed.runtime,
  );
  // A host restart while collecting evidence is itself an ambiguity. Re-read
  // the live RPC/metadata proof rather than comparing just the release string.
  const runningAfter = await readRunningObservation(
    environment,
    installed.runtime,
  );
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
    installIdentity: installed.identity,
    stageFingerprint: staged.stageFingerprint,
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

/**
 * The two install-record facts the running leg is typed against (D9): the
 * catalog `version` the record names, and the `runtimeVersion` stamp that
 * says what the promoted binary reports about itself.
 */
type InstalledRuntimeFacts = {
  readonly version: string;
  readonly runtimeVersion: string | null;
};

type InstalledObservation = ArtifactObservation & {
  readonly identity: InstallGenerationIdentity | null;
  readonly runtime: InstalledRuntimeFacts | null;
};

type StagedObservation = ArtifactObservation & {
  readonly stageFingerprint: string | null;
};

async function readInstalledObservation(
  environment: Environment,
): Promise<InstalledObservation> {
  let record;
  try {
    record = await readHostInstallRecord(environment);
  } catch {
    return withoutInstallIdentity(unreadableArtifact());
  }
  if (record === null) return withoutInstallIdentity(absentArtifact());
  // Read off the record as PARSED, before any attestation arm: these are the
  // identity facts (which archive, which runtime stamp), and every arm below
  // - verified, missing, unreadable - observed the same record.
  const identity: InstallGenerationIdentity = {
    installId: record.installId,
    installedAt: record.installedAt,
    archiveSha256: record.archiveSha256,
    version: record.version,
  };
  const runtime: InstalledRuntimeFacts = {
    version: record.version,
    runtimeVersion: record.runtimeVersion,
  };
  const identified = (
    observation: ArtifactObservation,
  ): InstalledObservation => ({ ...observation, identity, runtime });

  if (!containedPath(hostInstallDir(environment), record.executablePath)) {
    return identified(unreadableArtifact());
  }
  const placed = await placedFileFingerprint(record.executablePath);
  if (placed === null) {
    return identified({
      evidence: { kind: "missing", version: record.version },
      fingerprint: `missing:${record.version}`,
    });
  }
  if (placed === "unreadable") return identified(unreadableArtifact());
  if (
    record.installId === null ||
    record.archiveSha256 === null ||
    typeof record.executableSha256 !== "string" ||
    placed.sha256 !== record.executableSha256
  ) {
    return identified(unreadableArtifact());
  }
  // `install.json` is materialized in the promoted tree with the signed
  // artifact's generation. The executable's stable digest ties that durable
  // generation to exactly the bytes observed for this recovery decision.
  return identified({
    evidence: { kind: "verified", version: record.version },
    fingerprint: JSON.stringify({
      version: record.version,
      // A decision input for the running leg since D9, so a change to it has
      // to break the flap fingerprint even when the placed bytes are
      // untouched: `host stamp-runtime` rewrites exactly this field after a
      // first run, without moving a single byte of the executable.
      runtimeVersion: record.runtimeVersion,
      installId: record.installId,
      installedAt: record.installedAt,
      archiveSha256: record.archiveSha256,
      executableSha256: record.executableSha256,
      signatureVerifiedAt: record.signatureVerifiedAt,
      signatureKeyId: record.signatureKeyId,
      placed,
    }),
  });
}

function withoutInstallIdentity(
  observation: ArtifactObservation,
): InstalledObservation {
  return { ...observation, identity: null, runtime: null };
}

async function readStagedObservation(
  environment: Environment,
): Promise<StagedObservation> {
  let record;
  try {
    record = await readHostStagedRecord(environment);
  } catch {
    return withoutStageFingerprint(unreadableArtifact());
  }
  if (record === null) {
    const absent = await pathAbsentOrUnreadable(
      hostStagedRecordPath(environment),
    );
    return withoutStageFingerprint(
      absent ? absentArtifact() : unreadableArtifact(),
    );
  }
  // As on the install side: the stage's identity comes off the record as
  // parsed, so an unattested stage still says WHICH stage it is.
  const stageFingerprint = record.stageId;
  const identified = (observation: ArtifactObservation): StagedObservation => ({
    ...observation,
    stageFingerprint,
  });
  const stagedDir = hostStagedDir(environment);
  const executablePath = join(stagedDir, record.executablePath);
  if (!containedPath(stagedDir, executablePath)) {
    return identified(unreadableArtifact());
  }
  const placed = await placedFileFingerprint(executablePath);
  if (placed === null) {
    return identified({
      evidence: { kind: "missing", version: record.version },
      fingerprint: `missing:${record.version}`,
    });
  }
  if (placed === "unreadable") return identified(unreadableArtifact());
  if (
    record.stageId === null ||
    record.archiveSha256 === null ||
    typeof record.executableSha256 !== "string" ||
    placed.sha256 !== record.executableSha256
  ) {
    return identified(unreadableArtifact());
  }
  return identified({
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
  });
}

function withoutStageFingerprint(
  observation: ArtifactObservation,
): StagedObservation {
  return { ...observation, stageFingerprint: null };
}

type RunningObservation = {
  readonly evidence: AttemptRecoveryRunningEvidence;
  readonly fingerprint: string;
};

async function readRunningObservation(
  environment: Environment,
  installed: InstalledRuntimeFacts | null,
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
    evidence: classifyRunningIdentity(status.hostVersion, installed),
    fingerprint: JSON.stringify({
      pid: metadata.pid,
      processStartIdentity: metadata.processStartIdentity,
      hostId: metadata.hostId,
      websocketUrl: metadata.websocketUrl,
      // The RAW identity the process reports about itself, kept under its
      // original key. Since D9 the evidence's `version` is no longer always
      // this string, so the fingerprint is the only place the raw identity
      // survives - and it must, or a host that swapped identities behind an
      // otherwise identical pid record would compare equal across the flap.
      version: status.hostVersion,
      // The install-record facts `classifyRunningIdentity` consumes. Without
      // them the classification could change between two observations while
      // the fingerprint stayed put, which is precisely what the flap
      // comparison exists to catch.
      installedVersion: installed === null ? null : installed.version,
      installedRuntimeVersion:
        installed === null ? null : installed.runtimeVersion,
    }),
  };
}

/**
 * Type a healthy host's self-reported identity against the install record
 * (plan D9).
 *
 * A process answering `host.status` proves it is running, not WHAT it is
 * running that this install record vouches for. Only two readings are a
 * catalog version:
 *
 *  - the identity equals what the record says its promoted binary reports
 *    (`runtimeVersion`, falling back to the catalog `version` for a record
 *    with no stamp yet) - so the record's own catalog version is running;
 *  - the identity is itself a plain catalog version OTHER than the record's -
 *    a different released build is running, which is today's reading and is
 *    the debt every activation arm already handles.
 *
 * Everything else is `foreign`: a staging identity that matches no record, or
 * the record's catalog version reported by a process while the record names a
 * DIFFERENT runtime stamp (the "C/R collision"). No shared equality accepts
 * `foreign`, so the seal, the commit and the executor's completion gate can
 * never mistake it for the target - and `decideAttemptRecovery` reads it as
 * activation debt, exactly as `readActivationState` already reads the same
 * disagreement.
 *
 * With NO install record there is nothing to vouch for an identity either
 * way, so the release-version policy alone decides - the same rule
 * `readActivationState` applies in its catalog-version domain.
 */
function classifyRunningIdentity(
  hostVersion: string,
  installed: InstalledRuntimeFacts | null,
): AttemptRecoveryRunningEvidence {
  if (installed === null) {
    return isValidHostVersion(hostVersion)
      ? { kind: "verified", version: hostVersion, owner: "host-home-bound" }
      : { kind: "foreign", runtimeIdentity: hostVersion };
  }
  const stamp = installed.runtimeVersion ?? installed.version;
  if (hostVersion === stamp) {
    return {
      kind: "verified",
      version: installed.version,
      owner: "host-home-bound",
    };
  }
  if (isValidHostVersion(hostVersion) && hostVersion !== installed.version) {
    return { kind: "verified", version: hostVersion, owner: "host-home-bound" };
  }
  return { kind: "foreign", runtimeIdentity: hostVersion };
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
    // Nothing was read, so there is no identity to report. A caller refreshing
    // a claim baseline from this observation carries the record's prior
    // baseline unchanged rather than inventing one.
    installIdentity: null,
    stageFingerprint: null,
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
