/**
 * Selection-authority contract (host-lifecycle redesign, D16). Revision 9,
 * after the P1.0 design review rounds 1-8.
 *
 * One per-app authority owns host selection: it holds `preferredHostId`,
 * aggregates connection evidence reported by every window, runs the failover
 * engine, and broadcasts the derived selection plus per-host lease
 * snapshots. Windows never derive their own effective host; they report what
 * their transports observed and render what the authority decided.
 *
 * This module is the transport-agnostic core: plain TS interfaces with no
 * Electron or IPC types. Two bindings exist by design:
 *
 * - Desktop: the engine runs in the main process; the preload implements
 *   `SelectionAuthorityClient` over IPC (binding rules in
 *   `clients/desktop/src/ipc-contracts/selection-authority-ipc.ts`).
 * - Browser/dev (single window, no main process): the same engine module
 *   mounts in the window behind an in-process adapter. Multi-window without
 *   a main process is not a supported topology.
 *
 * ## Revisions
 *
 * The authority keeps ONE monotonic `revision`, incremented on every event
 * it broadcasts; every event carries the revision that produced it, and each
 * event payload is a self-contained snapshot of its slice. No two events
 * ever share a revision; one state transaction that emits both event kinds
 * commits at consecutive revisions, and a snapshot's `revision` is the
 * maximum committed event revision at capture time. The revision is
 * PROCESS-LIFETIME monotonic: it never resets while the authority process
 * lives, including across sign-out or account replacement.
 *
 * ## Attach protocol (race-free snapshot-on-subscribe)
 *
 * 1. `attachSeq` is ENGINE-SIDE-ALLOCATED, never invented by renderer or
 *    preload state: at every preload/renderer load the binding obtains a
 *    fresh seq from the engine's per-reporter allocator (desktop: a sync
 *    read at preload load, the same pattern that serves `windowId`;
 *    browser/dev: the in-process allocator). The allocator lives with the
 *    engine, so it is process-lifetime monotonic per reporter by
 *    construction - no durable-counter, reload-reset, or exhaustion story
 *    is needed on the renderer side (safe-integer space cannot be exhausted
 *    by page loads).
 * 2. The binding constructs ONE client instance per renderer load carrying
 *    that seq. A client instance may attach AT MOST once (attach-once
 *    terminal state).
 * 3. The instance registers listeners and starts BUFFERING events, then
 *    calls `attach(callerContractVersion, liveSessions)` with the kernel's
 *    complete current live-session inventory.
 * 4. ALLOCATION ADVANCES THE SUPERSESSION FENCE. The reporter's fence is
 *    the latest ISSUED seq, not the latest attached one: the moment a new
 *    load allocates, every older instance's attach is already `superseded`
 *    - even if the new instance has not attached yet. An attach is accepted
 *    only when its seq equals the latest issued seq AND that seq has not
 *    been consumed; acceptance and version-mismatch both CONSUME the seq
 *    (attach-once, enforced engine-side). The fence and consumption state
 *    survive attachment retirement and identity transitions (they prune
 *    only with the reporter itself).
 * 5. An ACCEPTED attach is one atomic transaction: the previous attachment
 *    is retired (incarnation voided), its announced sessions are replaced by
 *    the new inventory in the same step — there is NO observable
 *    empty-session window in which refusals could count against sockets
 *    that survived — and the returned snapshot reflects the post-transfer
 *    state.
 * 6. Attach ingress makes the current token ONE-SHOT ON EVERY PATH. The
 *    parsing itself is pure and synchronous; state is tested and mutated
 *    only inside the two atomically-guarded engine calls, and main's
 *    single-threaded handler runs parse and call with nothing interleaved:
 *    the binding parses the seq ({@link parseSelectionAttachSeq}) - if THAT
 *    fails, ZERO engine calls happen (state-neutral by construction) -
 *    then the full envelope, then makes EXACTLY ONE guarded engine call
 *    for every seq-parseable request: `attach(request)` when the envelope
 *    parsed, `refuseMalformedAttach(seq)` when it did not. Both calls apply the same guard: a non-latest or consumed seq is
 *    STATE-NEUTRAL (`superseded` / no-op - never touches the live
 *    attachment); a latest-unconsumed seq is CONSUMED in that call, with
 *    the previous attachment retired. Outcomes for a consumed claim:
 *    success installs the new attachment atomically (rule 5);
 *    version-mismatch and malformed-envelope terminate that generation -
 *    the reporter is left detached and the same seq can NEVER be replayed
 *    with a corrected envelope; recovery is a new load with a freshly
 *    allocated seq. An unparseable seq never reaches the engine and is
 *    state-neutral by construction. In every failure case the binding
 *    resolves a truthful {@link SelectionAttachResult} arm and drops its
 *    listeners and buffer.
 * 7. On success the binding installs the snapshot, discards buffered events
 *    with revision <= snapshot.revision, replays the rest in revision
 *    order, and only then delivers live events. Nothing can be lost between
 *    snapshot capture and listener installation, and side effects (toasts)
 *    fire only for events applied after the snapshot. `reattachRequired`
 *    rides the same unique-revision stream and the same filter: a client
 *    whose snapshot postdates an identity transition drops the transition's
 *    stale trigger automatically.
 *
 * ## Incarnations
 *
 * `incarnationId` is authority-generated per accepted attach and scoped to
 * the CLIENT INSTANCE that performed it: the instance stamps it on every
 * report/write it forwards. A renderer generation replaced by reload or HMR
 * holds a stale client instance with a stale incarnation (and a stale
 * attachSeq), so its late callbacks are dropped no matter when they fire.
 * Reporter identity itself still comes from the binding (IPC sender), never
 * from payloads.
 *
 * ## Identity transitions (sign-out, account replacement)
 *
 * The engine consumes an {@link AuthorityIdentitySource} under the same
 * race rules as the fleet port: subscribe BEFORE reading, and the change
 * callback carries the new identity itself, so a transition between read
 * and subscription cannot be lost. When the identity generation changes,
 * the engine performs ONE transaction: every reporter's incarnation is
 * voided (generation high-waters survive - rule 4), all evidence state is
 * cleared (sessions, dial streaks, compat verdicts, tombstone episodes AND
 * their seen-id set), leases reset, and the fleet swaps to the
 * new-generation snapshot if one is already available or to the EMPTY
 * fleet otherwise - the matching snapshot then arrives as an ordinary
 * fleet transaction (`fleet-shift`). Identity callbacks are accepted
 * monotonically: a callback whose generation is not greater than the
 * current one is ignored (a delayed or coalesced old callback can never
 * transition the authority backward - the same stance as stale-fleet
 * rejection). The transaction commits, its events emit, and ONLY THEN
 * does the engine emit `reattachRequired` at its own fresh unique
 * revision - the mandatory re-attach trigger, ordered after the commit by
 * construction.
 * A binding may also re-attach on platform signals (desktop auth-session
 * broadcast), but such an attach can be voided by a transition that
 * follows it; the `reattachRequired` emission is what guarantees a final
 * post-transition attach happens. Late artifacts of the old identity
 * cannot leak in: a pre-transition callback carries a voided incarnation
 * (dropped by the existing gate), and a pre-transition fleet fetch carries
 * a stale `identityGeneration` (rejected by the engine).
 *
 * ## Versioning
 *
 * `SELECTION_AUTHORITY_CONTRACT_VERSION` is a major version, additive-only
 * within it. The RENDERER passes its own compiled major through `attach`
 * (the preload must not substitute its cached copy); a mismatch returns a
 * typed refusal naming both versions. Same-major skew is enforced IN CODE at
 * both binding boundaries by the exported `parse*` functions: raw inbound
 * values cross through them, unknown members map per each parser's fixed
 * rule or drop the value, and the IPC layer never hands unparsed input to
 * domain code.
 */

