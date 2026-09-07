import { z } from "zod";
import {
  defineRpcContract,
  defineUpgradePath,
} from "@traycer/protocol/framework/index";
// TYPE-ONLY, and it must stay that way.
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
 * Mirror of `traycer-host`'s host-local `HostUpdateProgress` (itself a mirror of `@traycerai/common/types/host` in the internal monorepo - this open-source package cannot depend on it).
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
 * Typed breakdown of {@link hostStatusV12}'s `busySessionCount` total, reused by `host.restart` @1.2 and the unnegotiated `hostRuntimeStatus` awareness field.
 * Counts are non-negative; a missing breakdown is `null` (unknown), never a fabricated zero object.
 */
export const hostBusyBreakdownSchema = z.object({
  workingAgents: z.number().int().nonnegative(),
  activeTerminalAgents: z.number().int().nonnegative(),
  busyTerminals: z.number().int().nonnegative(),
});
export type HostBusyBreakdown = z.infer<typeof hostBusyBreakdownSchema>;

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
    /** Open sessions blocking an update drain. */
    busySessionCount: z.number().int().nonnegative().nullable(),
    updateProgress: hostStatusUpdateProgressSchema.nullable(),
  }),
});

/** v1.2 adds a typed `busyBreakdown` beside the existing total. */
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
    /** Total busy items blocking an update drain (the sum of `busyBreakdown` when that is present). */
    busySessionCount: z.number().int().nonnegative().nullable(),
    updateProgress: hostStatusUpdateProgressSchema.nullable(),
    busyBreakdown: hostBusyBreakdownSchema.nullable(),
  }),
});

// ---- v1.3: the durable update attempt ---------------------------------------

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

// The wire vocabulary IS the record vocabulary - asserted, not assumed.
// Mutual `extends` because one-directional assignability would accept a wire enum that had quietly grown an arm the record cannot produce.
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
 * The host's read-side conclusion about the attempt, joining the record with evidence about the attempt lock's holder.
 * A client CANNOT derive this: `update-attempt.lock` is a host-local file, and the whole point of §1.5 is that `interrupted` requires POSITIVE proof that no holder exists.
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
 * Total over what a host can establish about the durable attempt.
 * `none` - the record was read cleanly and there is no attempt. - `unavailable` - the record is corrupt, unreadable, or a version this host cannot act on.
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
    // `attemptId + generation + sequence` is the ordering key, in full.
    // No timestamp is carried: two peers with skewed clocks must not be able to disagree about which observation is newer, and a client that could order by `updatedAt` is a client that will.
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
    // Same `null` semantics as the top-level fields - "did not report", never "reported zero".
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
 * §9.1: "Desktop must verify host transaction capability before local apply/activation" - but read the sentence it lives in.
 */
export const hostUpdateTransactionCapabilitySchema = z.object({
  recordSchemaVersion: z.number().int().positive(),
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
    /** The released coarse marker, unchanged. */
    updateProgress: hostStatusUpdateProgressSchema.nullable(),
    busyBreakdown: hostBusyBreakdownSchema.nullable(),
    /** `null` means the PEER did not report - it is pre-1.3 and the v1.2→v1.3 upgrade wrote this. */
    updateOperation: hostStatusUpdateOperationSchema.nullable(),
    updateTransaction: hostUpdateTransactionCapabilitySchema.nullable(),
  }),
});

// A v1.0 peer never reports busy/update-progress state through this RPC.
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

// A v1.1 peer reports a total and never a typed split.
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

// A v1.2 peer knows nothing about the durable attempt record.
// The tempting alternative - `{ kind: "none" }` - is an affirmative "I read the record and there is no attempt", said about a host that never read anything.
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
