import { z } from "zod";

import { defineRpcContract } from "@traycer/protocol/framework/index";
import { chatSchema } from "@traycer/protocol/persistence/epic/chat";
import { chatEventSchema } from "@traycer/protocol/persistence/epic/chat-events";
import { messageSchema } from "@traycer/protocol/persistence/epic/messages";
import { tokenUsageSchema } from "@traycer/protocol/persistence/epic/foundation";
import {
  checkpointArtifactTagSchema,
  checkpointFileOperationSchema,
} from "@traycer/protocol/persistence/epic/checkpoint-manifests";
import {
  diffSourceSchema,
  fileEditReasonSchema,
} from "@traycer/protocol/persistence/epic/content-blocks";
import {
  rowSkeletonEntrySchema,
  type RowSkeletonEntry,
} from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import { transcriptRowContextSchema } from "@traycer/protocol/persistence/chat-transcript/row-context";
import {
  interviewAnswerabilitySchema,
  judgeInterviewAnswerability,
  type InterviewAnswerability,
} from "@traycer/protocol/persistence/chat-transcript/interview-answerability";
import { latestAssistantAuthFailureTurnKey } from "@traycer/protocol/persistence/chat-transcript/provider-auth-failure";
import {
  LOCATOR_MESSAGE_TEXT_MAX_CHARS,
  transcriptRowLocatorSchema,
  type TranscriptRowLocator,
} from "@traycer/protocol/persistence/chat-transcript/locate-row";
import {
  restorableSetupInterruptionSchema,
  selectRestorableSetupInterruption,
  type RestorableSetupInterruption,
} from "@traycer/protocol/persistence/chat-transcript/setup-interruption";
import { utf8ByteLength } from "@traycer/protocol/utils/text/utf8";
import { runtimeTodoStatusSchema } from "@traycer/protocol/host/agent/gui/agent-runtime";

/** The pinned todo stack's state, as the host folds it. */
export const pinnedTodoItemSchema = z.object({
  id: z.string(),
  status: runtimeTodoStatusSchema,
  text: z.string(),
  priority: z.string().nullable(),
  activeForm: z.string().nullable(),
});
export type PinnedTodoItem = z.infer<typeof pinnedTodoItemSchema>;

export const pinnedTodoSnapshotSchema = z.object({
  id: z.string(),
  items: z.array(pinnedTodoItemSchema),
});
export type PinnedTodoSnapshot = z.infer<typeof pinnedTodoSnapshotSchema>;

/**
 * Frames for a transcript the host serves in PIECES rather than whole.
 * A client that receives a range whose ids do not match its skeleton at that span discards it and refetches.
 */

/** Bound on a client-chosen `requestId`. */
export const RANGE_REQUEST_ID_MAX_CHARS = 128;

/** And a CHARSET, because a character bound is not a byte bound. */
export const RANGE_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** A `requestId` bounded in bytes, not just in code units. */
const rangeRequestIdSchema = z
  .string()
  .min(1)
  .max(RANGE_REQUEST_ID_MAX_CHARS)
  .regex(RANGE_REQUEST_ID_PATTERN);

/** Bound on the host-minted accumulated-change digest. */
export const ACCUMULATED_CHANGE_DIGEST_MAX_CHARS = 128;

/** The chat record WITHOUT its transcript. */
export const chatRecordSchema = chatSchema.omit({
  messages: true,
  events: true,
});
export type ChatRecord = z.infer<typeof chatRecordSchema>;

/** An accumulated file change with its before/after CONTENTS removed. */
export const chatAccumulatedFileChangeSummarySchema = z.object({
  filePath: z.string(),
  operation: checkpointFileOperationSchema,
  diffSource: diffSourceSchema,
  reason: fileEditReasonSchema,
  undoable: z.boolean(),
  /**
   * Whether contents are fetchable at all.
   * A change whose diff source is `none` has no before/after to ask for, and the client must render it as a plain row rather than offering a diff that would come back empty.
   */
  hasContents: z.boolean(),
  /**
   * Which VERSION of this file's accumulated change the summary describes.
   * Opaque to the client: echo it verbatim on {@link chatReadAccumulatedFileChangeRequestSchema}, never parse it.
   */
  digest: z.string().max(ACCUMULATED_CHANGE_DIGEST_MAX_CHARS),
  /**
   * The `+`/`-` the panel shows BEFORE anyone opens a diff.
   * `null` when there is nothing to count: a change whose `diffSource` is `none` has no before/after at all, which the panel must render as a bare row rather than as a zero-line diff.
   */
  counts: z
    .object({
      additions: z.number().int().nonnegative(),
      deletions: z.number().int().nonnegative(),
    })
    .nullable(),
  artifact: checkpointArtifactTagSchema.nullish(),
});
export type ChatAccumulatedFileChangeSummary = z.infer<
  typeof chatAccumulatedFileChangeSummarySchema