import {
  clientCompatibilityRequirementSchema,
  type ClientCompatibilityRequirement,
} from "@traycer/protocol/framework/client-identity";

// Re-exported because it is now part of `SelectionIncompatibility`'s public
// shape: anything that builds or asserts on a lease detail needs the type, and
// reaching past this module into the protocol package for one member of a type
// this module owns is the kind of split import that goes stale.
export type { ClientCompatibilityRequirement };

/** Major version of this contract. Additive-only within a major. */
export const SELECTION_AUTHORITY_CONTRACT_VERSION = 1;

/**
 * The epoch-rejection detail, or `null` when it is absent or malformed.
 *
 * Absent is the ordinary case in two populations that must both keep working:
 * a host that predates the epoch gate, and any incompatibility that was a
 * method-manifest disagreement rather than an epoch rejection.
 */
function parseClientCompatibility(
  value: unknown,
): ClientCompatibilityRequirement | null {
  if (value === undefined || value === null) return null;
  const parsed = clientCompatibilityRequirementSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** A wire record: a non-null object that is not an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Finite epoch-ms/number check - rejects NaN and infinities. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Revisions and contract versions: non-negative safe integers, nothing else. */
function isSafeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Which transport produced a piece of evidence. Diagnostic attribution only -
 * aggregation never branches on it. `"unknown"` is the parser's mapping for
 * members added by a newer same-major peer.
 */
export type SelectionTransportKind = "local-ws" | "remote-relay" | "unknown";

/** Wire mapping for {@link SelectionTransportKind}; unknown → "unknown". */
export function parseTransportKind(value: unknown): SelectionTransportKind {
  return value === "local-ws" || value === "remote-relay" ? value : "unknown";
}

/**
 * One dial attempt's outcome (window → authority), discriminated on the
 * outcome so impossible states are unrepresentable: only the
 * `confirmed-refusal` arm carries `refusalDetail`.
 *
 * `confirmed-refusal` means a REAL dial attempt was terminally refused by
 * the transport itself: connection refused, Noise/relay handshake rejection,
 * a relay attach refusal. It is deliberately NOT the directory-level
 * `isConfirmedTransportRefusal` gate (`host-client/remote-fetcher.ts`) - that
 * helper is a pre-dial gate folding cloud-DTO verdicts (`offline`,
 * `plan-restricted`) into its answer, and feeding it here would let a DTO
 * flip advance the death counter, which invariant 5 forbids. Reporters
 * classify from the attempt's transport error, never from directory state.
 * `refusalDetail: "plan-restricted"` (a refusal whose transport error
 * carried the plan restriction) is the ONLY provenance for
 * `dead("plan-restricted")`.
 *
 * Death aggregation is ATTEMPT-scoped and deduplicated: `attemptId` is
 * unique within the reporter incarnation, and the authority counts each
 * (incarnation, attemptId) at most once. `success` clears the host's refusal
 * streak; while ANY live session exists for the host, failed dials are
 * recorded for diagnostics but never accumulate toward death (the streak
 * restarts only after the session set empties). `timeout` is death evidence;
 * `indeterminate` (liveness-read failure, attempt abandoned for unrelated
 * reasons) never advances a counter.
 */
export type SelectionDialEvidence =
  | {
      kind: "dial";
      hostId: string;
      attemptId: string;
      outcome: "success" | "timeout" | "indeterminate";
      transportKind: SelectionTransportKind;
      /**
       * Reporting window's clock, epoch ms. Diagnostic only - identity and
       * ordering come from attemptId/revisions, never from this.
       */
      at: number;
    }
  | {
      kind: "dial";
      hostId: string;
      attemptId: string;
      outcome: "confirmed-refusal";
      refusalDetail: "plan-restricted" | null;
      transportKind: SelectionTransportKind;
      /** Same caveat. */
      at: number;
    };

/**
 * A live transport session appearing or disappearing (window → authority).
 *
 * Sessions are keyed by (reporter incarnation, `sessionId`); `sessionId` is
 * reporter-generated and unique within the incarnation. A live session
 * anywhere in the app outranks every other evidence class (invariant 5).
 * Transition semantics - all idempotent, all order-safe:
 *
 * - duplicate `established` / duplicate `lost`: no-ops;
 * - `lost` before `established` (reordered delivery): tombstones the id -
 *   both are dropped, the session never counts as live;
 * - any transition carrying a stale incarnation: dropped.
 *
 * `reporterDetached` marks every session of the reporter's incarnation
 * lost; attach rotation REPLACES the outgoing incarnation's sessions with
 * the new attach's inventory atomically (module header rule 4).
 */
export interface SelectionSessionEvidence {
  kind: "session";
  hostId: string;
  sessionId: string;
  transition: "established" | "lost";
  transportKind: SelectionTransportKind;
  /** Same caveat as dial `at`. */
  at: number;
}

/** Structured compat-probe failure detail; stable codes, no free-form UI text. */
export interface SelectionIncompatibility {
  /** Machine code from the compat probe (e.g. "protocol-major-behind"). */
  code: string;
  hostVersion: string | null;
  minSupportedVersion: string | null;
  /**
   * Present exactly when the host refused this client at its COMPATIBILITY
   * EPOCH gate, rather than over a method-manifest disagreement - see
   * `ClientCompatibilityRequirement`.
   *
   * Carried all the way to the UI rather than collapsed into `code`, because
   * the two failures call for OPPOSITE remedies and the surface has to be able
   * to tell them apart before it draws a button. A manifest disagreement can
   * legitimately mean "update the host"; an epoch rejection never does - the
   * host is the newer leg by construction - and offering Update host there is
   * an action that can only fail while implying the user is fixing the right
   * machine.
   *
   * `null` for every other incompatibility, including one reported by a host
   * that predates the gate (which strips the field at its own copy of the
   * fatal schema).
   */
  clientCompatibility: ClientCompatibilityRequirement | null;
}

/**
 * A compat-probe verdict (window → authority). Compatibility is a property
 * of the HOST (verdicts survive reporter detach), and its freshness is
 * anchored to host CONNECTION GENERATIONS, not to version strings - a
 * legitimate downgrade or a same-version restart must be able to replace a
 * stale verdict, and version strings have no settled ordering:
 *
 * - `probedOnSessionId` names the session the probe ran on. The authority
 *   orders verdicts per host by its own observation order of those sessions;
 *   a verdict probed on the host's latest session supersedes all earlier
 *   ones, whatever the version strings say.
 * - A verdict with `probedOnSessionId: null` (no live session context) is
 *   weakest: superseded by any session-anchored verdict, and only ever
 *   replaces another null-anchored one (latest received wins).
 * - Compat evidence for a host is CLEARED on fleet removal.
 *
 * `hostVersion` is descriptive (display + the incompatibility detail),
 * never an ordering key. `incompatibility` is non-null exactly when
 * `verdict` is `"incompatible"` (D13).
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
 * A host-published restart tombstone observed on the liveness plane
 * (window → authority). The liveness plane is consumed by renderer-side
 * transports, so this is the ingress by which a restart issued from ANY
 * client - another machine, a CLI on the box, an update install - reaches
 * the authority (M1/D5).
 *
 * Episode semantics, all authority-local:
 * - Keyed by (hostId, tombstoneId). FIRST receipt anchors ONE fixed
 *   expected-outage episode bounded by the engine's ceilings; duplicate
 *   observations (other windows, replays) NEVER extend it.
 * - The seen-id set retains every (hostId, tombstoneId) for the AUTHORITY
 *   PROCESS LIFETIME (pruned only on the host's fleet removal or an
 *   identity transition) - no replay-delay assumption about the liveness
 *   plane or a suspended renderer is needed, because no eviction horizon
 *   exists for a replay to outlive. Tombstones are rare; the set is
 *   bounded by restart count, not traffic.
 * - `restarting-expected` is a HOLD on the lease it applies to (the engine
 *   does not fail over off it, M6) - it never makes that host an ELIGIBLE
 *   CANDIDATE for derivation while cycling; `usable()` excludes it for
 *   candidate selection.
 * - `expiresAt` (host clock domain) is display only; authority deadlines
 *   come from its own ceilings, never renderer or host clocks.
 */
export interface SelectionRestartIntentEvidence {
  kind: "restart-intent";
  hostId: string;
  tombstoneId: string;
  expiresAt: number | null;
  /** Same caveat as dial `at`. */
  at: number;
}

/**
 * Everything a window may report. Raw inbound values cross the binding
 * through {@link parseSelectionEvidenceReport}; a report that does not parse
 * is dropped with a debug log, never an error.
 */
export type SelectionEvidenceReport =
  | SelectionDialEvidence
  | SelectionSessionEvidence
  | SelectionCompatEvidence
  | SelectionRestartIntentEvidence;

/**
 * Raw-boundary parser for evidence reports. Applies every unknown-member
 * rule in one place: unknown `kind` → null (drop); unknown dial outcome →
 * `indeterminate` (inert); unknown session transition → null (drop - a
 * guessed transition could fabricate liveness or death); unknown transport
 * kind → `"unknown"`; malformed shapes → null. The binding calls this on
 * every inbound report so same-major skew safety is structural.
 */
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
            // Parsed through the protocol's own schema rather than field by
            // field, and DROPPED to `null` on any mismatch instead of
            // failing the whole verdict. A malformed member here must not
            // cost the authority the incompatibility report itself - the
            // fallback is the generic version-skew copy, which is worse than
            // the epoch copy but far better than a host whose deadness is
            // never recorded.
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

/**
 * Lease vocabulary (connection registry §1). All status UI derives from
 * this - no surface reads sockets, probe caches, or the cloud DTO directly.
 */
export type HostLeaseStatus =
  "connecting" | "ready" | "degraded" | "restarting-expected" | "dead";

/**
 * Why a lease is dead, as a discriminated union so `incompatible` carries
 * its structured detail (the update-host modal's input) everywhere the
 * verdict travels. `removed` means deregistered from the account.
 */
export type HostLeaseDeadState =
  | { reason: "offline" }
  | { reason: "plan-restricted" }
  | { reason: "removed" }
  | { reason: "incompatible"; detail: SelectionIncompatibility };

/**
 * One host's aggregated verdict (authority → windows). The engine's
 * local-`ensure` progress surfaces HERE, not on a separate channel:
 * `connecting` while ensure runs, dead `offline` when it fails (D14).
 */
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
 * VALUE equality over the complete {@link HostLeaseSnapshot} shape - exhaustive
 * by construction: `hostId` and `status` are compared directly, and `dead` is
 * walked to the bottom of its union, including
 * {@link SelectionIncompatibility}'s three fields. No field escapes it, so
 * "equal here" and "the same verdict" are the same statement.
 *
 * ⚠ IT HAS TWO READERS AND THEY MUST NOT DIVERGE - which is why it lives here,
 * beside the type, rather than in either of them:
 *
 *  - the engine's EMISSION gate (`leasesEqual` → `stage`) decides whether a
 *    derived fleet is published at all;
 *  - `useHostLease`'s SELECTION gate decides whether a published lease
 *    re-renders the consumer that named that host.
 *
 * A second, coarser copy on the reading side is a silent dropped update: the
 * authority emits a real verdict change and the surface never re-renders. A
 * finer one is only churn. Neither is discoverable from the site that has it,
 * because each is locally self-consistent - so the divergence is prevented by
 * there being one function, not by two comparators agreeing.
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
 * Whether two incompatibility details describe the same CLIENT-COMPATIBILITY
 * requirement.
 *
 * This has to be part of `leaseEquals` because that function gates whether the
 * authority broadcasts a `leases` event at all, and on the epoch path the
 * other three discriminators are nearly constant: `hostVersion` and
 * `minSupportedVersion` are BOTH always `null` (a fatal frame carries method
 * canonicals, not version strings - see `describeCompatVerdictForAuthority`),
 * and the code is a bare `INCOMPATIBLE` whenever the frame carried no
 * per-method blocking reason. So without this, two materially different
 * verdicts compare equal and the newer one is never delivered.
 *
 * Two reachable ways that bites, both ending in a blocking dialog showing the
 * WRONG remedy:
 *
 *  - A host raises its floor (epoch 2 -> 3) and its minimum-known build moves
 *    with it. Same code, both versions null - so every window keeps telling
 *    the user to install the build that satisfied the OLD floor.
 *  - A requirement that failed to parse dropped to `null`
 *    (`parseClientCompatibility` is deliberately lossy rather than fatal), and
 *    a later well-formed one arrives. Same code again, so the UI never leaves
 *    the generic `update-host` variant for `update-client` - and "Update host"
 *    cannot fix an outdated client.
 *
 *  - Failover moves the window from a rejecting STABLE host to a rejecting RC
 *    one at the same floor. Every other member matches; only
 *    `hostReleaseChannel` moved - and that member is exactly what decides
 *    whether the recovery surface may offer an RC opt-in at all, so dropping
 *    the event leaves the dialog offering the wrong route.
 *
 * Compared MEMBER BY MEMBER rather than by identity: these objects cross an
 * IPC boundary and are re-parsed per delivery, so reference equality is always
 * false and would make every lease event look like a change.
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
    // Absent and `undefined` are the same observation on an OPTIONAL member,
    // so `===` is the right comparison and no null-coalescing is wanted: a
    // host that predates the field and one that somehow sent `undefined` must
    // compare equal, while `"stable"` vs absent must not.
    a.hostReleaseChannel === b.hostReleaseChannel
  );
}

