/**
 * Windows never derive their own effective host; they report transport evidence and render the authority's decision.
 * attachSeq is engine-allocated; a client attaches at most once; allocation advances the supersession fence to the latest issued seq.
 */

import {
  clientCompatibilityRequirementSchema,
  type ClientCompatibilityRequirement,
} from "@traycer/protocol/framework/client-identity";

// Re-export: `SelectionIncompatibility` owns this member; importing it from protocol splits the type.
export type { ClientCompatibilityRequirement };

/** Major version. Additive-only within a major. */
export const SELECTION_AUTHORITY_CONTRACT_VERSION = 1;

/**
 * Epoch-rejection detail, or `null` when absent or malformed.
 * Absent covers hosts that predate the gate and incompatibilities that are not epoch rejections.
 */
function parseClientCompatibility(
  value: unknown,
): ClientCompatibilityRequirement | null {
  if (value === undefined || value === null) return null;
  const parsed = clientCompatibilityRequirementSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isSafeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Diagnostic attribution only; aggregation never branches on it. `"unknown"` maps members from a newer same-major peer. */
export type SelectionTransportKind = "local-ws" | "remote-relay" | "unknown";

export function parseTransportKind(value: unknown): SelectionTransportKind {
  return value === "local-ws" || value === "remote-relay" ? value : "unknown";
}

/**
 * `confirmed-refusal` is a real transport refusal, not a directory DTO gate; `plan-restricted` is the only provenance for `dead("plan-restricted")`.
 * Count each (incarnation, attemptId) at most once; live sessions suppress death accumulation; `indeterminate` never advances a counter.
 */
export type SelectionDialEvidence =
  | {
      kind: "dial";
      hostId: string;
      attemptId: string;
      outcome: "success" | "timeout" | "indeterminate";
      transportKind: SelectionTransportKind;
      /** Diagnostic only; identity and ordering come from attemptId/revisions. */
      at: number;
    }
  | {
      kind: "dial";
      hostId: string;
      attemptId: string;
      outcome: "confirmed-refusal";
      refusalDetail: "plan-restricted" | null;
      transportKind: SelectionTransportKind;
      /** Diagnostic only; identity and ordering come from attemptId/revisions. */
      at: number;
    };

    /**
     * Keyed by (reporter incarnation, sessionId). `lost` before `established` tombstones the id; stale incarnation drops.
     * Attach rotation replaces the outgoing incarnation's sessions atomically.
     */
export interface SelectionSessionEvidence {
  kind: "session";
  hostId: string;
  sessionId: string;
  transition: "established" | "lost";
  transportKind: SelectionTransportKind;
  /** Diagnostic only; identity and ordering come from attemptId/revisions. */
  at: number;
}

export interface SelectionIncompatibility {
  code: string;
  hostVersion: string | null;
  minSupportedVersion: string | null;
  /**
   * Present only for a compatibility-epoch refusal, not a method-manifest disagreement.
   * Epoch rejection must not offer "update the host"; the host is the newer leg.
   */
  clientCompatibility: ClientCompatibilityRequirement | null;
}

/**
 * Host-scoped; freshness is connection generation, not version strings.
 * A latest-session verdict supersedes earlier ones; `probedOnSessionId: null` is weakest; cleared on fleet removal.
 */
export type SelectionCompatEvidence =
  | {
      kind: "compat";
      hostId: string;
      probedOnSessionId: string | null;
      hostVersion: string | null;
      verdict: "compatible";
      incompatibility: null;
      at: number;
    }
  | {
      kind: "compat";
      hostId: string;
      probedOnSessionId: string | null;
      hostVersion: string | null;
      verdict: "incompatible";
      incompatibility: SelectionIncompatibility;
      at: number;
    };

    /**
     * First (hostId, tombstoneId) anchors one episode; duplicates never extend it. Seen-ids last for the authority process lifetime.
     * `restarting-expected` is a hold, not a candidate; `expiresAt` is display only.
     */
export interface SelectionRestartIntentEvidence {
  kind: "restart-intent";
  hostId: string;
  tombstoneId: string;
  expiresAt: number | null;
  /** Diagnostic only; identity and ordering come from attemptId/revisions. */
  at: number;
}

/** Unparseable reports are dropped with a debug log, never an error. */
export type SelectionEvidenceReport =
  | SelectionDialEvidence
  | SelectionSessionEvidence
  | SelectionCompatEvidence
  | SelectionRestartIntentEvidence;

export function parseSelectionEvidenceReport(
  raw: unknown,
): SelectionEvidenceReport | null {
  if (!isRecord(raw)) return null;
  const record = raw;
  const hostId = record["hostId"];
  const at = record["at"];
  if (typeof hostId !== "string" || !isFiniteNumber(at)) return null;
  const transportKind = parseTransportKind(record["transportKind"]);
  switch (record["kind"]) {
    case "dial": {
      const attemptId = record["attemptId"];
      if (typeof attemptId !== "string") return null;
      const outcome = record["outcome"];
      if (outcome === "confirmed-refusal") {
        const refusalDetail =
          record["refusalDetail"] === "plan-restricted"
            ? ("plan-restricted" as const)
            : null;
        return {
          kind: "dial",
          hostId,
          attemptId,
          outcome,
          refusalDetail,
          transportKind,
          at,
        };
      }
      const inertOutcome =
        outcome === "success" || outcome === "timeout"
          ? outcome
          : ("indeterminate" as const);
      return {
        kind: "dial",
        hostId,
        attemptId,
        outcome: inertOutcome,
        transportKind,
        at,
      };
    }
    case "session": {
      const sessionId = record["sessionId"];
      const transition = record["transition"];
      if (typeof sessionId !== "string") return null;
      if (transition !== "established" && transition !== "lost") return null;
      return {
        kind: "session",
        hostId,
        sessionId,
        transition,
        transportKind,
        at,
      };
    }
    case "compat": {
      const probedOnSessionId =
        typeof record["probedOnSessionId"] === "string"
          ? record["probedOnSessionId"]
          : null;
      const hostVersion =
        typeof record["hostVersion"] === "string"
          ? record["hostVersion"]
          : null;
      if (record["verdict"] === "compatible") {
        return {
          kind: "compat",
          hostId,
          probedOnSessionId,
          hostVersion,
          verdict: "compatible",
          incompatibility: null,
          at,
        };
      }
      if (record["verdict"] === "incompatible") {
        const detailRecord = record["incompatibility"];
        if (!isRecord(detailRecord)) return null;
        if (typeof detailRecord["code"] !== "string") return null;
        return {
          kind: "compat",
          hostId,
          probedOnSessionId,
          hostVersion,
          verdict: "incompatible",
          incompatibility: {
            code: detailRecord["code"],
            hostVersion:
              typeof detailRecord["hostVersion"] === "string"
                ? detailRecord["hostVersion"]
                : null,
            minSupportedVersion:
              typeof detailRecord["minSupportedVersion"] === "string"
                ? detailRecord["minSupportedVersion"]
                : null,
            // Drop a malformed clientCompatibility to null rather than failing the whole verdict.
            clientCompatibility: parseClientCompatibility(
              detailRecord["clientCompatibility"],
            ),
          },
          at,
        };
      }
      return null;
    }
    case "restart-intent": {
      const tombstoneId = record["tombstoneId"];
      if (typeof tombstoneId !== "string") return null;
      return {
        kind: "restart-intent",
        hostId,
        tombstoneId,
        expiresAt: isFiniteNumber(record["expiresAt"])
          ? record["expiresAt"]
          : null,
        at,
      };
    }
    default:
      return null;
  }
}

export type HostLeaseStatus =
  | "connecting"
  | "ready"
  | "degraded"
  | "restarting-expected"
  | "dead";

export type HostLeaseDeadState =
  | { reason: "offline" }
  | { reason: "plan-restricted" }
  | { reason: "removed" }
  | { reason: "incompatible"; detail: SelectionIncompatibility };

export type HostLeaseSnapshot =
  | {
      hostId: string;
      status: "connecting" | "ready" | "degraded" | "restarting-expected";
      dead: null;
    }
  | {
      hostId: string;
      status: "dead";
      dead: HostLeaseDeadState;
    };

    /**
     * Exhaustive value equality. The engine emission gate and `useHostLease` must share this function.
     * A second copy on either side silently drops or churns updates.
     */
export function leaseEquals(
  a: HostLeaseSnapshot,
  b: HostLeaseSnapshot,
): boolean {
  if (a.hostId !== b.hostId || a.status !== b.status) return false;
  if (a.dead === null || b.dead === null) return a.dead === b.dead;
  if (a.dead.reason !== b.dead.reason) return false;
  if (a.dead.reason !== "incompatible" || b.dead.reason !== "incompatible") {
    return true;
  }
  return (
    a.dead.detail.code === b.dead.detail.code &&
    a.dead.detail.hostVersion === b.dead.detail.hostVersion &&
    a.dead.detail.minSupportedVersion === b.dead.detail.minSupportedVersion &&
    clientCompatibilityEquals(
      a.dead.detail.clientCompatibility,
      b.dead.detail.clientCompatibility,
    )
  );
}

/**
 * Member-by-member; objects cross IPC so reference equality is always false.
 * Epoch path often has null versions and a bare incompatible code, so skipping this drops a real verdict change.
 */
function clientCompatibilityEquals(
  a: ClientCompatibilityRequirement | null,
  b: ClientCompatibilityRequirement | null,
): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.minimumCompatibilityEpoch === b.minimumCompatibilityEpoch &&
    a.observedCompatibilityEpoch === b.observedCompatibilityEpoch &&
    a.failure === b.failure &&
    a.observedClientKind === b.observedClientKind &&
    a.observedClientAppVersion === b.observedClientAppVersion &&
    a.observedClientAppVersionStatus === b.observedClientAppVersionStatus &&
    a.minimumKnownClientAppVersion === b.minimumKnownClientAppVersion &&
    a.upgradeChannel === b.upgradeChannel &&
    // Optional member: absent and undefined compare equal; `"stable"` vs absent must not.
    a.hostReleaseChannel === b.hostReleaseChannel
  );
}

