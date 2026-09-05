/**
 * Durable plain-terminal wire projections and unary request/response schemas.
 *
 * This is deliberately a separate `terminal.plain.*` family. The released
 * generic `terminal.*` family also carries terminal-agent sessions and cannot
 * be canonicalized into a durable plain-terminal record without inventing
 * host identity and revision data that its old wire shapes never carried.
 *
 * Request objects are strict at every level that accepts client-authored data.
 * In particular, clients cannot supply ownership, an environment, or a
 * resolved shell executable. The host derives those values from the
 * authenticated request and its own configuration.
 */
import { z } from "zod";
import { isoMillisecondTimestampSchema } from "@traycer/protocol/common/schemas";

export const epicPlainTerminalScopeSchema = z.strictObject({
  kind: z.literal("epic"),
  epicId: z.string().min(1),
});
export type EpicPlainTerminalScope = z.infer<
  typeof epicPlainTerminalScopeSchema
>;

export const independentPlainTerminalScopeSchema = z.strictObject({
  kind: z.literal("independent"),
});
export type IndependentPlainTerminalScope = z.infer<
  typeof independentPlainTerminalScopeSchema
>;

export const plainTerminalScopeSchema = z.discriminatedUnion("kind", [
  epicPlainTerminalScopeSchema,
  independentPlainTerminalScopeSchema,
]);
export type PlainTerminalScope = z.infer<typeof plainTerminalScopeSchema>;

/** Host-resolved launch definition. It is output-only on the public surface. */
export const plainTerminalLaunchSchema = z.strictObject({
  cwd: z.string().min(1),
  shellCommand: z.string().min(1),
  shellArgs: z.array(z.string()),
});
export type PlainTerminalLaunch = z.infer<typeof plainTerminalLaunchSchema>;

/**
 * Durable logical record. `ownerUserId` and internal persistence keys are
 * intentionally absent; authorization comes from the request context.
 * `hostId` is required on every projection; `(hostId, terminalId)` is the
 * fleet identity and is immutable for a terminal's lifetime.
 */
export const plainTerminalRecordSchema = z.strictObject({
  terminalId: z.string().min(1),
  hostId: z.string().min(1),
  scope: plainTerminalScopeSchema,
  launch: plainTerminalLaunchSchema,
  manualTitle: z.string().nullable(),
  revision: z.number().int().nonnegative(),
  createdAt: isoMillisecondTimestampSchema,
  updatedAt: isoMillisecondTimestampSchema,
});
export type PlainTerminalRecord = z.infer<typeof plainTerminalRecordSchema>;

/**
 * Fleet identity for a durable plain terminal. Bare `terminalId` is not a
 * fleet key; collections, lookup maps, and mutation race bookkeeping use
 * `(hostId, terminalId)`.
 */
export type PlainTerminalFleetIdentity = {
  readonly hostId: string;
  readonly terminalId: string;
};

export function plainTerminalFleetIdentity(
  record: Pick<PlainTerminalRecord, "hostId" | "terminalId">,
): PlainTerminalFleetIdentity {
  return { hostId: record.hostId, terminalId: record.terminalId };
}

/**
 * Canonical map key for `(hostId, terminalId)`. JSON-tuple encoding is
 * injective over schema-valid strings, including identifiers that contain
 * NUL or other delimiter bytes.
 */
export function plainTerminalFleetIdentityKey(
  identity: PlainTerminalFleetIdentity,
): string {
  return JSON.stringify([identity.hostId, identity.terminalId]);
}

export const dormantPlainTerminalRuntimeSchema = z.strictObject({
  status: z.literal("dormant"),
});
export type DormantPlainTerminalRuntime = z.infer<
  typeof dormantPlainTerminalRuntimeSchema
>;

/**
 * The durable record is known, but no fresh owner-host or runtime-presence
 * observation is available. This is deliberately distinct from `dormant`:
 * absence from an unavailable ephemeral plane is not evidence that the PTY
 * is stopped.
 */
export const unknownPlainTerminalRuntimeSchema = z.strictObject({
  status: z.literal("unknown"),
});
export type UnknownPlainTerminalRuntime = z.infer<
  typeof unknownPlainTerminalRuntimeSchema
>;

/**
 * Live-only metadata. The logical launch cwd remains on the record while
 * `currentCwd` follows the running shell; a manual title never replaces the
 * independently reported foreground process.
 */
