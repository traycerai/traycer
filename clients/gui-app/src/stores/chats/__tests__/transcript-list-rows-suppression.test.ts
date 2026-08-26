import { describe, expect, it } from "vitest";
import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import type {
  HydratedSpan,
  TranscriptWindow,
} from "@/stores/chats/transcript-window";
import { transcriptListRows } from "@/stores/chats/transcript-list-rows";

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
  return { rowId, createdAt: 1000, role: "assistant", byteLength: 32 };
}

function span(fromOrdinal: number, rowIds: readonly string[]): HydratedSpan {
  return {
    fromOrdinal,
    rowIds,
    messages: [],
    events: [],
    bytes: rowIds.length * 32,
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
    skeleton,
    skeletonComplete: true,
    spans,
    liveMessages: [],
    liveEvents: [],
    hydratedBytes: spans.reduce((sum, item) => sum + item.bytes, 0),
    unsettledByteRowIds: [],
    invalidated: false,
    clock: 1,
  };
}

describe("transcriptListRows renderer-policy suppression", () => {
  it("omits a span row withheld by the pinned-todo filter", () => {
    const rows = transcriptListRows({
      window: windowOf(
        3,
        [span(1, ["r-1"])],
        [entry("r-0"), entry("r-1"), entry("r-2")],
      ),
      rendered: [],
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
