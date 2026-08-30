import { z } from "zod";
import {
  defineRpcContract,
  defineUpgradePath,
} from "@traycer/protocol/framework/index";
// TYPE-ONLY, and it must stay that way. This module is reachable from the RPC
// registry the renderer imports; `import type` is erased, so the wire
// vocabulary below can be pinned to the durable record's vocabulary without
// the renderer ever resolving a `config/*` module. See
// `config/host-update-attempt.ts`'s header for the pure/Node split that makes
// this safe.
import type {
  HostUpdateAttemptContinuation,
  HostUpdateAttemptExecution,
  HostUpdateAttemptPhase,
  HostUpdateTrigger,
} from "@traycer/protocol/config/host-update-attempt";

export const hostStatusV10 = defineRpcContract({
  method: "host.status",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: z.object({}),
  responseSchema: z.object({
    ready: z.boolean(),
    hostVersion: z.string(),
    protocolVersion: z.object({
      major: z.number().int().nonnegative(),
      minor: z.number().int().nonnegative(),
    }),
  }),
});

/**
 * Mirror of `traycer-host`'s host-local `HostUpdateProgress` (itself a
 * mirror of `@traycerai/common/types/host` in the internal monorepo - this
 * open-source package cannot depend on it). Set only while a `traycer host
 * update` is actually in flight on this box (Architecture §13, T16);
 * `null` the rest of the time.
 */
export const hostUpdateProgressStateSchema = z.enum(["updating", "failed"]);
export type HostUpdateProgressState = z.infer<
  typeof hostUpdateProgressStateSchema
>;

export const hostStatusUpdateProgressSchema = z.object({
  state: hostUpdateProgressStateSchema,
  error: z.string().nullable(),
});
export type HostStatusUpdateProgress = z.infer<
  typeof hostStatusUpdateProgressSchema
>;

/**
 * Typed breakdown of {@link hostStatusV12}'s `busySessionCount` total, reused
 * by `host.restart` @1.2 and the unnegotiated `hostRuntimeStatus` awareness
 * field. Counts are non-negative; a missing breakdown is `null` (unknown),
 * never a fabricated zero object.
 */
export const hostBusyBreakdownSchema = z.object({
  workingAgents: z.number().int().nonnegative(),
  activeTerminalAgents: z.number().int().nonnegative(),
  busyTerminals: z.number().int().nonnegative(),
});
export type HostBusyBreakdown = z.infer<typeof hostBusyBreakdownSchema>;

/**
 * v1.1 folds in the T16 busy/drain signal (`host.drainStatus`, since removed
 * - see the RPC backward-compat decision log) as additive `host.status`
 * fields instead of a standalone method name, so the wire method-set stays
 * identical to `host-v1.0.0`. Backs the "My Hosts" busy badge and the
 * client-side update drain-gate copy.
 */
export const hostStatusV11 = defineRpcContract({
  method: "host.status",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: z.object({}),
  responseSchema: z.object({
    ready: z.boolean(),
    hostVersion: z.string(),
    protocolVersion: z.object({
      major: z.number().int().nonnegative(),
      minor: z.number().int().nonnegative(),
    }),
    busy: z.boolean(),
    /**
     * Open sessions blocking an update drain. `null` means the host did not
     * report a count — NOT that it reported zero. The two are different claims
     * and the drain UI depends on the difference: it names the count in
     * "Apply now — ends N sessions" and then ends that many.
     */
    busySessionCount: z.number().int().nonnegative().nullable(),
    updateProgress: hostStatusUpdateProgressSchema.nullable(),
  }),
});

/**
 * v1.2 adds a typed `busyBreakdown` beside the existing total.
 *
 * `busySessionCount` is now the breakdown total (`workingAgents` +
 * `activeTerminalAgents` + `busyTerminals`) when the host reports both; old
 * clients keep rendering the single number. `busyBreakdown: null` means the
 * host did not say how the total splits — NOT that every component is zero.
 * The v1.1→v1.2 upgrade therefore writes `null`, following the v1.0→v1.1
 * `busySessionCount: null` precedent: manufacturing `{ workingAgents: 0, ... }`
 * would put an affirmative idle-by-kind claim in an old host's mouth.
 */