export const runningPlainTerminalRuntimeSchema = z.strictObject({
  status: z.literal("running"),
  // The first implementation intentionally keeps this equal to terminalId.
  sessionId: z.string().min(1),
  currentCwd: z.string().min(1),
  activeProcessName: z.string().nullable(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});
export type RunningPlainTerminalRuntime = z.infer<
  typeof runningPlainTerminalRuntimeSchema
>;

export const plainTerminalRuntimeSchema = z.discriminatedUnion("status", [
  unknownPlainTerminalRuntimeSchema,
  dormantPlainTerminalRuntimeSchema,
  runningPlainTerminalRuntimeSchema,
]);
export type PlainTerminalRuntime = z.infer<typeof plainTerminalRuntimeSchema>;

export const plainTerminalProjectionSchema = z
  .strictObject({
    record: plainTerminalRecordSchema,
    runtime: plainTerminalRuntimeSchema,
  })
  .superRefine((projection, ctx) => {
    if (
      projection.runtime.status === "running" &&
      projection.runtime.sessionId !== projection.record.terminalId
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["runtime", "sessionId"],
        message: "sessionId must equal the logical terminalId",
      });
    }
  });
export type PlainTerminalProjection = z.infer<
  typeof plainTerminalProjectionSchema
>;

export const runningPlainTerminalProjectionSchema = z
  .strictObject({
    record: plainTerminalRecordSchema,
    runtime: runningPlainTerminalRuntimeSchema,
  })
  .superRefine((projection, ctx) => {
    if (projection.runtime.sessionId !== projection.record.terminalId) {
      ctx.addIssue({
        code: "custom",
        path: ["runtime", "sessionId"],
        message: "sessionId must equal the logical terminalId",
      });
    }
  });
export type RunningPlainTerminalProjection = z.infer<
  typeof runningPlainTerminalProjectionSchema
>;

const plainTerminalGridHintFields = {
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
} as const;

export const createPlainTerminalRequestSchema = z.strictObject({
  terminalId: z.string().min(1),
  scope: plainTerminalScopeSchema,
  cwd: z.string().min(1),
  ...plainTerminalGridHintFields,
});
export type CreatePlainTerminalRequest = z.infer<
  typeof createPlainTerminalRequestSchema
>;

export const createPlainTerminalResponseSchema = z.strictObject({
  terminal: runningPlainTerminalProjectionSchema,
});
export type CreatePlainTerminalResponse = z.infer<
  typeof createPlainTerminalResponseSchema
>;

export const listPlainTerminalsRequestSchema = z.strictObject({
  scope: plainTerminalScopeSchema,
});
export type ListPlainTerminalsRequest = z.infer<
  typeof listPlainTerminalsRequestSchema
>;

const plainTerminalListTerminalsField = {
  terminals: z.array(plainTerminalProjectionSchema),
} as const;

export const completeFleetPlainTerminalListStateSchema = z.strictObject({
  coverage: z.literal("complete-fleet"),
  scope: epicPlainTerminalScopeSchema,
  ...plainTerminalListTerminalsField,
});
export type CompleteFleetPlainTerminalListState = z.infer<
  typeof completeFleetPlainTerminalListStateSchema
>;

export const partialServingHostPlainTerminalListStateSchema = z.strictObject({
  coverage: z.literal("partial-serving-host"),
  scope: epicPlainTerminalScopeSchema,
  servingHostId: z.string().min(1),
  ...plainTerminalListTerminalsField,
});
export type PartialServingHostPlainTerminalListState = z.infer<
  typeof partialServingHostPlainTerminalListStateSchema
>;

export const completeLocalPlainTerminalListStateSchema = z.strictObject({
  coverage: z.literal("complete-local"),
  scope: independentPlainTerminalScopeSchema,
  ...plainTerminalListTerminalsField,
});
export type CompleteLocalPlainTerminalListState = z.infer<
  typeof completeLocalPlainTerminalListStateSchema
>;

function plainTerminalScopesEqual(
  left: PlainTerminalScope,
  right: PlainTerminalScope,
): boolean {
  if (left.kind === "independent") {
    return right.kind === "independent";
  }
  return right.kind === "epic" && right.epicId === left.epicId;
}

function refinePlainTerminalListState(
  state:
    | CompleteFleetPlainTerminalListState
    | PartialServingHostPlainTerminalListState
    | CompleteLocalPlainTerminalListState,
  ctx: z.RefinementCtx,
): void {
  const seenTerminalIdsByHostId = new Map<string, Set<string>>();
  for (let index = 0; index < state.terminals.length; index += 1) {
    const terminal = state.terminals[index];
    if (terminal === undefined) {
      continue;
    }
    if (!plainTerminalScopesEqual(terminal.record.scope, state.scope)) {
      ctx.addIssue({
        code: "custom",
        path: ["terminals", index, "record", "scope"],
        message: "projection scope must match the list state scope",
      });
    }
    if (
      state.coverage === "partial-serving-host" &&
      terminal.record.hostId !== state.servingHostId
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["terminals", index, "record", "hostId"],
        message: "projection hostId must match servingHostId",
      });
    }
    const hostId = terminal.record.hostId;
    const terminalId = terminal.record.terminalId;
    const seenTerminalIds = seenTerminalIdsByHostId.get(hostId);
    if (seenTerminalIds === undefined) {
      seenTerminalIdsByHostId.set(hostId, new Set([terminalId]));
    } else if (seenTerminalIds.has(terminalId)) {
      ctx.addIssue({
        code: "custom",
        path: ["terminals", index, "record"],
        message: "duplicate (hostId, terminalId) in list state",
      });
    } else {
      seenTerminalIds.add(terminalId);
    }
  }
}