/**
 * Raw-boundary parser for lease snapshots. Unknown `status` → `connecting`
 * (non-committal: neither usable nor dead); unknown dead `reason` →
 * `offline` (retryable - the safe direction); malformed → null (drop the
 * entry; the next leases event corrects).
 */
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
            // Same drop-to-null-on-mismatch rule as the evidence parser
            // above: losing the epoch detail costs the UI its specific copy,
            // losing the whole lease would cost it the deadness.
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

/**
 * Why the selection moved. `activate`/`deregister-clear` are the two
 * preferred-writers (invariant 1); `failover`/`recovery` are engine
 * re-derivations; `fleet-shift` covers target/effective movement caused by
 * fleet or local-identity change with no preference write and no
 * engine-confirmed death (e.g. the local host id appearing at startup).
 * Toast rule: `failover`/`recovery` with an actual effective change show the
 * one-line toast; everything else is silent. Unknown members map to
 * `failover` (over-narrating beats hiding a move).
 */
export type SelectionChangeCause =
  "activate" | "deregister-clear" | "failover" | "recovery" | "fleet-shift";

/**
 * THE selection event (authority → windows): one composite, revisioned,
 * self-contained snapshot of the whole selection tuple. One event kind
 * means one high-water mark orders everything - no sibling event at the
 * same revision can be dropped - and a target or preferred change that
 * leaves `effective` untouched still reaches every live window (Activate
 * of an offline host while a fallback serves; deregister-clear; local
 * identity appearing).
 *
 * Derived phase predicates (the contract's definitions - consumers must not
 * invent their own): NoHost := `effectiveHostId === null`. FailedOver :=
 * `effectiveHostId !== null && effectiveHostId !== targetHostId`. OnTarget
 * := `effectiveHostId !== null && effectiveHostId === targetHostId`.
 *
 * Window-global consumers re-point when `effectiveHostId` differs from the
 * value they last applied (invariant 4); they never watch lease snapshots
 * to infer a switch.
 */
