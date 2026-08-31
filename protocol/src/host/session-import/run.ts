/**
 * `sessionImport.run@1.0` - versioned streaming-RPC contract for importing a
 * wizard submission's worth of native sessions.
 *
 * One subscription per wizard submission. The host materializes each selected
 * session into a real epic + chat and reports one `progress` frame per
 * selection, in submission order.
 *
 * ## The run outlives the socket, deliberately
 *
 * Closing the WS does NOT abort the run - the opposite of `migration.run`,
 * whose loop watches its connection-scoped `RequestContext`. Import is a
 * background bring-over the user is explicitly told to walk away from (it runs
 * while the onboarding tour continues), so a closed tab, a reload, or a
 * quit-and-restart must not leave half a submission behind. Re-subscribing
 * ATTACHES to the run already in flight: the host replays `started` and every
 * `progress` frame it has produced so far, then continues live. A subscribe
 * that arrives while a run is active therefore ignores its own `selections` -
 * there is at most one run at a time, and `runId` is how a client tells the
 * run it is watching from the one it asked for.
 *
 * Resumability across a host restart is free rather than engineered: import is
 * idempotent per `(harness, nativeSessionId)` (the chat id is derived from the
 * pair), so re-submitting a partially-completed selection set re-imports
 * nothing and reports the finished ones as `skipped_already_imported`. Note
 * what that does and does not promise: a restart drops the run, and the host
 * resumes NOTHING on its own - picking the remainder back up requires a client
 * to re-submit, which is safe precisely because the re-submission is
 * idempotent.
 *
 * There is no cancel in v1.
 *
 * Server frames:
 *
 * - `started`  - emitted once per subscription, including on re-attach.
 * - `progress` - one per selection, terminal for that selection.
 * - `complete` - terminal frame; carries the summary the wizard renders.
 * - `pong`     - heartbeat response.
 *
 * Client frames:
 *
 * - `ping` - heartbeat. No application client frames.
 */
import { z } from "zod";
import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import { guiHarnessIdSchema } from "@traycer/protocol/persistence/epic/foundation";
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
    // False when this subscription STARTED the run, true when it attached to
    // one already in flight (see the module doc). The wizard needs the
    // difference: an attach ignores the `selections` it just submitted, and the
    // `progress` frames that follow are a replay of work already done, not
    // live progress on this client's request.
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
