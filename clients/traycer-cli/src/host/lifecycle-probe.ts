import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { promisify } from "node:util";
import type { Environment } from "../runner/environment";
import {
  ACTIVATION_JOURNAL_SUPPORTED_VERSIONS,
  decodeDurableRecord,
  fileReadToDurableBytes,
  isActivationPhase,
  TRANSITION_SUPPORTED_VERSIONS,
} from "@traycer-clients/shared/host-lifecycle";
import {
  ensureHostHomeDir,
  hostActivationJournalPath,
  hostPendingActivationPath,
  hostTransitionJournalPath,
  hostTransitionProbeMarkerPath,
  hostSubstratePath,
} from "../store/paths";
import type {
  DurableBytes,
  DurableRecord,
  FileReadResult,
  Layer0Frame,
  ActivationJournalRead,
  ActivationJournalStore,
  ActivationPhase,
  LifecycleActivationJournal,
  LifecycleTransitionJournal,
  ProbeMarker,
  ProbeSupervisorAttestation,
  SubstrateSnapshot,
  TransitionFailureClass,
  TransitionJournalRead,
  TransitionJournalStore,
  TransitionPhase,
} from "@traycer-clients/shared/host-lifecycle";

const MAX_LAYER0_FRAME_BYTES = 64 * 1024;
const execFileAsync = promisify(execFile);

export type Layer0FrameRead =
  | { readonly kind: "frame"; readonly frame: Layer0Frame }
  | { readonly kind: "indeterminate"; readonly reason: string };

export type LiveProbeContext = {
  readonly transitionId: string;
  readonly probeNonce: string;
  readonly serviceLabel: string;
};

/**
 * Consume exactly one 4-byte BE length-prefixed frame. `spawn(..., stdio[3])`
 * is a Unix-domain socket on macOS, so chunks may be arbitrarily split or
 * coalesced; one `data` event is never assumed to be a complete frame.
 */
export function readLayer0Frame(
  stream: Readable,
  timeoutMs: number,
): Promise<Layer0FrameRead> {
  return new Promise((resolve) => {
    let collected = Buffer.alloc(0);
    let settled = false;
    const finish = (result: Layer0FrameRead): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.removeListener("data", onData);
      stream.removeListener("error", onError);
      stream.removeListener("end", onEnd);
      stream.removeListener("close", onEnd);
      resolve(result);
    };
    const onError = (): void =>
      finish({ kind: "indeterminate", reason: "status-error" });
    const onEnd = (): void =>
      finish({ kind: "indeterminate", reason: "status-eof" });
    const onData = (chunk: Buffer | string): void => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      collected = Buffer.concat([collected, bytes]);
      if (collected.length < 4) return;
      const payloadLength = collected.readUInt32BE(0);
      if (payloadLength === 0 || payloadLength > MAX_LAYER0_FRAME_BYTES) {
        finish({ kind: "indeterminate", reason: "status-length-invalid" });
        return;
      }
      if (collected.length < payloadLength + 4) return;
      if (collected.length > payloadLength + 4) {
        finish({ kind: "indeterminate", reason: "status-multiple-frames" });
        return;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(collected.subarray(4).toString("utf8"));
      } catch {
        finish({ kind: "indeterminate", reason: "status-json-invalid" });
        return;
      }
      const frame = parseLayer0Frame(raw);
      finish(
        frame === null
          ? { kind: "indeterminate", reason: "status-shape-invalid" }
          : { kind: "frame", frame },
      );
    };
    const timer = setTimeout(() => {
      finish({ kind: "indeterminate", reason: "status-timeout" });
    }, timeoutMs);
    stream.on("data", onData);
    stream.once("error", onError);
    stream.once("end", onEnd);
    // A Unix-domain socket can close without an `end` event reaching the
    // readable side. That remains absence of evidence, never a decline.
    stream.once("close", onEnd);
  });
}

export async function writeProbeMarkerAtomically(
  environment: Environment,
  marker: ProbeMarker,
): Promise<void> {
  await ensureHostHomeDir(environment);
  await writeJsonAtomically(hostTransitionProbeMarkerPath(environment), marker);
}

