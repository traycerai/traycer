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
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
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
/**
 * Why the RUNNING leg read the way it did, as a closed set of tokens.
 *
 * The evidence union above is what DECIDES; this is what EXPLAINS. Several
 * distinct causes collapse into one evidence kind on purpose - a dead pid and
 * a recycled one are both `absent`, and four different refusals are all
 * `unreadable` - because a decision must not branch on the difference. A user
 * staring at a failed update still has to be told which one it was, and until
 * now nobody was: the verify leg reported "did not become healthy" and threw
 * the reason away (Linux E13).
 *
 * Every token is a fixed string chosen here. Nothing read from disk, no pid,
 * no path and no host-reported identity is interpolated into one, so a token
 * is always safe to render and to assert against.
 */
export type RunningEvidenceDiagnosis =
  /** `pid.json` is absent - the host was never started, or stopped cleanly. */
  | "pid-metadata-absent"
  /** `pid.json` exists but could not be read or parsed. */
  | "pid-metadata-unreadable"
  /** The record carries no `processStartIdentity` (#1763's stamp). */
  | "pid-start-stamp-missing"
  /** The recorded websocket endpoint is not a valid local host URL. */
  | "pid-endpoint-invalid"
  /** The recorded pid names no live process. */
  | "host-process-dead"
  /** The pid is alive but is NOT the process the stamp names - recycled. */
  | "host-process-recycled"
  /** The identity verdict was neither current, dead, nor a mismatch. */
  | "pid-identity-indeterminate"
  /** The host did not answer `host.status` at its recorded endpoint. */
  | "host-rpc-unreachable"
  /**
   * The host ANSWERED and refused this client's authenticated call (Q19).
   *
   * Split out of `host-rpc-unreachable` because the two say opposite things
   * about waiting. A host that is not answering yet may be mid-restart, and the
   * verify budget exists for exactly that. A host that produced an RPC error
   * frame is up, is listening, has completed the transport handshake, and has
   * decided it will not talk to us - which the next poll will decide again,
   * identically, until the deadline. The Linux lane measured this: an old host
   * that fails enrollment stays unprovisioned, holds no JWKS, and rejects every
   * authenticated inbound call while still serving unauthenticated loopback
   * HTTP - 45 s of polling to learn what the first answer said.
   */
  | "host-refuses-authenticated-rpc"
  /** The host answered, and said it is not ready. */
  | "host-not-ready"
  /** The host answered with a version its own pid record disagrees with. */
  | "host-version-disagrees-pid"
  /** The pid record or the process identity moved while the probe ran. */
  | "host-restarted-during-probe"
  /** The host home this observation was asked for is not this environment's. */
  | "host-home-mismatch"
  /** The leg was classified; the evidence kind beside it is the answer. */
  | "classified";