export interface SelectionChange {
  preferredHostId: string | null;
  /**
   * The engine's current target: preferred, or the local host when
   * preferred is null (M5), or null when neither exists. Carried because
   * windows cannot derive it (deriving needs the local host's identity,
   * which is fleet knowledge).
   */
  targetHostId: string | null;
  effectiveHostId: string | null;
  /** The previous effective host, for re-point bookkeeping. */
  previousEffectiveHostId: string | null;
  cause: SelectionChangeCause;
}

/** Raw-boundary parser for {@link SelectionChange}; malformed → null (drop). */
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

/**
 * Directory-validation refusal arm for Activate (F14).
 *
 * `unknown-host`: not in the fleet (stale UI or removed). `incompatible`:
 * the CURRENT compat verdict blocks this host (D13) - Settings offers Update
 * instead; unknown compatibility (never probed) is activatable; a host that
 * becomes incompatible AFTER being preferred keeps the preference and fails
 * over until updated. `not-attached`: the caller's incarnation is stale or
 * version-refused. `persist-failed`: the preference could not be made
 * DURABLE (write/rename failure) - the host is fine, no state moved, no
 * event fired, and the SAME Activate may be retried (the store re-attempts
 * the write). `unrecognized` is the parser's mapping for future members.
 * Deliberately NOT refused: a registered host that is currently offline -
 * preferred is intent, not liveness (D1/D5).
 */