>;

/** The unary fetch behind a summary - `chat.readAccumulatedFileChange`. */
export const chatReadAccumulatedFileChangeRequestSchema = z.object({
  epicId: z.string(),
  chatId: z.string(),
  filePath: z.string(),
  /** Copied verbatim from the summary being displayed. */
  digest: z.string().max(ACCUMULATED_CHANGE_DIGEST_MAX_CHARS),
});
export type ChatReadAccumulatedFileChangeRequest = z.infer<
  typeof chatReadAccumulatedFileChangeRequestSchema
>;

/** Contents for one accumulated change. */
export const chatReadAccumulatedFileChangeResponseSchema = z.discriminatedUnion(
  "stale",
  [
    z.object({
      stale: z.literal(false),
      beforeContent: z.string().nullable(),
      afterContent: z.string().nullable(),
    }),
    z.object({ stale: z.literal(true) }),
  ],
);
export type ChatReadAccumulatedFileChangeResponse = z.infer<
  typeof chatReadAccumulatedFileChangeResponseSchema
>;

/**
 * The contents fetch behind an accumulated-change summary.
 * Safe to register immediately, unlike the windowed stream line: a unary method flips no negotiation, so a client that never calls it is unaffected by its presence.
 */
export const chatReadAccumulatedFileChangeV10 = defineRpcContract({
  method: "chat.readAccumulatedFileChange",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: chatReadAccumulatedFileChangeRequestSchema,
  responseSchema: chatReadAccumulatedFileChangeResponseSchema,
});

/** The locator shape a `chat.locateRow` request carries, and its search. */
export {
  transcriptRowLocatorSchema,
  type TranscriptRowLocator,
  LOCATOR_MESSAGE_TEXT_MAX_CHARS,
};

/**
 * Where a jump target sits in the transcript - `chat.locateRow`.
 * Without this the jump deadlocks rather than degrading: the scroll drives hydration and the scroll is what is being held back, so the target is never requested and the request parks forever.
 */
export const chatLocateRowRequestSchema = z.object({
  epicId: z.string(),
  chatId: z.string(),
  target: transcriptRowLocatorSchema,
});
export type ChatLocateRowRequest = z.infer<typeof chatLocateRowRequestSchema>;

/**
 * The ordinal, or the one opaque refusal.
 * It was never about staleness, which is a different question and needs an answer.
 */
export const chatLocateRowResponseSchema = z.discriminatedUnion("found", [
  z.object({
    found: z.literal(true),
    ordinal: z.number().int().nonnegative(),
    /** The transcript epoch the ordinal is numbered in. */
    epoch: z.number().int().nonnegative(),
  }),
  z.object({ found: z.literal(false) }),
]);
export type ChatLocateRowResponse = z.infer<typeof chatLocateRowResponseSchema>;

/**
 * Registered `degrade: { kind: "unsupported" }`, like the accumulated-change read beside it: a GUI meeting an older host falls back to waiting for the target to arrive on its own, which is the pre-windowed behavior and.
 * A unary method flips no negotiation, so registering it cannot disturb a client that never calls it.
 */
export const chatLocateRowV10 = defineRpcContract({
  method: "chat.locateRow",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: chatLocateRowRequestSchema,
  responseSchema: chatLocateRowResponseSchema,
});

/**
 * Values the host derives from the WHOLE transcript and the client therefore cannot compute once it only holds a window.
 */
/** A setup failure or cancellation the composer can put a draft back from. */
export {
  restorableSetupInterruptionSchema,
  selectRestorableSetupInterruption,
  type RestorableSetupInterruption,
};

