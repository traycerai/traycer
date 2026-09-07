/**
 * `sessionImport.run@1.0` - versioned streaming-RPC contract for importing a wizard submission's worth of native sessions.
 * Import is a background bring-over the user is explicitly told to walk away from (it runs while the onboarding tour continues), so a closed tab, a reload, or a quit-and-restart must not leave half a submission behind.
 */
import { z } from "zod";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import {
  guiHarnessIdSchema,
  permissionModeSchema,
} from "@traycer/protocol/persistence/epic/foundation";
import {
  sessionImportFailureReasonSchema,
  sessionImportSelectionSchema,
} from "@traycer/protocol/host/session-import/candidate";

// The failure vocabulary lives with the candidate shapes, so the scan's
// `unreadable` state and a run's `failed` outcome name the same causes.
export {
  sessionImportFailureReasonSchema,
  type SessionImportFailureReason,
} from "@traycer/protocol/host/session-import/candidate";

export const sessionImportRunOpenRequestSchema = z.object({
  selections: z.array(sessionImportSelectionSchema),
  // The permission mode every imported chat continues under: the client's default for a NEW chat, so an imported task starts exactly as one the user created would.
  permissionMode: permissionModeSchema,
});
export type SessionImportRunOpenRequest = z.infer<
  typeof sessionImportRunOpenRequestSchema
>;

export const sessionImportOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("imported"),
    epicId: z.string().min(1),
    chatId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("skipped_already_imported"),
    epicId: z.string().min(1),
    chatId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("failed"),
    reason: sessionImportFailureReasonSchema,
    detail: z.string(),
  }),
]);
export type SessionImportOutcome = z.infer<typeof sessionImportOutcomeSchema>;

export const sessionImportRunCountsSchema = z.object({
  imported: z.number().int().nonnegative(),
  skippedAlreadyImported: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});
export type SessionImportRunCounts = z.infer<
  typeof sessionImportRunCountsSchema
>;

export const sessionImportRunServerFrameSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("started"),
    runId: z.string().min(1),
    total: z.number().int().nonnegative(),
    // False when this subscription STARTED the run, true when it attached to one already in flight (see the module doc).
    attached: z.boolean(),
    hasBinaryPayload: z.literal(false),
  }),
  z.object({
    kind: z.literal("progress"),
    runId: z.string().min(1),
    index: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    harness: guiHarnessIdSchema,
    nativeSessionId: z.string().min(1),
    outcome: sessionImportOutcomeSchema,
    hasBinaryPayload: z.literal(false),
  }),
  z.object({
    kind: z.literal("complete"),
    runId: z.string().min(1),
    counts: sessionImportRunCountsSchema,
    hasBinaryPayload: z.literal(false),
  }),
  z.object({
    kind: z.literal("pong"),
    hasBinaryPayload: z.literal(false),
  }),
]);
export type SessionImportRunServerFrame = z.infer<
  typeof sessionImportRunServerFrameSchema
>;

export const sessionImportRunClientFrameSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ping"),
    hasBinaryPayload: z.literal(false),
  }),
]);
export type SessionImportRunClientFrame = z.infer<
  typeof sessionImportRunClientFrameSchema
>;

export const sessionImportRunV10 = defineStreamRpcContract({
  method: "sessionImport.run",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: sessionImportRunOpenRequestSchema,
  serverFrameSchema: sessionImportRunServerFrameSchema,
  clientFrameSchema: sessionImportRunClientFrameSchema,
});