export function parseLeaseSnapshot(raw: unknown): HostLeaseSnapshot | null {
  if (!isRecord(raw)) return null;
  const record = raw;
  const hostId = record["hostId"];
  if (typeof hostId !== "string") return null;
  const status = record["status"];
  if (status === "dead") {
    const deadRecord = record["dead"];
    if (!isRecord(deadRecord)) return null;
    const reason = deadRecord["reason"];
    if (reason === "incompatible") {
      const detailRecord = deadRecord["detail"];
      if (!isRecord(detailRecord)) return null;
      if (typeof detailRecord["code"] !== "string") return null;
      return {
        hostId,
        status: "dead",
        dead: {
          reason: "incompatible",
          detail: {
            code: detailRecord["code"],
            hostVersion:
              typeof detailRecord["hostVersion"] === "string"
                ? detailRecord["hostVersion"]
                : null,
            minSupportedVersion:
              typeof detailRecord["minSupportedVersion"] === "string"
                ? detailRecord["minSupportedVersion"]
                : null,
            // Same drop-to-null rule: losing epoch detail is cheaper than losing the dead lease.
            clientCompatibility: parseClientCompatibility(
              detailRecord["clientCompatibility"],
            ),
          },
        },
      };
    }
    const safeReason =
      reason === "plan-restricted" || reason === "removed" ? reason : "offline";
    return { hostId, status: "dead", dead: { reason: safeReason } };
  }
  const safeStatus =
    status === "ready" ||
    status === "degraded" ||
    status === "restarting-expected"
      ? status
      : "connecting";
  return { hostId, status: safeStatus, dead: null };
}