export type ActivateRefusalReason =
  | "unknown-host"
  | "incompatible"
  | "not-attached"
  | "persist-failed"
  | "unrecognized";

/** Result of an Activate request. */
export type ActivateResult =
  { ok: true } | { ok: false; reason: ActivateRefusalReason };

/** Raw-boundary parser for {@link ActivateResult}; malformed → refusal. */
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

/**
 * Full authority state at one revision. `attach` returns this; the same
 * tuple appears in every {@link SelectionChange} thereafter, so a client's
 * state is always reconstructible from (snapshot, later events).
 */
export interface SelectionAuthoritySnapshot {
  contractVersion: number;
  revision: number;
  preferredHostId: string | null;
  targetHostId: string | null;
  effectiveHostId: string | null;
  leases: readonly HostLeaseSnapshot[];
}

/** An event payload plus the authority revision that produced it. */
export interface SelectionRevisioned<T> {
  revision: number;
  change: T;
}

/**
 * The post-identity-transition re-attach trigger (module header). Emitted
 * at its OWN fresh unique revision - the global one-revision-per-event
 * rule holds for it too, so the client's single high-water mark orders all
 * three event kinds and a state event can never shadow it. It flows
 * through the same attach-time filter: a client whose snapshot postdates
 * the transition drops the stale trigger.
 */