/**
 * Replacement collection state for `terminal.plain.list@2` and subscribe
 * `state` frames. Coverage distinguishes an authoritative empty fleet from a
 * degraded serving-host-only view and from a complete independent local
 * collection. Host withdrawal is absence from a later replacement state, not
 * a durable tombstone.
 */
export const plainTerminalListStateSchema = z
  .discriminatedUnion("coverage", [
    completeFleetPlainTerminalListStateSchema,
    partialServingHostPlainTerminalListStateSchema,
    completeLocalPlainTerminalListStateSchema,
  ])
  .superRefine(refinePlainTerminalListState);
export type PlainTerminalListState =
  | CompleteFleetPlainTerminalListState
  | PartialServingHostPlainTerminalListState
  | CompleteLocalPlainTerminalListState;
export type PlainTerminalListCoverage = PlainTerminalListState["coverage"];

export const listPlainTerminalsResponseSchema = plainTerminalListStateSchema;
export type ListPlainTerminalsResponse = PlainTerminalListState;

export const renamePlainTerminalRequestSchema = z.strictObject({
  terminalId: z.string().min(1),
  manualTitle: z.string().nullable(),
});
export type RenamePlainTerminalRequest = z.infer<
  typeof renamePlainTerminalRequestSchema
>;

export const renamePlainTerminalResponseSchema = z.strictObject({
  terminal: plainTerminalProjectionSchema,
});
export type RenamePlainTerminalResponse = z.infer<
  typeof renamePlainTerminalResponseSchema
>;

export const ensurePlainTerminalRunningRequestSchema = z.strictObject({
  terminalId: z.string().min(1),
  ...plainTerminalGridHintFields,
});
export type EnsurePlainTerminalRunningRequest = z.infer<
  typeof ensurePlainTerminalRunningRequestSchema
>;

export const ensurePlainTerminalRunningResponseSchema = z.strictObject({
  terminal: runningPlainTerminalProjectionSchema,
});
export type EnsurePlainTerminalRunningResponse = z.infer<
  typeof ensurePlainTerminalRunningResponseSchema
>;

export const closePlainTerminalRequestSchema = z.strictObject({
  terminalId: z.string().min(1),
});
export type ClosePlainTerminalRequest = z.infer<
  typeof closePlainTerminalRequestSchema
>;

/**
 * The deletion revision orders a close against stale cached mutation
 * results. Collection streams do not emit durable tombstones for host
 * withdrawal; this revision remains only for explicit lifetime-delete races.
 */
export const closePlainTerminalResponseSchema = z.strictObject({
  terminalId: z.string().min(1),
  revision: z.number().int().nonnegative(),
});
export type ClosePlainTerminalResponse = z.infer<
  typeof closePlainTerminalResponseSchema
>;

export const legacyPlainTerminalTitleSourceSchema = z.enum([
  "default",
  "manual",
]);
export type LegacyPlainTerminalTitleSource = z.infer<
  typeof legacyPlainTerminalTitleSourceSchema
>;

export const importLegacyPlainTerminalRequestSchema = z.strictObject({
  terminalId: z.string().min(1),
  // Legacy evidence includes the persisted binding. The resolver must compare
  // it with the current host rather than treating it as client-selected scope.
  hostId: z.string().min(1),
  scope: plainTerminalScopeSchema,
  cwd: z.string().min(1),
  name: z.string(),
  titleSource: legacyPlainTerminalTitleSourceSchema,
  sourceStoreVersion: z.number().int().nonnegative(),
});
export type ImportLegacyPlainTerminalRequest = z.infer<
  typeof importLegacyPlainTerminalRequestSchema
>;

export const importLegacyPlainTerminalResponseSchema = z.discriminatedUnion(
  "status",
  [
    z.strictObject({
      status: z.literal("imported"),
      terminal: plainTerminalProjectionSchema,
    }),
    z.strictObject({
      status: z.literal("existing"),
      terminal: plainTerminalProjectionSchema,
    }),
    z.strictObject({
      status: z.literal("deleted"),
      terminalId: z.string().min(1),
      revision: z.number().int().nonnegative(),
    }),
  ],
);
export type ImportLegacyPlainTerminalResponse = z.infer<
  typeof importLegacyPlainTerminalResponseSchema
>;