/** Toast only for `failover`/`recovery` with an effective change. Unknown members map to `failover`. */
export type SelectionChangeCause =
  | "activate"
  | "deregister-clear"
  | "failover"
  | "recovery"
  | "fleet-shift";

  /**
   * One composite snapshot per event; consumers must not invent phase predicates or infer switches from leases.
   * Re-point only when `effectiveHostId` differs from the last applied value.
   */
export interface SelectionChange {
  preferredHostId: string | null;
  /** Preferred, else local host, else null. Windows cannot derive this. */
  targetHostId: string | null;
  effectiveHostId: string | null;
  previousEffectiveHostId: string | null;
  cause: SelectionChangeCause;
}

export function parseSelectionChange(raw: unknown): SelectionChange | null {
  if (!isRecord(raw)) return null;
  const record = raw;
  const readId = (key: string): string | null | undefined => {
    const value = record[key];
    if (value === null || typeof value === "string") return value;
    return undefined;
  };
  const preferredHostId = readId("preferredHostId");
  const targetHostId = readId("targetHostId");
  const effectiveHostId = readId("effectiveHostId");
  const previousEffectiveHostId = readId("previousEffectiveHostId");
  if (
    preferredHostId === undefined ||
    targetHostId === undefined ||
    effectiveHostId === undefined ||
    previousEffectiveHostId === undefined
  ) {
    return null;
  }
  const cause = record["cause"];
  const safeCause: SelectionChangeCause =
    cause === "activate" ||
    cause === "deregister-clear" ||
    cause === "recovery" ||
    cause === "fleet-shift"
      ? cause
      : "failover";
  return {
    preferredHostId,
    targetHostId,
    effectiveHostId,
    previousEffectiveHostId,
    cause: safeCause,
  };
}