export interface SelectionReattachRequired {
  revision: number;
}

/** Raw-boundary parser for {@link SelectionReattachRequired}. */
export function parseReattachRequired(
  raw: unknown,
): SelectionReattachRequired | null {
  if (!isRecord(raw)) return null;
  if (!isSafeCount(raw["revision"])) return null;
  return { revision: raw["revision"] };
}

/**
 * Raw-boundary parser for the `selectionChanged` wire envelope; malformed
 * envelope or inner change → null (drop; the next event or a re-attach
 * corrects).
 */
export function parseRevisionedSelectionChange(
  raw: unknown,
): SelectionRevisioned<SelectionChange> | null {
  if (!isRecord(raw)) return null;
  if (!isSafeCount(raw["revision"])) return null;
  const change = parseSelectionChange(raw["change"]);
  if (change === null) return null;
  return { revision: raw["revision"], change };
}

/**
 * Raw-boundary parser for the `leasesChanged` wire envelope. A non-array
 * payload rejects the event; an unparseable ENTRY is dropped from the array
 * (the next leases event corrects it) rather than rejecting the rest.
 */
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

/**
 * Raw-boundary parser for the attach result, including the nested snapshot
 * (recursively parsed leases, safe-integer version/revision). `null` means
 * the result was unusable - the binding treats it as a failed attach and
 * disposes, exactly like a rejection.
 */
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

/**
 * One live transport session, as inventoried in an attach call (module
 * header rule 3). The atomic sibling of {@link SelectionSessionEvidence}'s
 * `established` transition.
 */
export interface LiveSessionAnnouncement {
  hostId: string;
  sessionId: string;
  transportKind: SelectionTransportKind;
}

/**
 * The attach request as it crosses the wire - the invoke carries exactly
 * ONE value of this shape (module header rules 1-4).
 */
export interface SelectionAttachRequest {
  attachSeq: number;
  callerContractVersion: number;
  liveSessions: readonly LiveSessionAnnouncement[];
}

/**
 * Seq parser of the attach ingress (module header rule 6): a PURE
 * extraction that lets the binding route to the correct guarded engine
 * call - `attach` vs `refuseMalformedAttach`. It performs no engine
 * decision itself. Null when the value is not a non-negative safe integer;
 * such an attempt makes ZERO engine calls and is state-neutral by
 * construction (it cannot even be attributed to a generation).
 */
export function parseSelectionAttachSeq(raw: unknown): number | null {
  if (!isRecord(raw)) return null;
  return isSafeCount(raw["attachSeq"]) ? raw["attachSeq"] : null;
}