/** The two answers a windowed client would otherwise read out of an ABSENCE. */
export {
  interviewAnswerabilitySchema,
  judgeInterviewAnswerability,
  latestAssistantAuthFailureTurnKey,
  type InterviewAnswerability,
};

/**
 * One setup lifecycle window's identity, as the WHOLE-LOG partition sees it.
 * What it cannot derive in isolation is where the window sits in the sequence and whether it is still open, and that is exactly what this carries.
 */
export const setupCardWindowIdentitySchema = z.object({
  /** The window's anchor - the earliest setup-event timestamp in it. */
  createdAt: z.number(),
  /** The window's position in the whole-log partition. */
  windowIndex: z.number().int().nonnegative(),
  /**
   * True only for the window still OPEN at the end of the log.
   * A closed window keeps whatever state its last event left it in - which CAN be `setting-up` when the worktree vanished mid-setup - so a client must read this rather than infer liveness from the state.
   */
  isActive: z.boolean(),
  /**
   * The timestamp of the event that CLOSED this window, or `null` while it is still open.
   * The boundary a slice cannot see, published because the client cannot derive it.
   */
  closedAt: z.number().nullable().optional(),
  hasCreatingEvent: z.boolean(),
});
export type SetupCardWindowIdentity = z.infer<
  typeof setupCardWindowIdentitySchema
>;

export const chatTranscriptDerivedSchema = z.object({
  /**
   * The most recent assistant usage report, for the context chip.
   * Nullable rather than optional: "no assistant row has reported usage" is a real state on a fresh chat, and the client must render the chip's empty form rather than treat it as "not supported".
   */
  latestAssistantUsage: tokenUsageSchema.nullable(),
  /**
   * The pinned-todo fold's result.
   * The fold is a stateful accumulator with a reset rule keyed on user rows, so it cannot be evaluated over a window - a client holding the tail alone would show the todos of whatever turn it happens to have hydrated.
   */
  pinnedTodo: pinnedTodoSnapshotSchema.nullable(),
  /** The task-tool accumulator behind {@link pinnedTodo}, as of the same fold. */
  pinnedTaskTodoItems: z.array(pinnedTodoItemSchema),
  /**
   * The message id a fork of this chat would cut at - what the composer's switch-host gesture means by "fork the chat as it stands".
   * `null` when the chat has no boundary yet (the agent has never replied, or its only assistant turn is the one running right now), which the gesture reports rather than opening a dialog pointed at nothing.
   */
  latestForkableAssistantMessageId: z.string().nullable(),
  /**
   * The setup interruption the composer would restore a draft from.
   * A row-less event is in no row's record set, so `sliceTranscriptTail` never includes it and `loadRange` - addressed by ordinal - can never ask for it.
   */
  restorableSetupInterruption: restorableSetupInterruptionSchema.nullable(),
  /** Where each host-pending interview's answer card would render. */
  interviewAnswerability: z.array(interviewAnswerabilitySchema),
  /**
   * The nudge key of the latest assistant turn when that turn ended in a recoverable provider-auth failure, `null` when it did not.
   * `null` is the ordinary state and means "the last turn did not fail on a credential" - never "not hydrated".
   */
  latestAssistantAuthFailureTurnKey: z.string().nullable(),
  /**
   * Every setup lifecycle window in the chat, in chronological order.
   * Bounded by the number of setup lifecycles a chat has had - one for most chats, a handful for a heavily re-bound one - never by rows.
   */
  setupCardWindows: z.array(setupCardWindowIdentitySchema),
});
export type ChatTranscriptDerived = z.infer<typeof chatTranscriptDerivedSchema>;

/**
 * The hydrated rows a snapshot ships inline - the streaming tail.
 * Always present and always hydrated, because the tail is where a live turn happens: the client must be able to render the active turn and the last few rows the instant the snapshot lands, without a round trip.
 */