export type ActivateRefusalReason =
  | "unknown-host"
  | "incompatible"
  | "not-attached"
  | "persist-failed"
  | "unrecognized";

export type ActivateResult =
  | { ok: true }
  | { ok: false; reason: ActivateRefusalReason };

export function parseActivateResult(raw: unknown): ActivateResult {
  if (isRecord(raw)) {
    const record = raw;
    if (record["ok"] === true) return { ok: true };
    const reason = record["reason"];
    return {
      ok: false,
      reason:
        reason === "unknown-host" ||
        reason === "incompatible" ||
        reason === "not-attached" ||
        reason === "persist-failed"
          ? reason
          : "unrecognized",
    };
  }
  return { ok: false, reason: "unrecognized" };
}

export interface SelectionAuthoritySnapshot {
  contractVersion: number;
  revision: number;
  preferredHostId: string | null;
  targetHostId: string | null;
  effectiveHostId: string | null;
  leases: readonly HostLeaseSnapshot[];
}

export interface SelectionRevisioned<T> {
  revision: number;
  change: T;
}

/** Emitted at its own revision after identity-transition commit so a state event cannot shadow it. */
export interface SelectionReattachRequired {
  revision: number;
}

export function parseReattachRequired(
  raw: unknown,
): SelectionReattachRequired | null {
  if (!isRecord(raw)) return null;
  if (!isSafeCount(raw["revision"])) return null;
  return { revision: raw["revision"] };
}

export function parseRevisionedSelectionChange(
  raw: unknown,
): SelectionRevisioned<SelectionChange> | null {
  if (!isRecord(raw)) return null;
  if (!isSafeCount(raw["revision"])) return null;
  const change = parseSelectionChange(raw["change"]);
  if (change === null) return null;
  return { revision: raw["revision"], change };
}

export function parseRevisionedLeaseSnapshots(
  raw: unknown,
): SelectionRevisioned<readonly HostLeaseSnapshot[]> | null {
  if (!isRecord(raw)) return null;
  if (!isSafeCount(raw["revision"])) return null;
  const rawLeases = raw["change"];
  if (!Array.isArray(rawLeases)) return null;
  const leases: HostLeaseSnapshot[] = [];
  for (const entry of rawLeases) {
    const parsed = parseLeaseSnapshot(entry);
    if (parsed !== null) leases.push(parsed);
  }
  return { revision: raw["revision"], change: leases };
}