export const hostStatusV12 = defineRpcContract({
  method: "host.status",
  schemaVersion: { major: 1, minor: 2 } as const,
  requestSchema: z.object({}),
  responseSchema: z.object({
    ready: z.boolean(),
    hostVersion: z.string(),
    protocolVersion: z.object({
      major: z.number().int().nonnegative(),
      minor: z.number().int().nonnegative(),
    }),
    busy: z.boolean(),
    /**
     * Total busy items blocking an update drain (the sum of
     * `busyBreakdown` when that is present). `null` means the host did not
     * report a count — NOT that it reported zero.
     */
    busySessionCount: z.number().int().nonnegative().nullable(),
    updateProgress: hostStatusUpdateProgressSchema.nullable(),
    busyBreakdown: hostBusyBreakdownSchema.nullable(),
  }),
});

// ---- v1.3: the durable update attempt ---------------------------------------
//
// `updateProgress` above is a two-state coarse marker: it can say "updating"
// and "failed" and nothing else. The durable attempt record (tech plan §1.3)
// knows which phase, against which target, whether the work is parked and on
// what continuation, and whether a segment that should be executing has no
// live holder. v1.3 puts that on the wire additively, and `updateProgress`
// keeps its exact released meaning for every peer below this minor.

const hostUpdateOperationPhaseSchema = z.enum([
  "downloading",
  "preparing",
  "applying",
  "waiting-for-work",
  "waiting-to-activate",
  "restarting",
  "verifying",
  "complete",
  "failed",
  "superseded",
]);
const hostUpdateOperationExecutionSchema = z.enum([
  "active",
  "parked",
  "terminal",
]);
const hostUpdateOperationContinuationSchema = z
  .enum(["resume-apply", "activate"])
  .nullable();
const hostUpdateOperationTriggerSchema = z.enum([
  "manual",
  "automatic",
  "support-floor",
]);

// The wire vocabulary IS the record vocabulary - asserted, not assumed. A
// phase added to the durable record without being added here would otherwise
// project as a silently dropped arm at the exact moment an update was in that
// phase. Mutual `extends` because one-directional assignability would accept a
// wire enum that had quietly grown an arm the record cannot produce.
type WireEquals<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : never
  : never;
const _updateOperationVocabularyAgrees: [
  WireEquals<
    z.infer<typeof hostUpdateOperationPhaseSchema>,
    HostUpdateAttemptPhase
  >,
  WireEquals<
    z.infer<typeof hostUpdateOperationExecutionSchema>,
    HostUpdateAttemptExecution
  >,
  WireEquals<
    z.infer<typeof hostUpdateOperationContinuationSchema>,
    HostUpdateAttemptContinuation
  >,
  WireEquals<
    z.infer<typeof hostUpdateOperationTriggerSchema>,
    HostUpdateTrigger
  >,
] = [true, true, true, true];
void _updateOperationVocabularyAgrees;

/**
 * The host's read-side conclusion about the attempt, joining the record with
 * evidence about the attempt lock's holder.
 *
 * A client CANNOT derive this: `update-attempt.lock` is a host-local file, and
 * the whole point of §1.5 is that `interrupted` requires POSITIVE proof that
 * no holder exists. `indeterminate` is a first-class answer here for exactly
 * that reason - a probe that could not run establishes nothing, and must not
 * be rendered as either a running update or an abandoned one.
 */
export const hostUpdateOperationLivenessSchema = z.enum([
  "active",
  "parked",
  "terminal",
  "interrupted",
  "indeterminate",
]);
export type HostUpdateOperationLiveness = z.infer<
  typeof hostUpdateOperationLivenessSchema
>;

/**
 * Total over what a host can establish about the durable attempt. Three
 * distinct "nothing to show" answers, because they are three different facts:
 *
 * - `none` - the record was read cleanly and there is no attempt.
 * - `unavailable` - the record is corrupt, unreadable, or a version this host
 *   cannot act on. Fail-closed EVIDENCE, deliberately not flattened into
 *   `none`: repair is a separate, deliberate action and the plan requires this
 *   stay visible in Diagnostics rather than reading as a quiet host.
 * - `attempt` - the projection.
 *
 * A fourth "nothing to show" lives one level up, as `updateOperation: null`,
 * and means the PEER did not say - see the field's own comment.
 */
