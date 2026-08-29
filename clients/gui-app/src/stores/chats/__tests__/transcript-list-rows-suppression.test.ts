import { describe, expect, it } from "vitest";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import type {
  HydratedSpan,
  TranscriptWindow,
} from "@/stores/chats/transcript-window";
import { transcriptListRows } from "@/stores/chats/transcript-list-rows";
import { buildPinnedTodoRenderState } from "@/components/chat/chat-pinned-todos";

function model(id: string): ChatMessageModel {
  return {
    id,
    role: "assistant",
    content: `body of ${id}`,
    segments: [],
    structuredContent: null,
    attachments: [],
    settings: null,
    createdAt: 1000,
    completedAt: null,
    stopped: null,
    persistentMessageId: id,
    senderLabel: null,
    assistantMeta: null,
    statusLabel: null,
    agentSenderInfo: null,
    agentMessage: null,
    runState: null,
    sessionAnchor: null,
    steerBadge: null,
  };
}

/**
 * A record the host pushed whole and no span carries yet - what
 * `TranscriptWindow.liveMessages` holds between a `messageAccepted` and the
 * range that seats it.
 */
function liveMessage(messageId: string): Message {
  return {
    role: "user",
    messageId,
    sender: { type: "user", userId: "owner-1" },
    message: {
      kind: "user",
      content: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "hi" }] },
        ],
      },
      browserAnnotations: [],
    },
    timestamp: 1000,
    sessionAnchor: null,
  };
}

function entry(rowId: string): RowSkeletonEntry {
  return {
    rowId,
    createdAt: 1000,
    role: "assistant",
    byteLength: 32,
    bodyDigest: `d-${rowId}`,
  };
}

function span(fromOrdinal: number, rowIds: readonly string[]): HydratedSpan {
  return {
    fromOrdinal,
    rowIds,
    messages: [],
    events: [],
    rowContext: {},
    bytes: rowIds.length * 32,
    contextBytes: 0,
    touchedAt: 1,
    servedAt: 1,
  };
}

function windowOf(
  rowCount: number,
  spans: readonly HydratedSpan[],
  skeleton: readonly (RowSkeletonEntry | undefined)[],
): TranscriptWindow {
  return {
    epoch: 1,
    rowCount,
    indexRevision: 1,
    indexRevisionRebuilding: false,
    skeleton,
    skeletonComplete: true,
    skeletonStreamCoveredThrough: rowCount,
    spans,
    liveMessages: [],
    liveEvents: [],
    hydratedBytes: spans.reduce((sum, item) => sum + item.bytes, 0),
    unsettledByteMessageIds: [],
    invalidated: false,
    clock: 1,
  };
}

describe("transcriptListRows renderer-policy suppression", () => {
  it("omits a span row the pinned-todo renderer policy actually drops", () => {
    // A real todo-only assistant row, run through the real renderer policy -
    // rather than an empty `rendered: []` asserted by fiat, which would pass
    // even if the policy stopped dropping anything.
    const todoOnlyMessage: ChatMessageModel = {
      ...model("r-1"),
      segments: [
        {
          id: "r-1:todo",
          kind: "todo",
          items: [
            {
              id: "todo-item-1",
              status: "pending",
              text: "task",
              priority: null,
              activeForm: null,
            },
          ],
        },
      ],
    };
    const { messages: rendered } = buildPinnedTodoRenderState(
      [todoOnlyMessage],
      { kind: "derive" },
    );
    // Sanity: the policy really did drop the row (a completed assistant
    // message left with no segments after the todo is stripped out).
    expect(rendered).toEqual([]);

    const rows = transcriptListRows({
      window: windowOf(
        3,
        [span(1, ["r-1"])],
        [entry("r-0"), entry("r-1"), entry("r-2")],
      ),
      rendered,
    });

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.ordinal)).toEqual([0, 2]);
    expect(rows.some((row) => row.ordinal === 1)).toBe(false);
    expect(rows.some((row) => row.key === "r-1")).toBe(false);
  });

  it("emits the hydrated row when the renderer includes its model", () => {
    const rows = transcriptListRows({
      window: windowOf(
        3,
        [span(1, ["r-1"])],
        [entry("r-0"), entry("r-1"), entry("r-2")],
      ),
      rendered: [model("r-1")],
    });

    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatchObject({ kind: "hydrated", key: "r-1", ordinal: 1 });
  });

  /**
   * The gap between "the index names this row" and "a span carries its body".
   *
   * A live record arrives with no ordinal and renders from `liveMessages`. The
   * next `indexChanged` names its row id - and from that moment the row is
   * neither placed (no span covers it, and `placedRowIds` is built from spans
   * alone) nor unplaced (the skeleton names it). Dropping it there replaces a
   * body this client is HOLDING with a skeleton placeholder, which is what a
   * user watching the message they just sent turn back into a grey bar sees.
   *
   * `pruneSupersededLiveRecords` drops a live record only once a SPAN carries
   * it, so the record really is still in `rendered` for this whole gap.
   */
  it("seats a live record at the ordinal the index has started naming", () => {
    const rows = transcriptListRows({
      // Only ordinal 0 is spanned; the index names r-1 and r-2 but no range
      // has delivered either body yet. r-1 is one this client HOLDS, pushed as
      // a live record and not yet superseded by a span.
      window: {
        ...windowOf(
          3,
          [span(0, ["r-0"])],
          [entry("r-0"), entry("r-1"), entry("r-2")],
        ),
        liveMessages: [liveMessage("r-1")],
      },
      rendered: [model("r-0"), model("r-1")],
    });

    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatchObject({ kind: "hydrated", key: "r-1", ordinal: 1 });
    // And exactly once - not additionally appended as an ordinal-less row,
    // which would show the same message twice.
    expect(rows.filter((row) => row.key === "r-1")).toHaveLength(1);
    // The row the index names and nothing holds is still a placeholder.
    expect(rows[2]).toMatchObject({ kind: "placeholder", ordinal: 2 });
  });

  /**
   * The discriminating half, and the reason the seat above is gated on live
   * records rather than on "the renderer produced a model for it".
   *
   * Hydrating one row of a steer-split assistant turn pulls the turn's shared
   * records, and rendering those projects EVERY row of the turn - including
   * ones no range ever served. Those models are the client's own inference at
   * an ordinal the host declined to serve, so they must keep reading as
   * placeholders. Identical fixture to the seat above, minus the live record.
   */
  it("leaves a projected row - one no live record backs - as a placeholder", () => {
    const rows = transcriptListRows({
      window: windowOf(
        3,
        [span(0, ["r-0"])],
        [entry("r-0"), entry("r-1"), entry("r-2")],
      ),
      rendered: [model("r-0"), model("r-1")],
    });

    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatchObject({ kind: "placeholder", ordinal: 1 });
    // And not appended after the ordinals either - it owns one.
    expect(rows.some((row) => row.ordinal === null)).toBe(false);
  });
});
