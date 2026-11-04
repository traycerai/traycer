import { describe, expect, it } from "vitest";
import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import type { TranscriptListRow } from "@/stores/chats/transcript-list-rows";
import type { TranscriptWindow } from "@/stores/chats/transcript-window";
import {
  CHAT_TURN_MINIMAP_HIT_STRIP_MAX_WIDTH,
  CHAT_TURN_MINIMAP_PREVIEW_MAX_CHARS,
  chatTurnMinimapItems,
  compactChatTurnMinimapPreview,
  resolveChatTurnMinimapCurrentIndex,
  resolveChatTurnMinimapHitStripWidth,
  resolveChatTurnMinimapTopStyle,
  shouldRunChatTurnMinimapRail,
} from "@/components/chat/chat-turn-minimap-logic";
import { MINIMAP_TRACK_END_HIT_PADDING } from "@/components/minimap/minimap-track-geometry";
import { transcriptListRows } from "@/stores/chats/transcript-list-rows";
import { ROW_SKELETON_PREVIEW_MAX_CHARS } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";

function skeletonEntry(
  rowId: string,
  role: "user" | "assistant",
  preview: string | null,
): RowSkeletonEntry {
  return {
    rowId,
    createdAt: 1000,
    role,
    byteLength: 32,
    bodyDigest: `d-${rowId}`,
    ...(preview === null ? {} : { preview }),
  };
}