/**
 * Stage-2 (full) parser for the attach request. `attachSeq` and
 * `callerContractVersion` must be non-negative safe integers; the inventory
 * must be an array. A `sessionId` STRING appearing more than once among the
 * raw entries - whether its other appearances are valid or malformed - is a
 * conflicting claim: ALL of its entries are dropped (deterministic; the
 * kernel can re-assert the real session through ordinary session
 * evidence). Other malformed entries are dropped individually. A null here
 * routes the binding to
 * {@link SelectionAuthorityEngine.refuseMalformedAttach} - the guarded
 * call that, for a latest-unconsumed seq, consumes it and retires the
 * previous attachment so the same seq can never be replayed with a
 * corrected envelope (module header rule 6).
 */
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

/**
 * Result of an attach request. `superseded` means the presented seq is not
 * the latest issued unconsumed one - a newer generation has been ISSUED
 * (allocation alone supersedes, module header rule 4) or this seq was
 * already consumed. Terminal for the caller, state unchanged.
 * `version-mismatch` is terminal for that renderer load and leaves the
 * reporter detached with its seq consumed. `malformed-request` is the
 * truthful completion for an envelope that failed parsing: `claimed: true`
 * means the seq was the latest-unconsumed issuance, so it was consumed and
 * the previous attachment retired (generation terminated); `claimed:
 * false` means nothing mutated (stale/consumed seq, or the seq itself was
 * unparseable and the engine was never called). Every `ok: false` arm
 * obliges the binding to dispose its listeners and buffer.
 */