export interface AttemptRecoveryEvidenceObservation {
  readonly evidence: AttemptRecoveryEvidence;
  readonly fingerprint: string;
  /**
   * Why the running leg read the way it did. Deliberately NOT part of
   * `evidence` and NOT part of `fingerprint`: it explains a reading, it never
   * participates in one, so no decision, no equality and nothing persisted can
   * change because of it.
   */
  readonly runningDiagnosis: RunningEvidenceDiagnosis;
  /**
   * The host's OWN words for a refusal, when there was one; `null` otherwise.
   *
   * Deliberately not folded into the token above, which is a closed set of
   * fixed strings precisely so it is always safe to render and to assert
   * against. This is host-reported text, so it is carried separately and only
   * ever surfaces in an error's `details` - never in a token, never in the
   * fingerprint, and never in anything a decision reads.
   */
  readonly runningRefusal: string | null;
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
  const flapped = runningBefore.fingerprint !== runningAfter.fingerprint;
  const running = flapped
    ? { kind: "unreadable" as const }
    : runningAfter.evidence;
  const evidence = {
    installed: installed.evidence,
    staged: staged.evidence,
    running,
  };
  return {
    evidence,
    runningDiagnosis: flapped
      ? "host-restarted-during-probe"
      : runningAfter.diagnosis,
    // A flap outranks a refusal, and the reason goes with the token it
    // belongs to: the observation no longer claims the host refused us, so it
    // must not carry the words either.
    runningRefusal: flapped ? null : runningAfter.refusal,
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
  readonly diagnosis: RunningEvidenceDiagnosis;
  /** Host-reported refusal text, or `null`. See `runningRefusal` above. */
  readonly refusal: string | null;
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
    return absent
      ? absentRunning("pid-metadata-absent")
      : unreadableRunning("pid-metadata-unreadable");
  }
  if (metadata.processStartIdentity === null) {
    return unreadableRunning("pid-start-stamp-missing");
  }
  if (!isValidLocalHostWebsocketUrl(metadata.websocketUrl)) {
    return unreadableRunning("pid-endpoint-invalid");
  }
  const identity = await getPublishedProcessIdentityVerdict(
    metadata.pid,
    metadata.processStartIdentity,
  );
  // Both are `absent` to every DECISION - there is no live host this record
  // vouches for either way - and the two are told apart only here, for the
  // person reading the failure. A recycled pid is the case the #1763 stamp
  // exists to catch, and "the pid now belongs to another process" is exactly
  // what the legacy health probe used to print.
  if (identity === "dead") return absentRunning("host-process-dead");
  if (identity === "mismatch") return absentRunning("host-process-recycled");
  if (identity !== "current") {
    return unreadableRunning("pid-identity-indeterminate");
  }

  let status;
  try {
    status = await callHostRpcAtEndpoint(
      "host.status",
      {},
      { hostId: metadata.hostId, websocketUrl: metadata.websocketUrl },
    );
  } catch (err) {
    // An RPC ERROR FRAME is the discriminator, and it is a strong one: to
    // produce one the host accepted the connection, completed the handshake,
    // decoded the request and chose a refusal. Nothing about that changes on
    // the next poll. Every other failure here - a refused dial, a timeout, a
    // close mid-flight - is consistent with a host that is still coming up,
    // which is what the verify budget is for.
    //
    // `UNAUTHORIZED` and `FORBIDDEN` only. A `WORKTREE_BUSY` or an
    // `E_INVALID_ARGUMENT` from this call would mean something has gone wrong
    // in a way that is not about admission, and shortening the budget is not
    // this arm's answer to that.
    const refusal = authenticatedRefusalReason(err);
    return refusal === null
      ? unreadableRunning("host-rpc-unreachable")
      : refusedRunning(refusal);
  }
  if (!status.ready) return unreadableRunning("host-not-ready");
  if (status.hostVersion !== metadata.version) {
    return unreadableRunning("host-version-disagrees-pid");
  }