function userModel(id: string, content: string): ChatMessageModel {
  return {
    id,
    role: "user",
    content,
    segments: [],
    structuredContent: null,
    attachments: [],
    settings: null,
    createdAt: 1000,
    completedAt: 1000,
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

function assistantModel(id: string, content: string): ChatMessageModel {
  return { ...userModel(id, content), role: "assistant" };
}

/**
 * What `transcriptListRows` produces for a window whose assistant row is
 * streaming: a new array whose hydrated row carries a NEW model object per
 * token, beside a placeholder whose identity the skeleton cache holds stable.
 */
function listRowsFor(
  window: TranscriptWindow,
  assistantContent: string,
): ReadonlyArray<TranscriptListRow> {
  return transcriptListRows({
    splitLongTurns: true,
    window,
    rendered: [assistantModel("r-1", assistantContent)],
  });
}

const TURNS = [
  { rowIndex: 0, endRowIndex: 1 },
  { rowIndex: 2, endRowIndex: 3 },
  { rowIndex: 4, endRowIndex: 5 },
] as const;
const POSITIONS = [0, 100, 300, 400, 700, 800] as const;

function currentAt(scroll: number, scrollLength: number): number | null {
  return resolveChatTurnMinimapCurrentIndex(
    {
      scroll,
      scrollLength,
      positionAtIndex: (index) => POSITIONS[index],
      sizeAtIndex: () => 100,
    },
    TURNS,
  );
}

describe("chat turn minimap logic", () => {
  it("uses the user query whose full turn occupies most of the viewport", () => {
    expect(currentAt(330, 300)).toBe(1);
    expect(currentAt(720, 70)).toBe(2);
  });

  it("highlights a visible user query over the previous reply", () => {
    expect(currentAt(500, 250)).toBe(2);
  });

  it("keeps the earlier query on an equal visibility tie", () => {
    expect(currentAt(0, 400)).toBe(0);
  });

  it("falls back to the nearest user query when no turn intersects", () => {
    expect(currentAt(-200, 50)).toBe(0);
  });

  it("uses transcript padding for a compact rail in tiled panes", () => {
    expect(
      resolveChatTurnMinimapHitStripWidth({
        rootFontSize: 15,
        viewportWidth: 720,
      }),
    ).toBe(11);
    expect(
      resolveChatTurnMinimapHitStripWidth({
        rootFontSize: 15,
        viewportWidth: 1200,
      }),
    ).toBe(CHAT_TURN_MINIMAP_HIT_STRIP_MAX_WIDTH);
  });

  it("keeps endpoint markers inside the hit target", () => {
    expect(resolveChatTurnMinimapTopStyle(0, 3)).toBe(
      `calc(0% + ${MINIMAP_TRACK_END_HIT_PADDING}px)`,
    );
    expect(resolveChatTurnMinimapTopStyle(2, 3)).toBe(
      `calc(100% - ${MINIMAP_TRACK_END_HIT_PADDING}px)`,
    );
  });

  it("uses a short, whitespace-collapsed query label", () => {
    expect(compactChatTurnMinimapPreview("  A\n\n useful   query ")).toBe(
      "A useful query",
    );
  });

  // The skeleton ships one char past the minimap's budget so the compactor
  // can see a 201st character and know to append "…" (row-skeleton.ts's
  // ROW_SKELETON_PREVIEW_MAX_CHARS doc). If the minimap cap ever rises to
  // meet or pass the protocol cap, every long user turn silently loses its
  // truncation ellipsis.
  it("stays strictly below the protocol row-skeleton preview cap", () => {
    expect(CHAT_TURN_MINIMAP_PREVIEW_MAX_CHARS).toBeLessThan(
      ROW_SKELETON_PREVIEW_MAX_CHARS,
    );
  });
});

function windowWith(
  entries: ReadonlyArray<RowSkeletonEntry>,
): TranscriptWindow {
  return {
    epoch: 1,
    rowCount: entries.length,
    indexRevision: 1,
    indexRevisionRebuilding: false,
    skeleton: entries,
    skeletonRevision: 0,
    skeletonComplete: true,
    // Fully delivered: the prefix reached the end of the index.
    skeletonStreamCoveredThrough: entries.length,
    // The assistant row is hydrated - it is the one taking tokens. It
    // draws no ledger record in this fixture (the minimap derive reads only
    // `skeleton`/`spans` shape, never record bodies or byte figures), so
    // the ledger stays empty and the span references nothing.
    records: { messages: new Map(), events: new Map(), revision: 0 },
    spans: [
      {
        fromOrdinal: 1,
        rowIds: ["r-1"],
        messageIds: [],
        eventIds: [],
        rowContext: {},
        contextBytes: 0,
      },
    ],
    staleSpans: [],
    carriedSkeleton: [],
    liveMessages: [],
    liveEvents: [],
    snapshotProvisionalMessageIds: [],
    snapshotProvisionalEventIds: [],
    unavailableRowIds: [],
    unavailableRowOrdinals: [],
    hydratedBytes: 0,
    evictionTerminal: "none",
    unsettledByteMessageIds: [],
    invalidated: false,
    visibleOrdinals: null,
    clock: 1,
  };
}

/**
 * The rail's derive is a whole-transcript scan plus a per-turn allocation and
 * preview compaction. `rows` is rebuilt on every streaming token, so keying the
 * derive on it ran all of that dozens of times a second - O(history) work in
 * the structure that exists to make long chats cheap.
 *
 * A block delta folds into `messages` and never touches the `TranscriptWindow`
 * (`applyBufferedDeltas`), so the window is the identity that survives exactly
 * that churn. These pin the derive to it.
 *
 * The assertions are on REFERENTIAL identity, deliberately: a `toEqual` here
 * passes against the bug, because re-deriving produces an equal answer. Only
 * "the same array came back" says the scan did not run.
 */
describe("chatTurnMinimapItems caching", () => {
  const skeleton: ReadonlyArray<RowSkeletonEntry> = [
    skeletonEntry("r-0", "user", "first question"),
    skeletonEntry("r-1", "assistant", null),
  ];

  it("does not re-derive across a pure block delta", () => {
    const window = windowWith(skeleton);
    // The streaming assistant row: same row, new model object per token, so a
    // NEW `rows` array each time - which is what `transcriptListRows` produces.
    const rowsBefore = listRowsFor(window, "the reply so f");
    const rowsAfter = listRowsFor(window, "the reply so far");
    expect(rowsAfter).not.toBe(rowsBefore);

    const first = chatTurnMinimapItems({
      rows: rowsBefore,
      window,
      senderFirst: false,
    });
    const second = chatTurnMinimapItems({
      rows: rowsAfter,
      window,
      senderFirst: false,
    });

    expect(second).toBe(first);
    expect(first.map((item) => item.messageId)).toEqual(["r-0"]);
  });

  it("re-derives when the index changes", () => {
    const window = windowWith(skeleton);
    const first = chatTurnMinimapItems({
      rows: listRowsFor(window, "reply"),
      window,
      senderFirst: false,
    });
    // An `updated` index delta rebuilds the window - here the first turn's
    // preview was edited.
    const edited = windowWith([
      skeletonEntry("r-0", "user", "edited question"),
      skeletonEntry("r-1", "assistant", null),
    ]);
    const second = chatTurnMinimapItems({
      rows: listRowsFor(edited, "reply"),
      window: edited,
      senderFirst: false,
    });

    expect(second).not.toBe(first);
    expect(second.map((item) => item.label)).toEqual(["edited question"]);
  });

  it("re-derives when an unplaced row is appended", () => {
    const window = windowWith(skeleton);
    const first = chatTurnMinimapItems({
      rows: listRowsFor(window, "reply"),
      window,
      senderFirst: false,
    });
    // A pending send: a human turn the index has not placed yet. Same window,
    // so only the unplaced tail can report it.
    const withPending = [
      ...listRowsFor(window, "reply"),
      {
        kind: "hydrated" as const,
        key: "pending-1",
        ordinal: null,
        model: userModel("pending-1", "a new question"),
        part: null,
      },
    ];
    const second = chatTurnMinimapItems({
      rows: withPending,
      window,
      senderFirst: false,
    });

    expect(second).not.toBe(first);
    expect(second.map((item) => item.messageId)).toEqual(["r-0", "pending-1"]);
  });

  it("re-derives when a PLACED row is dropped by renderer suppression", () => {
    // The case the trailing-unplaced key cannot see. `rendered` is post-filter:
    // the pinned-todo pass drops an assistant row whose only segments were
    // lifted into the dock, and that decision comes from the live turn - so it
    // flips per token while the window's identity holds still.
    //
    // Reusing the derive here is not a stale label, it is a stale INDEX: the
    // items cache list positions, so every turn below the omitted row would
    // scroll to the wrong place.
    const window = windowWith(skeleton);
    const rows = listRowsFor(window, "reply");
    const first = chatTurnMinimapItems({ rows, window, senderFirst: false });

    // Same window, same trailing unplaced run (there is none) - only the
    // assistant row has gone.
    const suppressed = rows.filter((row) => row.key !== "r-1");
    expect(suppressed.length).toBe(rows.length - 1);

    const second = chatTurnMinimapItems({
      rows: suppressed,
      window,
      senderFirst: false,
    });

    expect(second).not.toBe(first);
  });
});

/**
 * A bot's channel lists the members' posts. The rows are the same human rows an
 * agent chat lists; only the label differs, and it differs by mode.
 */
describe("chatTurnMinimapItems labels", () => {
  function member(id: string, senderLabel: string, content: string) {
    return { ...userModel(id, content), senderLabel };
  }

  function hydrated(model: ChatMessageModel): TranscriptListRow {
    return {
      kind: "hydrated",
      key: model.id,
      ordinal: null,
      model,
      part: null,
    };
  }

  const channelModels: ReadonlyArray<ChatMessageModel> = [
    member("post-ada", "Ada", "Ship the rail"),
    assistantModel("reply-1", "On it"),
    {
      ...assistantModel("announcement-1", "Proposal"),
      announcement: { kind: "proposal", link: null },
    },
    {
      ...member("agent-post", "Agent 2", "Agent traffic"),
      agentSenderInfo: {
        agentId: "agent-2",
        senderTitle: "Agent 2",
        expectReply: false,
        responseId: null,
      },
    },
    member("post-grace", "Grace", "Add a test"),
  ];
  const channelRows = channelModels.map(hydrated);

  it("leads each member post with its sender, skipping the bot's and agents' rows", () => {
    const items = chatTurnMinimapItems({
      rows: channelRows,
      window: null,
      senderFirst: true,
    });

    expect(
      items.map((item) => ({ id: item.messageId, label: item.label })),
    ).toEqual([
      { id: "post-ada", label: "Ada: Ship the rail" },
      { id: "post-grace", label: "Grace: Add a test" },
    ]);
  });

  it("keeps the preview alone when the sender does not lead, though senderLabel is set and the same rows were read sender-first", () => {
    chatTurnMinimapItems({
      rows: channelRows,
      window: null,
      senderFirst: true,
    });
    const items = chatTurnMinimapItems({
      rows: channelRows,
      window: null,
      senderFirst: false,
    });

    expect(items.map((item) => item.label)).toEqual([
      "Ship the rail",
      "Add a test",
    ]);
  });

  it("names an empty post by its sender", () => {
    const items = chatTurnMinimapItems({
      rows: [hydrated(member("post-ada", "Ada", ""))],
      window: null,
      senderFirst: true,
    });

    expect(items.map((item) => item.label)).toEqual(["Ada: Untitled message"]);
  });

  it("derives each label mode once on the same window, a cold row keeping its preview alone in both", () => {
    const window = windowWith([
      skeletonEntry("r-0", "user", "first question"),
      skeletonEntry("r-1", "assistant", null),
    ]);
    const rows = [
      ...listRowsFor(window, "reply"),
      hydrated(member("pending-1", "Ada", "a new question")),
    ];

    const sender = chatTurnMinimapItems({ rows, window, senderFirst: true });
    const preview = chatTurnMinimapItems({ rows, window, senderFirst: false });

    expect(sender.map((item) => item.label)).toEqual([
      "first question",
      "Ada: a new question",
    ]);
    expect(preview.map((item) => item.label)).toEqual([
      "first question",
      "a new question",
    ]);
  });

  it("follows a member's name resolving late, on the same window and keys, and still keeps a token's derive", () => {
    const window = windowWith([
      skeletonEntry("r-0", "user", "first question"),
      skeletonEntry("r-1", "assistant", null),
    ]);
    // r-0 is placed and hydrated: the label the bot's member directory gives
    // its sender is all that changes between the reads below.
    function rowsWith(senderLabel: string, assistantContent: string) {
      const [, assistant] = listRowsFor(window, assistantContent);
      const post: TranscriptListRow = {
        kind: "hydrated",
        key: "r-0",
        ordinal: 0,
        model: member("r-0", senderLabel, "first question"),
        part: null,
      };
      return [post, assistant];
    }

    const unresolved = chatTurnMinimapItems({
      rows: rowsWith("Member", "the reply so f"),
      window,
      senderFirst: true,
    });
    const nextToken = chatTurnMinimapItems({
      rows: rowsWith("Member", "the reply so far"),
      window,
      senderFirst: true,
    });
    const resolved = chatTurnMinimapItems({
      rows: rowsWith("Ada Lovelace", "the reply so far"),
      window,
      senderFirst: true,
    });

    expect(nextToken).toBe(unresolved);
    expect(unresolved.map((item) => item.label)).toEqual([
      "Member: first question",
    ]);
    expect(resolved.map((item) => item.label)).toEqual([
      "Ada Lovelace: first question",
    ]);
  });
});

/**
 * The rail's geometry effect measures the transcript container, which forces a
 * layout while the virtualized list is measuring its own rows - so the gate
 * that decides whether it runs at all is worth pinning on its own. It lost its
 * only direct coverage when the old overlay suite went.
 */
describe("shouldRunChatTurnMinimapRail", () => {
  it.each([
    {
      name: "runs where the rail can actually paint",
      input: { shown: true, coarsePointer: false, mobileViewport: false },
      expected: true,
    },
    {
      name: "stands down for a touch pointer, which never hovers it",
      input: { shown: true, coarsePointer: true, mobileViewport: false },
      expected: false,
    },
    {
      name: "stands down below the breakpoint that hides it",
      input: { shown: true, coarsePointer: false, mobileViewport: true },
      expected: false,
    },
    {
      name: "stands down when the layout hides the minimap",
      input: { shown: false, coarsePointer: false, mobileViewport: false },
      expected: false,
    },
  ] as const)("$name", ({ input, expected }) => {
    expect(shouldRunChatTurnMinimapRail(input)).toBe(expected);
  });
});