export const chatTranscriptWindowSchema = z.object({
  fromOrdinal: z.number().int().nonnegative(),
  /**
   * One ROW id per row in the tail, in order - the same identity echo a `range` carries, and read the same way.
   * The tail is emitted BEFORE the skeleton streams, so the client cannot check these against an index it does not have yet.
   */
  rowIds: z.array(z.string()).optional(),
  /** Rows whose required record set is incomplete in this tail. */
  incompleteRowIds: z.array(z.string()).optional(),
  messages: z.array(messageSchema),
  events: z.array(chatEventSchema),
  /**
   * What the tail's rows render WITH, by row id - see {@link chatRangeResponseSchema}'s field of the same name.
   */
  rowContext: z.record(z.string(), transcriptRowContextSchema).optional(),
});
export type ChatTranscriptWindow = z.infer<typeof chatTranscriptWindowSchema>;

/**
 * A slice of the skeleton.
 * `isFinal` marks the last one - the point at which the client's skeleton is complete and `rowCount` must agree with what it has assembled.
 */
export const chatSkeletonChunkSchema = z.object({
  epoch: z.number().int().nonnegative(),
  fromOrdinal: z.number().int().nonnegative(),
  entries: z.array(rowSkeletonEntrySchema),
  isFinal: z.boolean(),
});
export type ChatSkeletonChunk = z.infer<typeof chatSkeletonChunkSchema>;

/**
 * What changed about the index, as a DELTA.
 * Never a fresh index: on a long chat that would be a megabyte-scale frame per mutation, which is both the cost this feature exists to remove and a violation of the 1 MiB invariant.
 */
export const chatIndexChangeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("appended"),
    entries: z.array(rowSkeletonEntrySchema),
  }),
  z.object({
    type: z.literal("updated"),
    entries: z.array(
      z.object({
        ordinal: z.number().int().nonnegative(),
        entry: rowSkeletonEntrySchema,
      }),
    ),
  }),
  z.object({ type: z.literal("reindexed") }),
]);
export type ChatIndexChange = z.infer<typeof chatIndexChangeSchema>;

/** A range of hydrated bodies, answering one `loadRange`. */
export const chatRangeResponseSchema = z.object({
  requestId: rangeRequestIdSchema,
  epoch: z.number().int().nonnegative(),
  fromOrdinal: z.number().int().nonnegative(),
  /**
   * One ROW id per served row, in order.
   * Record identity cannot address a row - see `row-projection.ts`.
   */
  rowIds: z.array(z.string()),
  /** Rows whose required record set is incomplete in this response. */
  incompleteRowIds: z.array(z.string()).optional(),
  /** The DEDUPLICATED union of records the served rows render from - not a parallel array to `rowIds`. */
  messages: z.array(messageSchema),
  events: z.array(chatEventSchema),
  /**
   * What the served rows render WITH, by row id.
   * Absent for a row means "the projection has nothing to add", NOT a default - a consumer falls back to its own derivation, which is what keeps a host predating a field from silently asserting one.
   */
  rowContext: z.record(z.string(), transcriptRowContextSchema).default({}),
  reachedStart: z.boolean(),
  reachedEnd: z.boolean(),
  truncatedAtOrdinal: z.number().int().nonnegative().optional(),
});
export type ChatRangeResponse = z.infer<typeof chatRangeResponseSchema>;

/**
 * A request for a span of bodies.
 * A `snapshot` or an `indexChanged` has no such protection and must stay under the ceiling.
 */
/**
 * `range` responses are budgeted by `sliceTranscriptRange`, and the snapshot's tail by `sliceTranscriptTail`.
 */
export const SKELETON_CHUNK_MAX_BYTES = 256 * 1024;
export const INDEX_CHANGE_MAX_BYTES = 256 * 1024;

/** The ceiling on a bounded snapshot's ENCODED size. */
export const WINDOWED_SNAPSHOT_MAX_BYTES = 1024 * 1024;

/**
 * What the frame costs on top of the snapshot payload itself.
 * A RESERVE, not a measurement: the exact envelope is a few hundred bytes (two uuids, a discriminator, the mux header), and this is rounded far above it so that adding an envelope field later cannot silently consume the.
 */
export const WINDOWED_SNAPSHOT_FRAME_OVERHEAD_BYTES = 4 * 1024;

/** A contiguous run of items small enough to ship as one frame. */
export interface EncodedChunk<Item> {
  readonly fromIndex: number;
  readonly items: readonly Item[];
  readonly isFinal: boolean;
}