  // Bind the successful health response to the same pid-recorded process and
  // endpoint. A restart/recycled pid during the RPC is ambiguity, not proof.
  const after = await readHostPidMetadata(environment);
  if (!sameRunningMetadata(metadata, after)) {
    return unreadableRunning("host-restarted-during-probe");
  }
  const afterIdentity = await getPublishedProcessIdentityVerdict(
    metadata.pid,
    metadata.processStartIdentity,
  );
  if (afterIdentity !== "current") {
    return unreadableRunning("host-restarted-during-probe");
  }
  return {
    diagnosis: "classified",
    refusal: null,
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

/**
 * The host's own refusal text when an authenticated call was REFUSED by a host
 * that answered, or `null` for every other failure (Q19).
 *
 * `HostRpcError` is itself most of the discriminator: the transport only
 * constructs one from a host's error frame, so its mere existence proves the
 * connection opened, the handshake completed and the host replied. The code
 * narrows that to refusals of ADMISSION - the case where retrying until the
 * deadline cannot change the answer - and leaves every other RPC error on the
 * budgeted path, where a host that is still coming up belongs.
 */
function authenticatedRefusalReason(err: unknown): string | null {
  if (!(err instanceof HostRpcError)) return null;
  if (err.code !== "UNAUTHORIZED" && err.code !== "FORBIDDEN") return null;
  // The host's words, tagged with its own code so the operator can match the
  // CLI's report against the host log line that produced it - and CAPPED here,
  // at the one place this text is minted (cold review B).
  //
  // The cap is not cosmetic. This string is interpolated into the verify
  // failure's message, which `writer.fail` stores and
  // `host.status.operation.error` mirrors. The durable record is the
  // furthest-travelling consumer and the reason to bound at the source: as of
  // Q23 the GUI's `verification-refused` card renders fixed copy and does not
  // carry this text at all - which is exactly why bounding at a consumer would
  // have been the wrong place. So an unbounded, host-authored value sits
  // beside a token whose whole contract is that it is a closed set of fixed
  // strings, and bounding it here bounds every consumer at once.
  //
  // The sentence this replaces said the text was rendered in the GUI. That was
  // TRUE when written - the generic failed card interpolated `Update failed:
  // <host's words>` verbatim - and the Q23 GUI patch invalidated it for this
  // code alone; other codes still render their own message. Recorded rather
  // than quietly corrected, because "my justification decayed while the code
  // stayed right" is the failure this round kept finding, and a cap justified
  // by a consumer that no longer exists is the shape someone removes.
  const detail = err.message.slice(0, REFUSAL_REASON_MAX_CHARS);
  const suffix = err.message.length > REFUSAL_REASON_MAX_CHARS ? "..." : "";
  return `${err.code}: ${detail}${suffix}`;
}

/**
 * How much of a host's refusal text is carried.
 *
 * Long enough for the messages the field actually produces - the lane's
 * samples run to about 60 characters ("no applicable key found in the JSON Web
 * Key Set") - with room for a host that says more, and short enough that the
 * durable record cannot be flooded by one. The bound is sized for the record,
 * not for a card: see the mint above for why no GUI surface carries this text
 * for this code any more.
 */
const REFUSAL_REASON_MAX_CHARS = 200;

function absentRunning(
  diagnosis: RunningEvidenceDiagnosis,
): RunningObservation {
  return {
    evidence: { kind: "absent" },
    fingerprint: "absent",
    diagnosis,
    refusal: null,
  };
}

function unreadableRunning(
  diagnosis: RunningEvidenceDiagnosis,
): RunningObservation {
  return {
    evidence: { kind: "unreadable" },
    fingerprint: "unreadable",
    diagnosis,
    refusal: null,
  };
}

/**
 * The one unreadable reading that carries the host's own words with it (Q19).
 *
 * Separate from `unreadableRunning` rather than a parameter on it, so every
 * other refusal site keeps a `null` it cannot forget to pass and this one
 * cannot be reached without a reason to carry.
 */
function refusedRunning(reason: string): RunningObservation {
  return {
    evidence: { kind: "unreadable" },
    fingerprint: "unreadable",
    diagnosis: "host-refuses-authenticated-rpc",
    refusal: reason,
  };
}

function unreadableObservation(): AttemptRecoveryEvidenceObservation {
  return {
    evidence: {
      installed: { kind: "unreadable" },
      staged: { kind: "unreadable" },
      running: { kind: "unreadable" },
    },
    fingerprint: "unreadable",
    // The one diagnosis that is not about the host at all: this observation was
    // asked for a home that is not this environment's canonical one.
    runningDiagnosis: "host-home-mismatch",
    // Nothing was read, so there is no identity to report. A caller refreshing
    // a claim baseline from this observation carries the record's prior
    // baseline unchanged rather than inventing one.
    installIdentity: null,
    stageFingerprint: null,
    // Nothing was asked of any host, so there is no refusal to report.
    runningRefusal: null,
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