export function parseSelectionAttachResult(
  raw: unknown,
): SelectionAttachResult | null {
  if (!isRecord(raw)) return null;
  if (raw["ok"] === true) {
    const incarnationId = raw["incarnationId"];
    if (typeof incarnationId !== "string") return null;
    const snapshot = raw["snapshot"];
    if (!isRecord(snapshot)) return null;
    if (!isSafeCount(snapshot["contractVersion"])) return null;
    if (!isSafeCount(snapshot["revision"])) return null;
    const readId = (value: unknown): string | null | undefined => {
      if (value === null || typeof value === "string") return value;
      return undefined;
    };
    const preferredHostId = readId(snapshot["preferredHostId"]);
    const targetHostId = readId(snapshot["targetHostId"]);
    const effectiveHostId = readId(snapshot["effectiveHostId"]);
    if (
      preferredHostId === undefined ||
      targetHostId === undefined ||
      effectiveHostId === undefined
    ) {
      return null;
    }
    const rawLeases = snapshot["leases"];
    if (!Array.isArray(rawLeases)) return null;
    const leases: HostLeaseSnapshot[] = [];
    for (const entry of rawLeases) {
      const parsed = parseLeaseSnapshot(entry);
      if (parsed !== null) leases.push(parsed);
    }
    return {
      ok: true,
      incarnationId,
      snapshot: {
        contractVersion: snapshot["contractVersion"],
        revision: snapshot["revision"],
        preferredHostId,
        targetHostId,
        effectiveHostId,
        leases,
      },
    };
  }
  if (raw["ok"] === false) {
    if (raw["kind"] === "superseded") return { ok: false, kind: "superseded" };
    if (raw["kind"] === "malformed-request") {
      if (typeof raw["claimed"] !== "boolean") return null;
      return {
        ok: false,
        kind: "malformed-request",
        claimed: raw["claimed"],
      };
    }
    if (
      raw["kind"] === "version-mismatch" &&
      isSafeCount(raw["authorityVersion"]) &&
      isSafeCount(raw["callerVersion"])
    ) {
      return {
        ok: false,
        kind: "version-mismatch",
        authorityVersion: raw["authorityVersion"],
        callerVersion: raw["callerVersion"],
      };
    }
    return null;
  }
  return null;
}

export interface LiveSessionAnnouncement {
  hostId: string;
  sessionId: string;
  transportKind: SelectionTransportKind;
}

export interface SelectionAttachRequest {
  attachSeq: number;
  callerContractVersion: number;
  liveSessions: readonly LiveSessionAnnouncement[];
}

export function parseSelectionAttachSeq(raw: unknown): number | null {
  if (!isRecord(raw)) return null;
  return isSafeCount(raw["attachSeq"]) ? raw["attachSeq"] : null;
}

/** Duplicate sessionId strings drop all of that id's entries. Null routes to refuseMalformedAttach. */
export function parseSelectionAttachRequest(
  raw: unknown,
): SelectionAttachRequest | null {
  if (!isRecord(raw)) return null;
  if (!isSafeCount(raw["attachSeq"])) return null;
  if (!isSafeCount(raw["callerContractVersion"])) return null;
  const rawSessions = raw["liveSessions"];
  if (!Array.isArray(rawSessions)) return null;
  const counts = new Map<string, number>();
  for (const entry of rawSessions) {
    if (!isRecord(entry)) continue;
    const sessionId = entry["sessionId"];
    if (typeof sessionId !== "string") continue;
    counts.set(sessionId, (counts.get(sessionId) ?? 0) + 1);
  }
  const liveSessions: LiveSessionAnnouncement[] = [];
  for (const entry of rawSessions) {
    if (!isRecord(entry)) continue;
    const hostId = entry["hostId"];
    const sessionId = entry["sessionId"];
    if (typeof hostId !== "string" || typeof sessionId !== "string") continue;
    if (counts.get(sessionId) !== 1) continue;
    liveSessions.push({
      hostId,
      sessionId,
      transportKind: parseTransportKind(entry["transportKind"]),
    });
  }
  return {
    attachSeq: raw["attachSeq"],
    callerContractVersion: raw["callerContractVersion"],
    liveSessions,
  };
}

export type SelectionAttachResult =
  | {
      ok: true;
      incarnationId: string;
      snapshot: SelectionAuthoritySnapshot;
    }
  | {
      ok: false;
      kind: "version-mismatch";
      authorityVersion: number;
      callerVersion: number;
    }
  | {
      ok: false;
      kind: "superseded";
    }
  | {
      ok: false;
      kind: "malformed-request";
      claimed: boolean;
    };

    /** Dispose never throws. */
