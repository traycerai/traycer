/**
 * `sessionImport.run@1.0` - versioned streaming-RPC contract for importing a
 * wizard submission's worth of native sessions.
 *
 * One subscription per wizard submission. The host materializes each selected
 * session into a chat and reports one `progress` frame per selection, in
 * COMPLETION order - the host imports several sessions at a time and publishes
 * each frame as its session settles, so a client must key outcomes by
 * `(harness, nativeSessionId)` (or by the frame's own `index`) rather than by
 * arrival. A session's chat lands in the task for the REPOSITORY it ran in, so
 * one submission of N sessions produces at most one task per distinct
 * repository, not N tasks.
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
 * idempotent per `(harness, nativeSessionId)`. The idempotency is the host's
 * durable index of that pair, NOT a derived id - ids are random, drawn once per
 * logical job and never re-drawn - so re-submitting a partially-completed
 * selection set re-imports nothing and reports the finished ones as
 * `skipped_already_imported`. Note
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
import {
  guiHarnessIdSchema,
  guiHarnessIdSchemaPreAntigravity,
  permissionModeSchema,
  permissionModeSchemaPreAuto,
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
  // The permission mode every imported chat continues under: the client's
  // default for a NEW chat, so an imported task starts exactly as one the
  // user created would. The host has no default of its own to fall back on -
  // that setting lives in the client - and the source CLI's permission model
  // is not a signal, so nothing is inferred from the session. Ignored by a
  // subscribe that attaches to a run already in flight, like `selections`.
  permissionMode: permissionModeSchema,
});
export type SessionImportRunOpenRequest = z.infer<
  typeof sessionImportRunOpenRequestSchema
>;

/**
 * The open request as `1.0` and `1.1` shipped it: the same shape with the mode
 * pinned to the enum those peers strict-decode.
 *
 * Hand-frozen field-for-field rather than `.extend()`-ed off the live request,
 * on the same rule as the frozen settings tuples next door - a later required
 * field on the live shape must not leak onto a line released without it.
 *
 * Client→host slots normally stay on the live enum and let an old host reject
 * per-call (`framework/surface-compat.ts`'s advisory rule). `auto` is the case
 * that argument does not cover, from both ends: no released client can spell
 * the value, so there is no honest sender being narrowed out, and a CURRENT
 * host asked to run a `1.0` import would otherwise accept it and materialize
 * chats in a mode the wizard that asked cannot represent. `1.2` below is where
 * the value becomes sayable, which is exactly what makes that minor a
 * negotiable fact rather than a convention.
 */
export const sessionImportRunOpenRequestSchemaPreAuto = z.object({
  selections: z.array(sessionImportSelectionSchema),
  permissionMode: permissionModeSchemaPreAuto,
});

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

// The three arms that carry no harness id, shared verbatim by the live union
// and the frozen @1.0 copy below - only the `progress` arm's enum differs
// between them, so naming these keeps the two unions from drifting in any
// other respect.
const sessionImportRunStartedFrameSchema = z.object({
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
});

const sessionImportRunCompleteFrameSchema = z.object({
  kind: z.literal("complete"),
  runId: z.string().min(1),
  counts: sessionImportRunCountsSchema,
  hasBinaryPayload: z.literal(false),
});

const sessionImportRunPongFrameSchema = z.object({
  kind: z.literal("pong"),
  hasBinaryPayload: z.literal(false),
});

const sessionImportRunProgressFrameSchema = z.object({
  kind: z.literal("progress"),
  runId: z.string().min(1),
  index: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  harness: guiHarnessIdSchema,
  nativeSessionId: z.string().min(1),
  outcome: sessionImportOutcomeSchema,
  hasBinaryPayload: z.literal(false),
});

export const sessionImportRunServerFrameSchema = z.discriminatedUnion("kind", [
  sessionImportRunStartedFrameSchema,
  sessionImportRunProgressFrameSchema,
  sessionImportRunCompleteFrameSchema,
  sessionImportRunPongFrameSchema,
]);
export type SessionImportRunServerFrame = z.infer<
  typeof sessionImportRunServerFrameSchema
>;

/**
 * Frozen server-frame shape as `cli-v1.3.0` / `host-v1.3.0` shipped @1.0: the
 * `progress` arm's harness is pinned to the twenty ids those peers strict-
 * decode. Streams carry no downgrade bridge, so a host must GATE EMISSION on
 * the negotiated minor rather than expecting a projection to save it.
 */
export const sessionImportRunServerFrameSchemaPreAntigravity =
  z.discriminatedUnion("kind", [
    sessionImportRunStartedFrameSchema,
    sessionImportRunProgressFrameSchema.extend({
      harness: guiHarnessIdSchemaPreAntigravity,
    }),
    sessionImportRunCompleteFrameSchema,
    sessionImportRunPongFrameSchema,
  ]);

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
  openRequestSchema: sessionImportRunOpenRequestSchemaPreAuto,
  serverFrameSchema: sessionImportRunServerFrameSchemaPreAntigravity,
  clientFrameSchema: sessionImportRunClientFrameSchema,
});

/**
 * @1.1 is the first minor whose `progress` frames may name Antigravity. The
 * open request already accepted the id (client->host slots may widen freely for
 * a HARNESS - a released client's own roster is the gate), so this minor only
 * widens what the host is allowed to REPORT back. Its `permissionMode` stays on
 * the pre-`auto` enum for the reason on that schema: a mode has no such gate at
 * the far end, since the host materializes real chats from it.
 */
export const sessionImportRunV11 = defineStreamRpcContract({
  method: "sessionImport.run",
  schemaVersion: { major: 1, minor: 1 } as const,
  openRequestSchema: sessionImportRunOpenRequestSchemaPreAuto,
  serverFrameSchema: sessionImportRunServerFrameSchema,
  clientFrameSchema: sessionImportRunClientFrameSchema,
});

/**
 * `sessionImport.run@1.2` - the `auto` permission mode, and NOTHING ELSE.
 *
 * Every shape here is `1.1`'s, by reference, EXCEPT the open request: this is
 * the first minor whose `permissionMode` is the live enum. `1.0` and `1.1` keep
 * `sessionImportRunOpenRequestSchemaPreAuto`.
 *
 * That split is the whole minor. A client cannot detect from a shape whether
 * the host on the other end knows the value it is about to send; a `1.0` host
 * would take an `auto` import and reject it as a validation error mid-wizard,
 * after the user picked the sessions. So the minor carries no other delta and
 * is not meant to: it is the negotiable FACT that the host understands the
 * mode. A client that negotiates below `1.2` clamps a sticky or imported `auto`
 * down to `auto_accept_edits` before opening the run (NOT to the safest mode -
 * today's clamp walks to `supervised`, which would silently make an import
 * stricter than the user's own default).
 *
 * The pin below is what makes that clamp an invariant instead of a convention.
 * Left on the live enum, `auto` was expressible on `1.0` from the moment the
 * enum widened, and a client that forgot to clamp would have been taken at its
 * word by a CURRENT host - importing chats in a mode the wizard that asked for
 * them cannot render - rather than refused by the line it negotiated.
 */
export const sessionImportRunV12 = defineStreamRpcContract({
  method: "sessionImport.run",
  schemaVersion: { major: 1, minor: 2 } as const,
  openRequestSchema: sessionImportRunOpenRequestSchema,
  serverFrameSchema: sessionImportRunServerFrameSchema,
  clientFrameSchema: sessionImportRunClientFrameSchema,
});