export type SelectionAttachResult =
  | {
      ok: true;
      /** Bound to the client instance that attached; see module header. */
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

/** Subscription handle. Disposing stops delivery; never throws. */
export interface SelectionSubscription {
  dispose(): void;
}

/**
 * What a window consumes. Attach/buffering/replay rules are in the module
 * header; `callerContractVersion` is the RENDERER bundle's compiled
 * constant. `reportEvidence` resolves when the authority accepted (or
 * knowingly dropped) the report; the binding contains rejections (catch +
 * log). `activate` is the Activate write (Settings only - D12's lint layer
 * enforces the call site); `ok: true` resolves only after validate,
 * persist, and re-derivation, so the selection event has been emitted.
 */
export interface SelectionAuthorityClient {
  /**
   * At most once per client instance (the binding constructs one instance
   * per renderer load and issues its `attachSeq` internally - module header
   * rules 1-3). `liveSessions` is the kernel's complete current session
   * inventory, transferred atomically with the claim.
   */
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
  /**
   * Emitted AFTER an identity-transition transaction commits (module
   * header) - the mandatory signal on which bindings re-attach their live
   * clients (new instance, freshly allocated seq). See
   * {@link SelectionReattachRequired} for its revision semantics. The
   * engine exposes the same event so the binding can fan it out.
   */
  onReattachRequired(
    listener: (event: SelectionReattachRequired) => void,
  ): SelectionSubscription;
}

/** One registered host as the authority's engine sees it. */
export interface HostFleetEntry {
  hostId: string;
  kind: "local" | "remote";
}

/** An atomic fleet observation: identity and membership from one read. */
export interface HostFleetSnapshot {
  /**
   * Adapter-owned, PROCESS-LIFETIME monotonic - it never resets while the
   * process lives, including across sign-out/account replacement, so a
   * consumer can always detect staleness by comparison.
   */
  revision: number;
  /**
   * The {@link AuthorityIdentitySource} generation this snapshot was
   * FETCHED under. The engine rejects a snapshot whose generation is not
   * its current one - a late account-A fetch completing after account B
   * became current cannot be accepted just because its `revision` is
   * higher. Revision orders observations; this establishes membership.
   */
  identityGeneration: number;
  localHostId: string | null;
  hosts: readonly HostFleetEntry[];
}

/**
 * The authority's fleet/identity input port - the directory truth `activate`
 * validation (F14), derivation, candidate enumeration, deregister-clear
 * observation, and `targetHostId` all read. Transport-agnostic: on desktop
 * P1.1 composes it main-side from the sources main already owns (registry
 * list fetch + pid.json identity); browser/dev injects the renderer
 * directory service.
 *
 * Race rules: `{localHostId, hosts}` is ONE atomic tuple per snapshot
 * (never composed from two reads at different times). Consumers subscribe
 * BEFORE reading, and `onChanged` delivers the new snapshot itself, so the
 * read-then-subscribe gap cannot lose a change. The engine applies one
 * fleet snapshot as one transaction at one new authority revision.
 */
export interface HostFleetSource {
  snapshot(): HostFleetSnapshot;
  onChanged(
    listener: (snapshot: HostFleetSnapshot) => void,
  ): SelectionSubscription;
}

/**
 * The engine's identity input (sign-out, account replacement). `generation`
 * increments on every identity change; `identityKey` is the scoping key the
 * persisted preference uses (null when signed out). Race rules match
 * {@link HostFleetSource}: consumers subscribe BEFORE reading, and
 * `onChanged` delivers the new identity itself, and the engine ignores a
 * callback whose `generation` is not greater than its current one
 * (monotonic acceptance - delayed old callbacks cannot roll identity
 * back). The engine's
 * identity-transition transaction (module header) runs on `onChanged`, and
 * every {@link HostFleetSnapshot} is stamped with the generation it was
 * fetched under so late cross-identity completions are rejected. Desktop
 * composition: the auth-session state main already owns; browser/dev: the
 * renderer auth service.
 */
export interface AuthorityIdentitySource {
  current(): { identityKey: string | null; generation: number };
  onChanged(
    listener: (identity: {
      identityKey: string | null;
      generation: number;
    }) => void,
  ): SelectionSubscription;
}

/**
 * The engine's one sanctioned process action (C5/D14): request local-host
 * provisioning whenever the local host is down - whichever host a window is
 * pointed at (the local lifecycle is target-independent by decision,
 * 2026-08-19). Progress surfaces as the local lease's status; this port
 * carries no state.
 *
 * `deferred` distinguishes "the lifecycle lane was busy, nothing ran" (a CLI
 * lock another actor held, a drained queue slot) from a provisioning attempt
 * that ran and FAILED. The engine paces its next request on both, but only a
 * genuine failure may deaden the local lease: a deferral learned nothing
 * about the host, and rendering it `dead: offline` for the cooldown put the
 * "No host is available" modal over a machine whose host was fine while a
 * concurrent launch actor merely held the lock.
 */
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

/**
 * The local expected-outage signal (D5): true while the HostController
 * mutation lane has an operation in flight (ensure/apply/respawn/update).
 * The remote counterpart arrives as {@link SelectionRestartIntentEvidence};
 * this port is local-only and main-side.
 */
export interface LocalHostOutageSignal {
  inExpectedOutage(): boolean;
  onChanged(
    listener: (inExpectedOutage: boolean) => void,
  ): SelectionSubscription;
}

/**
 * What the engine (P1.1) exposes to its binding, plus the ports it is
 * composed with ({@link HostFleetSource}, {@link AuthorityIdentitySource},
 * {@link LocalHostEnsurePort}, {@link LocalHostOutageSignal} - constructor
 * inputs, not wire surface).
 *
 * `reporterId` identifies the reporting window and is supplied by the
 * BINDING (IPC sender / constant in-process id), never by the renderer.
 * `attachSeq` is ENGINE-ISSUED via {@link allocateAttachSeq} (module
 * header rules 1 and 4): allocation advances the reporter's supersession
 * fence, so an attach is accepted only when its seq equals the LATEST
 * ISSUED seq and that seq is unconsumed; anything else returns
 * `superseded`. Acceptance and version-mismatch both consume the seq.
 * An accepted attach atomically retires the previous attachment and
 * installs `liveSessions` as the reporter's session inventory (rule 5); a
 * version-mismatch retires without installing (rule 6).
 * `ingestEvidence`/`activate` drop/refuse when `incarnationId` is not the
 * reporter's current one. `reporterDetached` is the binding's obligation on
 * hard teardown (webContents destroyed, render-process-gone); soft
 * replacement is covered by attach rotation, and identity transitions void
 * every incarnation (module header).
 */
export interface SelectionAuthorityEngine {
  /**
   * The per-reporter attach-generation allocator (module header rules 1
   * and 4). The binding calls this once per renderer/preload load
   * (desktop: served through a sync read at preload init; browser/dev:
   * called directly) and hands the value to the client instance it
   * constructs. Monotonic per reporter for the engine's lifetime - and
   * ALLOCATION ADVANCES THE SUPERSESSION FENCE: the moment this returns,
   * every earlier-issued generation's attach is already superseded. The
   * reporter's CURRENT attachment is held until the issued generation
   * claims (no empty-session window), but that wait is bounded by the
   * engine's own handover ceiling: an issuance never claimed - a renderer
   * whose bootstrap failed after its preload allocated, which no detach
   * signal reports - retires the held attachment as a detach would.
   */
  allocateAttachSeq(reporterId: string): number;
  attach(
    reporterId: string,
    request: SelectionAttachRequest,
  ): SelectionAttachResult;
  /**
   * The malformed-envelope arm of the guarded claim (module header rule
   * 6): the binding calls this when the seq parsed but the full envelope
   * did not. Returns true when `attachSeq` was the reporter's latest
   * unconsumed issuance - the engine consumed it and retired the previous
   * attachment (terminal for that generation; no corrected-envelope
   * replay) - and false for the state-neutral stale/consumed case. The
   * binding folds the return into the `malformed-request` result arm's
   * `claimed` field. Typed in-process callers construct
   * `SelectionAttachRequest` directly and never need this.
   */
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
  /**
   * The producer of the post-identity-transition re-attach trigger (module
   * header): emitted at its own fresh unique revision only after the
   * transition transaction commits. The binding subscribes here and fans
   * the event out to windows.
   */
  onReattachRequired(
    listener: (event: SelectionReattachRequired) => void,
  ): SelectionSubscription;
}