/**
 * Attest from inside the live supervisor.  The reconciler intentionally never
 * repeats this query: a fast Layer-0 decline exits before a later reader could
 * observe the supervisor pid.
 */
export async function attestLaunchdSupervisorPid(
  serviceLabel: string,
  supervisorPid: number,
): Promise<ProbeSupervisorAttestation | null> {
  if (process.platform !== "darwin" || process.getuid === undefined) {
    return null;
  }
  const target = `gui/${process.getuid()}/${serviceLabel}`;
  try {
    const result = await execFileAsync("launchctl", ["print", target], {
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    const output = `${result.stdout}\n${result.stderr}`;
    const pidMatch = /^\s*pid\s*=\s*(\d+)\s*$/m.exec(output);
    if (pidMatch === null || Number(pidMatch[1]) !== supervisorPid) {
      return null;
    }
    return {
      serviceLabel,
      supervisorPid,
      capturedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export async function readProbeMarker(
  environment: Environment,
): Promise<ProbeMarker | null> {
  let text: string;
  try {
    text = await readFile(hostTransitionProbeMarkerPath(environment), "utf8");
  } catch {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  return parseProbeMarker(raw);
}

/**
 * Why the journal did not grant probe authority. Every arm is a state the
 * reader positively established, so `absent` is knowledge (`no-journal`) and
 * never gets folded in with "could not know" - that lives on the separate
 * `indeterminate` arm of `LiveProbeContextRead`.
 */
export type ProbeAuthorityDenial =
  | "no-journal"
  | "not-a-reclaim"
  | "phase-not-awaiting-probe"
  | "label-not-expected"
  | "transition-id-mismatch"
  | "probe-nonce-mismatch"
  | "probe-deadline-elapsed";

export type LiveProbeContextRead =
  | { readonly kind: "authorised"; readonly context: LiveProbeContext }
  | { readonly kind: "unauthorised"; readonly reason: ProbeAuthorityDenial }
  /**
   * The journal could not be decoded at all - corrupt bytes, an unreadable
   * file, or a schema version a newer desktop wrote. Behaviourally identical
   * to `unauthorised` (no bypass either way, which is the safe direction),
   * but kept a distinct arm so a v2 journal is a diagnosis rather than a
   * probe that silently never runs.
   */
  | { readonly kind: "indeterminate"; readonly cause: string };

/**
 * The incumbent bypass is legal only for the journal's own authorised label.
 * A stale marker/context therefore cannot turn an ordinary service start into
 * a probe that races a healthy raw incumbent.
 *
 * `now` is the ISO instant to judge `probeDeadlineAt` against, supplied by
 * the caller so the bound is testable.
 */
export async function readLiveProbeContext(
  environment: Environment,
  input: LiveProbeContext,
  now: string,
): Promise<LiveProbeContextRead> {
  const record = await readTransitionJournalForProbe(environment);
  if (record.kind !== "valid") return notAuthorised(record);
  const journal = record.value;
  const authority = probeAuthorityDenial(journal, input.serviceLabel, now);
  if (authority !== null) return { kind: "unauthorised", reason: authority };
  if (journal.transitionId !== input.transitionId) {
    return { kind: "unauthorised", reason: "transition-id-mismatch" };
  }
  if (journal.probeNonce !== input.probeNonce) {
    return { kind: "unauthorised", reason: "probe-nonce-mismatch" };
  }
  return { kind: "authorised", context: input };
}

/**
 * Installed launchd registrations intentionally carry only their immutable
 * service label.  The write-ahead `reclaim-awaiting-probe` journal supplies
 * per-attempt authority before the probe is launched, avoiding stale
 * transition ids in a plist while still bypassing the incumbent guard for
 * the journal's own label.
 */
export async function readLiveProbeContextForServiceLabel(
  environment: Environment,
  serviceLabel: string,
  now: string,
): Promise<LiveProbeContextRead> {
  const record = await readTransitionJournalForProbe(environment);
  if (record.kind !== "valid") return notAuthorised(record);
  const journal = record.value;
  const authority = probeAuthorityDenial(journal, serviceLabel, now);
  if (authority !== null) return { kind: "unauthorised", reason: authority };
  return {
    kind: "authorised",
    context: {
      transitionId: journal.transitionId,
      probeNonce: journal.probeNonce,
      serviceLabel,
    },
  };
}

/**
 * The authority checks both entrypoints share, `probeDeadlineAt` included.
 *
 * The deadline is not decoration: probe mode makes `host start` skip the
 * incumbent check entirely, and recovery from an interrupted reclaim is
 * trigger-bounded, so a journal stranded at `reclaim-awaiting-probe` would
 * otherwise re-authorise that bypass at every single login, indefinitely,
 * stacking a fresh supervisor onto the live fallback host each time. The
 * reconciler already fails an elapsed probe as `indeterminate`
 * (transition/reconciler.ts) - this applies the same bound at the login-time
 * path that actually grants the bypass, with the same lexicographic ISO
 * comparison so the two cannot disagree about an edge instant.
 */
function probeAuthorityDenial(
  journal: LifecycleTransitionJournal,
  serviceLabel: string,
  now: string,
): ProbeAuthorityDenial | null {
  if (journal.kind !== "reclaim") return "not-a-reclaim";
  if (journal.phase !== "reclaim-awaiting-probe") {
    return "phase-not-awaiting-probe";
  }
  if (!journal.expectedIdentities.includes(serviceLabel)) {
    return "label-not-expected";
  }
  if (journal.probeDeadlineAt !== null && now >= journal.probeDeadlineAt) {
    return "probe-deadline-elapsed";
  }
  return null;
}

function notAuthorised(
  record: Exclude<
    DurableRecord<LifecycleTransitionJournal>,
    { readonly kind: "valid" }
  >,
): LiveProbeContextRead {
  if (record.kind === "absent") {
    return { kind: "unauthorised", reason: "no-journal" };
  }
  if (record.kind === "unsupported-version") {
    return {
      kind: "indeterminate",
      cause: `journal-version-${record.version}`,
    };
  }
  if (record.kind === "unreadable") {
    return { kind: "indeterminate", cause: `unreadable: ${record.cause}` };
  }
  return { kind: "indeterminate", cause: "corrupt" };
}

async function readTransitionJournalForProbe(
  environment: Environment,
): Promise<DurableRecord<LifecycleTransitionJournal>> {
  return decodeTransitionJournalBytes(
    await readDurableBytes(hostTransitionJournalPath(environment)),
  );
}

/** Concrete temp+rename persistence adapter for the injected shared store. */
export function createTransitionJournalStore(
  environment: Environment,
): TransitionJournalStore {
  return {
    readJournal: async (): Promise<TransitionJournalRead> => {
      const record = await readTransitionJournalForProbe(environment);
      if (record.kind === "valid") {
        return { kind: "valid", journal: record.value };
      }
      if (record.kind === "absent") return { kind: "absent" };
      return { kind: "invalid", reason: describeDecodeFailure(record) };
    },
    writeJournal: async (journal): Promise<void> => {
      await ensureHostHomeDir(environment);
      await writeJsonAtomically(
        hostTransitionJournalPath(environment),
        journal,
      );
    },
    writeSubstrate: async (record): Promise<void> => {
      await ensureHostHomeDir(environment);
      await writeJsonAtomically(hostSubstratePath(environment), record);
    },
    removeProbeMarker: async (transitionId): Promise<void> => {
      const marker = await readProbeMarker(environment);
      if (marker === null || marker.transitionId !== transitionId) return;
      await rm(hostTransitionProbeMarkerPath(environment), { force: true });
    },
  };
}

/**
 * Concrete activation persistence.  This is deliberately unwired: T8 owns
 * consumer/command cutover, while T7 establishes the crash-safe store that
 * those consumers will use.  Every journal write uses the exact temp+rename
 * convention as transition.json.
 */
export function createActivationJournalStore(
  environment: Environment,
): ActivationJournalStore {
  return {
    readJournal: async (): Promise<ActivationJournalRead> => {
      const record = decodeDurableRecord(
        await readDurableBytes(hostActivationJournalPath(environment)),
        ACTIVATION_JOURNAL_SUPPORTED_VERSIONS,
        parseActivationJournalPayload,
      );
      if (record.kind === "valid") {
        return { kind: "valid", journal: record.value };
      }
      if (record.kind === "absent") return { kind: "absent" };
      return { kind: "invalid", reason: describeDecodeFailure(record) };
    },
    writeJournal: async (journal): Promise<void> => {
      await ensureHostHomeDir(environment);
      await writeJsonAtomically(
        hostActivationJournalPath(environment),
        journal,
      );
    },
    writePendingActivation: async (pending): Promise<void> => {
      await ensureHostHomeDir(environment);
      await writeJsonAtomically(hostPendingActivationPath(environment), {
        v: 1,
        ...pending,
      });
    },
    clearPendingActivation: async (): Promise<void> => {
      await rm(hostPendingActivationPath(environment), { force: true });
    },
  };
}

/**
 * One read path for every durable lifecycle record this module owns.
 *
 * The CLI used to carry a second, lossier reader beside the store adapters:
 * it returned `T | null`, so *no journal*, *corrupt journal* and *a journal at
 * a schema version a newer desktop wrote* all arrived as the same value, and
 * a v2 file made the reclaim probe silently never run with nothing anywhere
 * to say why. Routing every read through the shared total decoder
 * (`decodeDurableRecord`, the same one `shared/host-lifecycle/macos/probe.ts`
 * uses against this same `transition.json`) keeps the plan's five-arm algebra
 * intact and leaves exactly one place that turns bytes into a record.
 */
async function readDurableBytes(path: string): Promise<DurableBytes> {
  let result: FileReadResult;
  try {
    result = { kind: "ok", text: await readFile(path, "utf8") };
  } catch (error) {
    result = isNotFoundError(error)
      ? { kind: "not-found" }
      : { kind: "error", cause: describeReadError(error) };
  }
  return fileReadToDurableBytes(result);
}

function decodeTransitionJournalBytes(
  bytes: DurableBytes,
): DurableRecord<LifecycleTransitionJournal> {
  // The shared `decodeTransitionJournal` decodes the T3 world-probe
  // projection, which drops `kind`, `probeDeadlineAt` and `terminal` - the
  // three fields probe authority is decided on. Same total decoder, same
  // version gate, richer parser.
  return decodeDurableRecord(
    bytes,
    TRANSITION_SUPPORTED_VERSIONS,
    parseTransitionJournalPayload,
  );
}

function describeDecodeFailure(
  record: Exclude<DurableRecord<unknown>, { readonly kind: "valid" }>,
): string {
  if (record.kind === "absent") return "absent";
  if (record.kind === "unreadable") return `unreadable: ${record.cause}`;
  if (record.kind === "unsupported-version") {
    return `unsupported-version: ${record.version}`;
  }
  return "corrupt";
}

function describeReadError(error: unknown): string {
  if (isRecord(error) && typeof error.code === "string") return error.code;
  return error instanceof Error ? error.message : String(error);
}

export async function writeJsonAtomically(
  destination: string,
  value: object,
): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  const temporary = join(
    dirname(destination),
    `.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function parseLayer0Frame(value: unknown): Layer0Frame | null {
  if (!isRecord(value) || typeof value.attemptId !== "string") return null;
  if (value.layer0 === "acquired") {
    return { attemptId: value.attemptId, layer0: "acquired" };
  }
  if (value.layer0 === "declined") {
    const incumbentEvidence = parseIncumbentEvidence(value.incumbentEvidence);
    return incumbentEvidence === null
      ? null
      : { attemptId: value.attemptId, layer0: "declined", incumbentEvidence };
  }
  if (value.layer0 === "degraded" && typeof value.evidence === "string") {
    const cause = parseUnavailableCause(value.cause);
    return cause === null
      ? null
      : {
          attemptId: value.attemptId,
          layer0: value.layer0,
          cause,
          evidence: value.evidence,
        };
  }
  return null;
}

function parseIncumbentEvidence(
  value: unknown,
):
  | Extract<Layer0Frame, { readonly layer0: "declined" }>["incumbentEvidence"]
  | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  if (
    value.kind === "pid-metadata" &&
    typeof value.pid === "number" &&
    typeof value.hostId === "string" &&
    typeof value.startedAt === "string"
  ) {
    return {
      kind: "pid-metadata",
      pid: value.pid,
      hostId: value.hostId,
      startedAt: value.startedAt,
    };
  }
  if (
    value.kind === "held-retry-window" &&
    typeof value.lockPath === "string" &&
    typeof value.observedForMs === "number"
  ) {
    return {
      kind: "held-retry-window",
      lockPath: value.lockPath,
      observedForMs: value.observedForMs,
    };
  }
  return null;
}

function parseUnavailableCause(
  value: unknown,
): Extract<Layer0Frame, { readonly layer0: "degraded" }>["cause"] | null {
  // Every string cause the host can emit. Enumerated rather than pattern
  // matched so a new one arriving from a newer host decodes as `null` (the
  // frame is ignored, the probe stays inconclusive) rather than as a
  // confidently-wrong cause the CLI then reports to a user.
  if (
    value === "addon-load-failed" ||
    value === "fs-unsupported" ||
    value === "lock-path-invalid" ||
    value === "sharing-violation-unattested"
  ) {
    return value;
  }
  if (
    isRecord(value) &&
    value.kind === "os-error" &&
    typeof value.syscall === "string" &&
    typeof value.code === "string" &&
    (typeof value.fsType === "string" || value.fsType === null)
  ) {
    return {
      kind: "os-error",
      syscall: value.syscall,
      code: value.code,
      fsType: value.fsType,
    };
  }
  return null;
}

function parseProbeMarker(value: unknown): ProbeMarker | null {
  if (!isRecord(value) || value.v !== 1) return null;
  if (
    typeof value.transitionId !== "string" ||
    typeof value.probeNonce !== "string" ||
    typeof value.serviceLabel !== "string" ||
    typeof value.supervisorPid !== "number" ||
    !isRecord(value.attestation)
  ) {
    return null;
  }
  if (
    value.attestation.serviceLabel !== value.serviceLabel ||
    value.attestation.supervisorPid !== value.supervisorPid ||
    typeof value.attestation.capturedAt !== "string" ||
    !isRecord(value.outcome)
  ) {
    return null;
  }
  const outcome = parseProbeOutcome(value.outcome);
  return outcome === null
    ? null
    : {
        v: 1,
        transitionId: value.transitionId,
        probeNonce: value.probeNonce,
        serviceLabel: value.serviceLabel,
        supervisorPid: value.supervisorPid,
        attestation: {
          serviceLabel: value.serviceLabel,
          supervisorPid: value.supervisorPid,
          capturedAt: value.attestation.capturedAt,
        },
        outcome,
      };
}

function parseProbeOutcome(
  value: Record<string, unknown>,
): ProbeMarker["outcome"] | null {
  if (
    value.kind === "awaiting-readiness" &&
    typeof value.attemptId === "string"
  ) {
    const degradation = parseLayer0Degradation(value.degradation);
    if (degradation === undefined) return null;
    return {
      kind: "awaiting-readiness",
      attemptId: value.attemptId,
      degradation,
    };
  }
  if (value.kind === "terminal" && typeof value.reason === "string") {
    return { kind: "terminal", reason: value.reason };
  }
  if (value.kind === "lock-declined" && typeof value.attemptId === "string") {
    const incumbentEvidence = parseIncumbentEvidence(value.incumbentEvidence);
    return incumbentEvidence === null
      ? null
      : {
          kind: "lock-declined",
          attemptId: value.attemptId,
          incumbentEvidence,
        };
  }
  if (
    value.kind === "unavailable" &&
    typeof value.attemptId === "string" &&
    typeof value.evidence === "string"
  ) {
    const cause = parseUnavailableCause(value.cause);
    return cause === null
      ? null
      : {
          kind: "unavailable",
          attemptId: value.attemptId,
          cause,
          evidence: value.evidence,
        };
  }
  return null;
}

function parseLayer0Degradation(
  value: unknown,
):
  | Extract<
      ProbeMarker["outcome"],
      { readonly kind: "awaiting-readiness" }
    >["degradation"]
  | undefined {
  if (value === undefined || value === null) return null;
  if (!isRecord(value) || typeof value.evidence !== "string") {
    return undefined;
  }
  const cause = parseUnavailableCause(value.cause);
  return cause === null ? undefined : { cause, evidence: value.evidence };
}

// `v` is already gated by `decodeDurableRecord` against
// TRANSITION_SUPPORTED_VERSIONS, which is why an unsupported version reaches
// the caller as its own arm instead of being flattened into "corrupt" here.
function parseTransitionJournalPayload(
  value: Readonly<Record<string, unknown>>,
): LifecycleTransitionJournal | null {
  if (
    typeof value.transitionId !== "string" ||
    typeof value.probeNonce !== "string" ||
    (value.kind !== "fallback" && value.kind !== "reclaim") ||
    (value.from !== "smappservice" && value.from !== "raw-fallback") ||
    (value.to !== "smappservice" && value.to !== "raw-fallback") ||
    typeof value.phase !== "string" ||
    !Array.isArray(value.expectedIdentities) ||
    !value.expectedIdentities.every(
      (identity) => typeof identity === "string",
    ) ||
    typeof value.startedAt !== "string" ||
    !isStringOrNull(value.probeDeadlineAt) ||
    !isRecord(value.governor)
  ) {
    return null;
  }
  // We use the shared writer as the authority for phase/governor construction;
  // retain a strict but forward-compatible parser for an interrupted write.
  const phase = parseTransitionPhase(value.phase);
  const governor = parseGovernor(value.governor);
  const terminal = parseTerminal(value.terminal);
  if (phase === null || governor === null || terminal === undefined)
    return null;
  return {
    v: 1,
    transitionId: value.transitionId,
    probeNonce: value.probeNonce,
    kind: value.kind,
    from: value.from,
    to: value.to,
    phase,
    expectedIdentities: value.expectedIdentities,
    compensation:
      value.compensation === "reprovision-fallback" ? value.compensation : null,
    startedAt: value.startedAt,
    probeDeadlineAt: value.probeDeadlineAt,
    governor,
    terminal,
  };
}

function parseActivationJournalPayload(
  value: Readonly<Record<string, unknown>>,
): LifecycleActivationJournal | null {
  if (
    typeof value.fromGeneration !== "string" ||
    typeof value.toGeneration !== "string" ||
    // The host-issued shutdown authority that has to survive the crash window
    // the `committing-stop` record deliberately opens between `claimStop` and
    // `commitStop`. Field-by-field parsers DROP what they do not name, and a
    // resume that reads a journal whose token silently vanished re-commits
    // with dead authority and fails at the one phase the journal promised was
    // resumable - so this is required, not tolerated as absent.
    !isStringOrNull(value.stopClaimToken) ||
    !isRecord(value.governor)
  ) {
    return null;
  }
  const phase = parseActivationPhase(value.phase);
  const governor = parseGovernor(value.governor);
  const attempt = parseActivationAttempt(value.attempt);
  const rollbackFailure = parseActivationFailureOrNull(value.rollbackFailure);
  const terminal = parseActivationTerminal(value.terminal);
  if (
    phase === null ||
    governor === null ||
    attempt === undefined ||
    rollbackFailure === undefined ||
    terminal === undefined
  ) {
    return null;
  }
  return {
    v: 1,
    fromGeneration: value.fromGeneration,
    toGeneration: value.toGeneration,
    phase,
    stopClaimToken: value.stopClaimToken,
    attempt,
    rollbackFailure,
    governor,
    terminal,
  };
}

function parseGovernor(
  value: Record<string, unknown>,
): LifecycleTransitionJournal["governor"] | null {
  if (
    typeof value.attemptCount !== "number" ||
    !isStringOrNull(value.lastAttemptedBuildId) ||
    !isStringOrNull(value.lastAttemptedCDHash) ||
    !isStringOrNull(value.failureClass) ||
    !isStringOrNull(value.nextEligibleAt) ||
    !isStringOrNull(value.breaker) ||
    !isStringOrNull(value.lastSustainedHealthAt)
  ) {
    return null;
  }
  return {
    lastAttemptedBuildId: value.lastAttemptedBuildId,
    lastAttemptedCDHash: value.lastAttemptedCDHash,
    failureClass: value.failureClass,
    attemptCount: value.attemptCount,
    nextEligibleAt: value.nextEligibleAt,
    breaker: value.breaker,
    lastSustainedHealthAt: value.lastSustainedHealthAt,
  };
}

function parseTerminal(
  value: unknown,
): LifecycleTransitionJournal["terminal"] | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  if (
    value.outcome !== "done" &&
    value.outcome !== "failed" &&
    value.outcome !== "compensated"
  ) {
    return undefined;
  }
  const failureClass =
    value.failureClass === null
      ? null
      : parseTransitionFailureClass(value.failureClass);
  if (failureClass === null && value.failureClass !== null) return undefined;
  return {
    outcome: value.outcome,
    failureClass,
  };
}

function parseTransitionPhase(value: unknown): TransitionPhase | null {
  switch (value) {
    case "fallback-journaled":
    case "fallback-attesting-slot":
    case "fallback-provisioning":
    case "fallback-evicting-agent":
    case "fallback-committing":
    case "reclaim-probing":
    case "reclaim-awaiting-probe":
    case "reclaim-provisioning-agent":
    case "reclaim-committing-shutdown":
    case "reclaim-verifying-agent":
    case "reclaim-cleaning-fallback":
    case "reclaim-compensating-fallback":
    case "done":
    case "failed":
    case "compensated":
      return value;
    default:
      return null;
  }
}

function parseActivationPhase(value: unknown): ActivationPhase | null {
  return isActivationPhase(value) ? value : null;
}

function parseTransitionFailureClass(
  value: unknown,
): TransitionFailureClass | null {
  switch (value) {
    case "lwcr":
    case "probe-terminal":
    case "layer0-unavailable":
    case "readiness":
    case "stale-precondition":
    case "indeterminate":
    case "unknown":
      return value;
    default:
      return null;
  }
}

function parseActivationFailureClass(
  value: unknown,
): Exclude<LifecycleActivationJournal["rollbackFailure"], null> | null {
  switch (value) {
    case "readiness":
    case "stale-precondition":
    case "indeterminate":
    case "unknown":
      return value;
    default:
      return null;
  }
}

function parseActivationFailureOrNull(
  value: unknown,
): LifecycleActivationJournal["rollbackFailure"] | undefined {
  if (value === null) return null;
  const failureClass = parseActivationFailureClass(value);
  return failureClass === null ? undefined : failureClass;
}

function parseActivationAttempt(
  value: unknown,
): LifecycleActivationJournal["attempt"] | undefined {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    value.state !== "installed-not-ready" ||
    typeof value.attemptId !== "string"
  ) {
    return undefined;
  }
  return { state: "installed-not-ready", attemptId: value.attemptId };
}

function parseActivationTerminal(
  value: unknown,
): LifecycleActivationJournal["terminal"] | undefined {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    (value.outcome !== "done" && value.outcome !== "failed")
  ) {
    return undefined;
  }
  // `failurePhase` names the non-terminal phase that produced the outcome, so
  // a failed activation reports where it died rather than just that it did.
  // Parsed, never defaulted - dropping it here would leave the caller with a
  // terminal record that cannot say what failed.
  const failurePhase =
    value.failurePhase === null
      ? null
      : parseActivationPhase(value.failurePhase);
  if (failurePhase === null && value.failurePhase !== null) return undefined;
  if (value.outcome === "done" && value.failureClass === null) {
    return { outcome: "done", failureClass: null, failurePhase };
  }
  if (value.outcome === "failed") {
    const failureClass = parseActivationFailureClass(value.failureClass);
    return failureClass === null
      ? undefined
      : { outcome: "failed", failureClass, failurePhase };
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringOrNull(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

function isNotFoundError(error: unknown): boolean {
  return (
    isRecord(error) && typeof error.code === "string" && error.code === "ENOENT"
  );
}
