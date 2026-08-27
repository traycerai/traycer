import { describe, expect, it } from "vitest";
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
    skeleton,
    skeletonComplete: true,
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
});