/**
 * Splits a list into frame-sized chunks, measured on the ENCODED bytes.
 * A client that receives no chunk cannot tell "there is nothing" from "the chunks were lost".
 */
export function chunkByEncodedBytes<Item>(
  items: readonly Item[],
  maxBytes: number,
): readonly EncodedChunk<Item>[] {
  const chunks: EncodedChunk<Item>[] = [];
  let start = 0;
  let spent = 0;

  for (let index = 0; index < items.length; index += 1) {
    const cost = utf8ByteLength(JSON.stringify(items[index])) + 1;
    if (index > start && spent + cost > maxBytes) {
      chunks.push({
        fromIndex: start,
        items: items.slice(start, index),
        isFinal: false,
      });
      start = index;
      spent = 0;
    }
    spent += cost;
  }

  chunks.push({ fromIndex: start, items: items.slice(start), isFinal: true });
  return chunks;
}

/** A contiguous run of skeleton entries small enough to ship as one frame. */
export interface RowSkeletonChunkPlan {
  readonly fromOrdinal: number;
  readonly entries: readonly RowSkeletonEntry[];
  readonly isFinal: boolean;
}

/**
 * Splits a skeleton into frame-sized chunks.
 * A client that receives no chunk at all cannot tell "this chat has no rows" from "chunks were lost".
 */
export function chunkRowSkeleton(
  entries: readonly RowSkeletonEntry[],
  maxBytes: number,
): readonly RowSkeletonChunkPlan[] {
  return chunkByEncodedBytes(
    entries,
    Math.min(maxBytes, SKELETON_CHUNK_MAX_BYTES),
  ).map((chunk) => ({
    fromOrdinal: chunk.fromIndex,
    entries: chunk.items,
    isFinal: chunk.isFinal,
  }));
}

/** Whether one frame's worth of index changes is small enough to send as one. */
export function indexChangeFits(
  changes: readonly ChatIndexChange[],
  maxBytes: number,
): boolean {
  const isFallback =
    changes.length > 0 &&
    changes.every((change) => change.type === "reindexed");
  if (isFallback) return true;
  return (
    utf8ByteLength(JSON.stringify(changes)) <
    Math.min(maxBytes, INDEX_CHANGE_MAX_BYTES)
  );
}

/**
 * The byte budget for one accumulated-change chunk.
 * A broad refactor touches thousands, and at ~200 encoded bytes each that is the whole frame budget spent on a panel the user may never open.
 */
export const ACCUMULATED_CHANGE_CHUNK_MAX_BYTES = 256 * 1024;

/**
 * A slice of the accumulated-change summaries.
 * `isFinal` marks the last one, at which point the client's list must agree with the snapshot's `accumulatedFileChangeCount`.
 */
export const chatAccumulatedChangeChunkSchema = z.object({
  epoch: z.number().int().nonnegative(),
  /** Which RE-STREAM this chunk belongs to. */
  generation: z.number().int().nonnegative(),
  fromIndex: z.number().int().nonnegative(),
  summaries: z.array(chatAccumulatedFileChangeSummarySchema),
  isFinal: z.boolean(),
});
export type ChatAccumulatedChangeChunk = z.infer<
  typeof chatAccumulatedChangeChunkSchema
>;

/**
 * Whether a bounded snapshot actually fits the frame it claims to.
 * A producer that gets `false` cannot simply truncate: every field left inline is something a renderer reads unconditionally.
 */
export function windowedSnapshotFitsFrame(
  snapshot: unknown,
  maxBytes: number,
): boolean {
  return (
    utf8ByteLength(JSON.stringify(snapshot)) +
      WINDOWED_SNAPSHOT_FRAME_OVERHEAD_BYTES <
    Math.min(maxBytes, WINDOWED_SNAPSHOT_MAX_BYTES)
  );
}

export const chatLoadRangeRequestSchema = z.object({
  requestId: rangeRequestIdSchema,
  epoch: z.number().int().nonnegative(),
  fromOrdinal: z.number().int().nonnegative(),
  toOrdinal: z.number().int().nonnegative(),
  /** The client's budget. */
  maxBytes: z.number().int().positive(),
});
export type ChatLoadRangeRequest = z.infer<typeof chatLoadRangeRequestSchema>;
