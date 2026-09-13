import { describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  ChatEvent,
  Message,
} from "@traycer/protocol/persistence/epic/schemas";
import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import type { ChatRangeResponse } from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import { assistantRowId } from "@traycer/protocol/persistence/chat-transcript/row-projection";
import {
  appendLiveRecords,
  applyRangeResponse,
  applySkeletonChunk,
  applyWindowedSnapshot,
  emptyTranscriptWindow,
  hydratedRecords,
  settleWindowBytes,
  transcriptWindowChargedBytes,
  type TranscriptWindow,
} from "@/stores/chats/transcript-window";

/**
 * `reconcileServedTurnMembership` closes a specific gap: a steer that lands
 * before the model has written anything makes the host COLLAPSE the turn's
 * original (empty) assistant row and continue the turn under a fresh
 * `messageId` in a new row. Nothing on the wire retracts the original - it
 * was already served to this client under the row it occupied, so it
 * survives a rebase into `staleSpans` (or as an unplaced `liveMessages`
 * record) forever, and the renderer folds it into the turn as a phantom
 * prefix ("ghost").
 *
 * A COMPLETE serve of the turn (the row is not in `incompleteRowIds`) is the
 * only thing that can prove the ghost is gone: it lists every record the host
 * still holds for that turn, and a record of the same turn the window is
 * holding outside the fresh tier, that the serve does not list, is retired.
 */

const CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
};

function userMessage(messageId: string, timestamp: number): Message {
  return {
    role: "user",
    messageId,
    sender: { type: "user", userId: "owner-1" },
    message: { kind: "user", content: CONTENT, browserAnnotations: [] },
    timestamp,
    sessionAnchor: null,
  };
}

function assistantMessage(
  messageId: string,
  turnId: string | null,
  timestamp: number,
): Extract<Message, { role: "assistant" }> {
  return {
    role: "assistant",
    messageId,
    sender: {
      type: "agent",
      harnessId: "codex",
      agentId: "codex",
      displayName: "Codex",
      reply: { expectsReply: false },
      inReplyTo: null,
    },
    blocks: [],
    startedAt: timestamp,
    timestamp,
    turnId,
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
    envCredentialVar: null,
    imageResolutions: [],
  };
}

function skeletonEntry(rowId: string, ordinal: number): RowSkeletonEntry {
  return {
    rowId,
    createdAt: 1000 + ordinal,
    role: "user",
    byteLength: 128,
    bodyDigest: `d-${rowId}`,
  };
}

function rangeResponse(input: {
  readonly epoch: number;
  readonly fromOrdinal: number;
  readonly rowIds: readonly string[];
  readonly incompleteRowIds?: readonly string[];
  readonly messages: readonly Message[];
  readonly events?: readonly ChatEvent[];
}): ChatRangeResponse {
  return {
    requestId: `req-${input.fromOrdinal}`,
    epoch: input.epoch,
    fromOrdinal: input.fromOrdinal,
    rowIds: [...input.rowIds],
    incompleteRowIds: [...(input.incompleteRowIds ?? [])],
    messages: [...input.messages],
    events: [...(input.events ?? [])],
    rowContext: {},
    reachedStart: input.fromOrdinal === 0,
    reachedEnd: false,
  };
}

/**
 * A window with a two-row skeleton at epoch 1 and nothing hydrated: a
 * survivor `row-0` and a second, freely named row.
 */
function windowWithSkeletonRows(
  rowIds: readonly [string, string],
): TranscriptWindow {
  const seeded = applyWindowedSnapshot(
    emptyTranscriptWindow(),
    {
      epoch: 1,
      rowCount: rowIds.length,
      indexRevision: null,
      tail: { fromOrdinal: rowIds.length, messages: [], events: [] },
    },
    null,
    null,
  );
  return applySkeletonChunk(seeded, {
    epoch: 1,
    fromOrdinal: 0,
    entries: rowIds.map((rowId, index) => skeletonEntry(rowId, index)),
    isFinal: true,
  });
}

/**
 * The production defect shape: a provisional row ("assistant:turn:prov") is
 * served complete at epoch 1 holding the turn's collapsed, empty original
 * body ("ghost"). A rebase to epoch 2 demotes that whole span to
 * `staleSpans`; the epoch-2 skeleton then re-lists the turn under its
 * canonical row id (`assistantRowId("T")`), a DIFFERENT row id from the
 * provisional one - so nothing at the skeleton layer can tell the two rows
 * are the same turn. Only a complete serve of that canonical row settles it.
 */