export interface SelectionSubscription {
  dispose(): void;
}

/** callerContractVersion is the renderer bundle's compiled constant. activate ok:true resolves after persist and re-derivation. */
export interface SelectionAuthorityClient {
  /** At most once per client instance. liveSessions transfers atomically with the claim. */
  attach(
    callerContractVersion: number,
    liveSessions: readonly LiveSessionAnnouncement[],
  ): Promise<SelectionAttachResult>;
  reportEvidence(report: SelectionEvidenceReport): Promise<void>;
  activate(hostId: string): Promise<ActivateResult>;
  onSelectionChanged(
    listener: (event: SelectionRevisioned<SelectionChange>) => void,
  ): SelectionSubscription;
  onLeasesChanged(
    listener: (
      event: SelectionRevisioned<readonly HostLeaseSnapshot[]>,
    ) => void,
  ): SelectionSubscription;
  /** After identity-transition commit; bindings re-attach with a new instance and a freshly allocated seq. */
  onReattachRequired(
    listener: (event: SelectionReattachRequired) => void,
  ): SelectionSubscription;
}

export interface HostFleetEntry {
  hostId: string;
  kind: "local" | "remote";
}

export interface HostFleetSnapshot {
  /** Process-lifetime monotonic, including across sign-out. */
  revision: number;
  /** Engine rejects a snapshot whose generation is not current, even if its revision is higher. */
  identityGeneration: number;
  localHostId: string | null;
  hosts: readonly HostFleetEntry[];
}

/** `{localHostId, hosts}` is one atomic tuple. Subscribe before reading; onChanged delivers the new snapshot. */
export interface HostFleetSource {
  snapshot(): HostFleetSnapshot;
  onChanged(
    listener: (snapshot: HostFleetSnapshot) => void,
  ): SelectionSubscription;
}

/** Subscribe before reading. Ignore a callback whose generation is not greater than current. */
export interface AuthorityIdentitySource {
  current(): { identityKey: string | null; generation: number };
  onChanged(
    listener: (identity: {
      identityKey: string | null;
      generation: number;
    }) => void,
  ): SelectionSubscription;
}

/** `deferred` is a busy lane, not a failed host; only a genuine failure may deaden the local lease. */
export interface LocalHostEnsurePort {
  ensureReady(): Promise<
    | { readonly ok: true }
    | {
        readonly ok: false;
        readonly reason: string;
        readonly deferred: boolean;
      }
  >;
}

export interface LocalHostOutageSignal {
  inExpectedOutage(): boolean;
  onChanged(
    listener: (inExpectedOutage: boolean) => void,
  ): SelectionSubscription;
}

/**
 * reporterId comes from the binding, never the renderer. attachSeq is engine-issued; allocation advances the supersession fence.
 * ingestEvidence/activate drop when incarnationId is not current; reporterDetached is required on hard teardown.
 */
export interface SelectionAuthorityEngine {
  /** Allocation advances the supersession fence. An unclaimed issuance retires the held attachment after the handover ceiling. */
  allocateAttachSeq(reporterId: string): number;
  attach(
    reporterId: string,
    request: SelectionAttachRequest,
  ): SelectionAttachResult;
  /** Seq parsed but envelope did not. True means the seq was consumed and the previous attachment retired. */
  refuseMalformedAttach(reporterId: string, attachSeq: number): boolean;
  ingestEvidence(
    reporterId: string,
    incarnationId: string,
    report: SelectionEvidenceReport,
  ): void;
  reporterDetached(reporterId: string): void;
  activate(
    reporterId: string,
    incarnationId: string,
    hostId: string,
  ): Promise<ActivateResult>;
  onSelectionChanged(
    listener: (event: SelectionRevisioned<SelectionChange>) => void,
  ): SelectionSubscription;
  onLeasesChanged(
    listener: (
      event: SelectionRevisioned<readonly HostLeaseSnapshot[]>,
    ) => void,
  ): SelectionSubscription;
  /** After identity-transition commit, at its own revision. */
  onReattachRequired(
    listener: (event: SelectionReattachRequired) => void,
  ): SelectionSubscription;
}