export const hostStatusUpdateOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({
    kind: z.literal("unavailable"),
    reason: z.enum(["corrupt", "unsupported-version", "unreadable"]),
    /** Diagnostic detail where the host has one; never a user-facing string. */
    cause: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("attempt"),
    // `attemptId + generation + sequence` is the ordering key, in full. No
    // timestamp is carried: two peers with skewed clocks must not be able to
    // disagree about which observation is newer, and a client that could order
    // by `updatedAt` is a client that will.
    attemptId: z.string().min(1),
    generation: z.number().int().positive(),
    sequence: z.number().int().positive(),
    targetVersion: z.string().min(1),
    trigger: hostUpdateOperationTriggerSchema,
    phase: hostUpdateOperationPhaseSchema,
    execution: hostUpdateOperationExecutionSchema,
    continuation: hostUpdateOperationContinuationSchema,
    progress: z
      .object({
        percent: z.number().nullable(),
        bytes: z.number().nullable(),
        totalBytes: z.number().nullable(),
      })
      .nullable(),
    liveness: hostUpdateOperationLivenessSchema,
    /** Why liveness is `indeterminate`, when it is. `null` otherwise. */
    livenessCause: z.string().nullable(),
    // The live busy facts as of the SAME read that produced the phase above.
    // Duplicated from the top level deliberately: a drain affordance that
    // names a session count beside a phase must not be able to pair a count
    // from one instant with a phase from another. Same `null` semantics as
    // the top-level fields - "did not report", never "reported zero".
    busySessionCount: z.number().int().nonnegative().nullable(),
    busyBreakdown: hostBusyBreakdownSchema.nullable(),
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        phase: z.string(),
      })
      .nullable(),
  }),
]);
export type HostStatusUpdateOperation = z.infer<
  typeof hostStatusUpdateOperationSchema
>;

/**
 * What this host can do with schema-v2 attempt evidence.
 *
 * ## The fail-closed obligation, and exactly what it is scoped to
 *
 * §9.1: "Desktop must verify host transaction capability before local
 * apply/activation" — but read the sentence it lives in. That list is prefixed
 * "**Before new execution is enabled for a cohort**", and the same section
 * continues: "an incapable or unverifiable combination **continues the legacy
 * path only while the new authority is disabled**". §9.2 stages it the same
 * way: the compatibility release ships capability REPORTING "without changing
 * execution".
 *
 * So the obligation attaches to operations that run under the NEW attempt
 * authority. It is not a gate on today's legacy apply/activation, and wiring it
 * there would invert the plan: every pre-1.3 host — which today is the entire
 * deployed fleet — reports `null` here, so a `null`-refuses gate on the current
 * path would refuse to update precisely the hosts §9.1 says must continue on
 * the legacy path.
 *
 * The gate therefore arms with the cohort, at
 * `desktop/.../update-executor-cohort.ts`, which is statically
 * `{kind:"shadow", reason:"disabled"}` today. Until that flips, `null` here is
 * consumed as evidence (it is carried on `FleetUpdateWireObservation`) and
 * gates nothing — which is the correct behaviour for this stage, not a missing
 * consumer.
 *
 * An earlier revision of this comment said only "Consumers MUST fail closed on
 * `null`" with no scope, and a reviewer reasonably read it as a promise about
 * the current apply path. The scope is the whole content of the rule, so it is
 * stated here rather than left to the plan reference.
 *
 * Nullable rather than a fabricated `{ authority: "legacy" }` in the v1.2→v1.3
 * upgrade: an old peer said nothing, and "said nothing" is not the same claim
 * as "told us it runs the legacy authority", even when both lead a correct
 * consumer to the same refusal.
 *
 * It doubles as the one derivable test for "does this peer speak the attempt
 * protocol at all", which is what keeps `updateOperation: null` from
 * conflating an old peer with a new quiet one: a v1.3 host always populates
 * this, so `updateTransaction !== null` plus `updateOperation: null` cannot
 * happen, and `updateTransaction === null` means the peer is pre-1.3.
 */
export const hostUpdateTransactionCapabilitySchema = z.object({
  // A plain integer, not `z.literal(2)`: a literal would make a future v3 an
  // enum-value growth, which the registry validator refuses on a response
  // without an emission-gated declaration.
  recordSchemaVersion: z.number().int().positive(),
  /** Which execution authority this host currently selects. */
  authority: z.enum(["legacy", "attempt"]),
});
export type HostUpdateTransactionCapability = z.infer<
  typeof hostUpdateTransactionCapabilitySchema