function rebasedWindowWithGhost(): TranscriptWindow {
  const epoch1 = windowWithSkeletonRows(["row-0", "assistant:turn:prov"]);
  const served = applyRangeResponse(
    epoch1,
    rangeResponse({
      epoch: 1,
      fromOrdinal: 0,
      rowIds: ["row-0", "assistant:turn:prov"],
      messages: [userMessage("m-0", 0), assistantMessage("ghost", "T", 1)],
    }),
    null,
    null,
  );
  const rebased = applyWindowedSnapshot(
    served,
    {
      epoch: 2,
      rowCount: 2,
      indexRevision: null,
      tail: { fromOrdinal: 2, messages: [], events: [] },
    },
    null,
    null,
  );
  return applySkeletonChunk(rebased, {
    epoch: 2,
    fromOrdinal: 0,
    entries: [skeletonEntry("row-0", 0), skeletonEntry(assistantRowId("T"), 1)],
    isFinal: true,
  });
}

describe("reconcileServedTurnMembership", () => {
  it("retires a ghost record the complete serve does not list", () => {
    const before = rebasedWindowWithGhost();
    expect(before.staleSpans).toHaveLength(1);
    expect(before.staleSpans[0].messageIds).toContain("ghost");

    const after = applyRangeResponse(
      before,
      rangeResponse({
        epoch: 2,
        fromOrdinal: 1,
        rowIds: [assistantRowId("T")],
        messages: [assistantMessage("real", "T", 2)],
      }),
      null,
      null,
    );

    const hydratedIds = hydratedRecords(after).messages.map(
      (message) => message.messageId,
    );
    expect(hydratedIds).not.toContain("ghost");
    expect(hydratedIds).toContain("m-0");
    expect(hydratedIds).toContain("real");

    // The stale span itself survives (row-0 is still uncovered by the fresh
    // tier) - only the ghost's membership is dropped from it.
    expect(after.staleSpans).toHaveLength(1);
    expect(after.staleSpans[0].messageIds).not.toContain("ghost");
    expect(after.staleSpans[0].rowIds).toContain("row-0");

    // Retired from the ledger too, not merely unreferenced by a span.
    expect(after.records.messages.has("ghost")).toBe(false);
    expect(after.hydratedBytes).toBe(transcriptWindowChargedBytes(after));
  });

  it("keeps a legitimate non-empty prefix the serve's membership still lists", () => {
    const before = rebasedWindowWithGhost();

    const after = applyRangeResponse(
      before,
      rangeResponse({
        epoch: 2,
        fromOrdinal: 1,
        rowIds: [assistantRowId("T")],
        // The serve lists "ghost" itself alongside the continuation - a
        // legitimate non-empty prefix the host still holds.
        messages: [
          assistantMessage("ghost", "T", 1),
          assistantMessage("real", "T", 2),
        ],
      }),
      null,
      null,
    );

    const hydratedIds = hydratedRecords(after).messages.map(
      (message) => message.messageId,
    );
    expect(hydratedIds).toContain("ghost");
    expect(hydratedIds).toContain("real");
    expect(after.records.messages.has("ghost")).toBe(true);
  });

  it("retires nothing when the serve of the turn is incomplete", () => {
    const before = rebasedWindowWithGhost();

    const after = applyRangeResponse(
      before,
      rangeResponse({
        epoch: 2,
        fromOrdinal: 1,
        rowIds: [assistantRowId("T")],
        incompleteRowIds: [assistantRowId("T")],
        messages: [assistantMessage("real", "T", 2)],
      }),
      null,
      null,
    );

    expect(after.staleSpans[0].messageIds).toContain("ghost");
    expect(after.records.messages.has("ghost")).toBe(true);
  });

  it("never reconciles the active turn", () => {
    const before = rebasedWindowWithGhost();

    const after = applyRangeResponse(
      before,
      rangeResponse({
        epoch: 2,
        fromOrdinal: 1,
        rowIds: [assistantRowId("T")],
        messages: [assistantMessage("real", "T", 2)],
      }),
      "T",
      null,
    );

    expect(after.staleSpans[0].messageIds).toContain("ghost");
    expect(after.records.messages.has("ghost")).toBe(true);
  });

  it("retires an unplaced live ghost record", () => {
    const epoch1 = windowWithSkeletonRows(["row-0", assistantRowId("T")]);
    const withLiveGhost = appendLiveRecords(epoch1, {
      messages: [assistantMessage("ghost", "T", 1)],
      events: [],
    });
    expect(withLiveGhost.liveMessages.map((m) => m.messageId)).toContain(
      "ghost",
    );

    const after = applyRangeResponse(
      withLiveGhost,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 1,
        rowIds: [assistantRowId("T")],
        messages: [assistantMessage("real", "T", 2)],
      }),
      null,
      null,
    );

    expect(after.liveMessages.map((m) => m.messageId)).not.toContain("ghost");
    const hydratedIds = hydratedRecords(after).messages.map(
      (message) => message.messageId,
    );
    expect(hydratedIds).not.toContain("ghost");
    expect(hydratedIds).toContain("real");
    // The stored charge is re-derived after the live tail shrinks - the
    // ghost's bytes leave the figure the budget reads, not only the tail.
    expect(after.hydratedBytes).toBe(transcriptWindowChargedBytes(after));
  });

  it("never reconciles an unplaced live ghost of the active turn", () => {
    const epoch1 = windowWithSkeletonRows(["row-0", assistantRowId("T")]);
    const withLiveGhost = appendLiveRecords(epoch1, {
      messages: [assistantMessage("ghost", "T", 1)],
      events: [],
    });

    const after = applyRangeResponse(
      withLiveGhost,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 1,
        rowIds: [assistantRowId("T")],
        messages: [assistantMessage("real", "T", 2)],
      }),
      "T",
      null,
    );

    expect(after.liveMessages.map((m) => m.messageId)).toContain("ghost");
  });

  it("leaves a stale record of a different turn untouched by this turn's serve", () => {
    const epoch1 = applySkeletonChunk(
      applyWindowedSnapshot(
        emptyTranscriptWindow(),
        {
          epoch: 1,
          rowCount: 2,
          indexRevision: null,
          tail: { fromOrdinal: 2, messages: [], events: [] },
        },
        null,
        null,
      ),
      {
        epoch: 1,
        fromOrdinal: 0,
        entries: [
          skeletonEntry(assistantRowId("U"), 0),
          skeletonEntry("assistant:turn:prov", 1),
        ],
        isFinal: true,
      },
    );
    const served = applyRangeResponse(
      epoch1,
      rangeResponse({
        epoch: 1,
        fromOrdinal: 0,
        rowIds: [assistantRowId("U"), "assistant:turn:prov"],
        messages: [
          assistantMessage("other", "U", 0),
          assistantMessage("ghost", "T", 1),
        ],
      }),
      null,
      null,
    );
    const rebased = applyWindowedSnapshot(
      served,
      {
        epoch: 2,
        rowCount: 2,
        indexRevision: null,
        tail: { fromOrdinal: 2, messages: [], events: [] },
      },
      null,
      null,
    );
    const before = applySkeletonChunk(rebased, {
      epoch: 2,
      fromOrdinal: 0,
      entries: [
        skeletonEntry(assistantRowId("U"), 0),
        skeletonEntry(assistantRowId("T"), 1),
      ],
      isFinal: true,
    });
    expect(before.staleSpans[0].messageIds).toEqual(
      expect.arrayContaining(["other", "ghost"]),
    );

    const after = applyRangeResponse(
      before,
      rangeResponse({
        epoch: 2,
        fromOrdinal: 1,
        rowIds: [assistantRowId("T")],
        messages: [assistantMessage("real", "T", 2)],
      }),
      null,
      null,
    );

    // "ghost" (turn T) is retired; "other" (turn U) is untouched, even though
    // both lived in the same stale span.
    expect(after.staleSpans[0].messageIds).not.toContain("ghost");
    expect(after.staleSpans[0].messageIds).toContain("other");
    expect(after.records.messages.has("other")).toBe(true);
  });

  it("retires a stale ghost via the snapshot tail seat, not only a range", () => {
    const before = rebasedWindowWithGhost();
    expect(before.staleSpans[0].messageIds).toContain("ghost");

    const rebasedAgain = applyWindowedSnapshot(
      before,
      {
        epoch: 3,
        rowCount: 2,
        indexRevision: null,
        tail: {
          fromOrdinal: 1,
          rowIds: [assistantRowId("T")],
          messages: [assistantMessage("real", "T", 2)],
          events: [],
        },
      },
      null,
      null,
    );

    const hydratedIds = hydratedRecords(rebasedAgain).messages.map(
      (message) => message.messageId,
    );
    expect(hydratedIds).not.toContain("ghost");
    expect(hydratedIds).toContain("real");
  });

  it("keeps the charge figure finite, and lower than if the ghost had survived", () => {
    const before = rebasedWindowWithGhost();
    const serve = rangeResponse({
      epoch: 2,
      fromOrdinal: 1,
      rowIds: [assistantRowId("T")],
      messages: [assistantMessage("real", "T", 2)],
    });

    // Same serve, applied twice: once as the active turn (so the ghost
    // survives - see the "never reconciles the active turn" test above) and
    // once not (so it is retired). The retired window's charge must not
    // exceed the survived one's, which isolates the ghost's own bytes rather
    // than comparing against a state that never added "real" at all.
    const survived = applyRangeResponse(before, serve, "T", null);
    const retired = applyRangeResponse(before, serve, null, null);

    const survivedBytes = transcriptWindowChargedBytes(survived);
    const retiredBytes = transcriptWindowChargedBytes(retired);
    expect(Number.isFinite(survivedBytes)).toBe(true);
    expect(Number.isFinite(retiredBytes)).toBe(true);
    expect(retiredBytes).toBeLessThanOrEqual(survivedBytes);
    expect(() => settleWindowBytes(retired)).not.toThrow();
  });
});