>;

export const hostStatusV13 = defineRpcContract({
  method: "host.status",
  schemaVersion: { major: 1, minor: 3 } as const,
  requestSchema: z.object({}),
  responseSchema: z.object({
    ready: z.boolean(),
    hostVersion: z.string(),
    protocolVersion: z.object({
      major: z.number().int().nonnegative(),
      minor: z.number().int().nonnegative(),
    }),
    busy: z.boolean(),
    busySessionCount: z.number().int().nonnegative().nullable(),
    /**
     * The released coarse marker, unchanged. Still the ONLY update signal a
     * pre-1.3 peer receives, so it keeps its exact current meaning: set while
     * an update is in flight on this box, `null` otherwise.
     */
    updateProgress: hostStatusUpdateProgressSchema.nullable(),
    busyBreakdown: hostBusyBreakdownSchema.nullable(),
    /**
     * `null` means the PEER did not report - it is pre-1.3 and the v1.2→v1.3
     * upgrade wrote this. It does NOT mean "no update is running": a peer that
     * said nothing here may still be reporting one through `updateProgress`,
     * which is why that field remains the fallback rather than a legacy
     * duplicate.
     */
    updateOperation: hostStatusUpdateOperationSchema.nullable(),
    updateTransaction: hostUpdateTransactionCapabilitySchema.nullable(),
  }),
});

// A v1.0 peer never reports busy/update-progress state through this RPC.
//
// `busySessionCount` upgrades to `null`, NOT to `0`. This used to fabricate a
// zero, with a comment observing that no caller distinguished the default from
// a genuinely idle host. That stopped being true: the drain affordance now
// treats an absent count as "no live source" and withholds the destructive
// "Apply now — ends N sessions" force, while a real `0` is an affirmative
// statement that nothing is blocking. Manufacturing the zero here would put
// that affirmative claim in an old host's mouth — the client would believe the
// host had said "no sessions" when it said nothing at all, one negotiation
// layer below where anyone would think to look.
//
// `busy: false` stays a fabricated default: it drives a badge, not a
// destructive action, and there is no affordance whose safety turns on telling
// "not busy" apart from "did not say".
export const hostStatusUpgradeV10ToV11 = defineUpgradePath<
  typeof hostStatusV10,
  typeof hostStatusV11
>({
  from: hostStatusV10.schemaVersion,
  to: hostStatusV11.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    ...response,
    busy: false,
    busySessionCount: null,
    updateProgress: null,
  }),
});

// A v1.1 peer reports a total and never a typed split. `busyBreakdown`
// upgrades to `null`, NOT to a zero object: a real `{ workingAgents: 0,
// activeTerminalAgents: 0, busyTerminals: 0 }` is an affirmative "idle by
// every kind", while `null` is "did not say". The drain UI that starts to
// name kinds depends on that difference the same way the count UI depends
// on `busySessionCount: null` vs `0`.
export const hostStatusUpgradeV11ToV12 = defineUpgradePath<
  typeof hostStatusV11,
  typeof hostStatusV12
>({
  from: hostStatusV11.schemaVersion,
  to: hostStatusV12.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    ...response,
    busyBreakdown: null,
  }),
});

// A v1.2 peer knows nothing about the durable attempt record. BOTH new fields
// upgrade to `null`, and neither is fabricated:
//
// - `updateOperation: null` is "did not report", which is the truth. The
//   tempting alternative - `{ kind: "none" }` - is an affirmative "I read the
//   record and there is no attempt", said about a host that never read
//   anything. A client would then stop consulting `updateProgress`, which is
//   the ONLY update signal such a host actually emits, and an update in flight
//   would render as no update at all.
// - `updateTransaction: null` for the same reason, one level sharper: this
//   field is what a consumer fails closed on before a local apply/activation,
//   and manufacturing a capability statement for a peer that made none is how
//   a fail-closed gate quietly becomes a fail-open one. `null` is already
//   defined as "refuse", so nothing is lost by being honest here.
//
// This is the same rule `busySessionCount` and `busyBreakdown` follow above.
export const hostStatusUpgradeV12ToV13 = defineUpgradePath<
  typeof hostStatusV12,
  typeof hostStatusV13
>({
  from: hostStatusV12.schemaVersion,
  to: hostStatusV13.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    ...response,
    updateOperation: null,
    updateTransaction: null,
  }),
});
