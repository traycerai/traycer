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
  createChatTurnMinimapDeriveSlot,
  resolveChatTurnMinimapCurrentIndex,
  resolveChatTurnMinimapHitStripWidth,
  resolveChatTurnMinimapTopStyle,
  type ChatTurnMinimapDeriveSlot,
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
  const slot = createChatTurnMinimapDeriveSlot();
  const skeleton: ReadonlyArray<RowSkeletonEntry> = [
    skeletonEntry("r-0", "user", "first question"),
    skeletonEntry("r-1", "assistant", null),
  ];

  function windowWith(
    entries: ReadonlyArray<RowSkeletonEntry>,
  ): TranscriptWindow {
    return {
      epoch: 1,
      rowCount: entries.length,
      indexRevision: 1,
      indexRevisionRebuilding: false,
      skeleton: entries,
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

  it("does not re-derive across a pure block delta", () => {
    const window = windowWith(skeleton);
    // The streaming assistant row: same row, new model object per token, so a
    // NEW `rows` array each time - which is what `transcriptListRows` produces.
    const rowsBefore = listRowsFor(window, "the reply so f");
    const rowsAfter = listRowsFor(window, "the reply so far");
    expect(rowsAfter).not.toBe(rowsBefore);

    const first = chatTurnMinimapItems({ rows: rowsBefore, window, slot });
    const second = chatTurnMinimapItems({ rows: rowsAfter, window, slot });

    expect(second).toBe(first);
    expect(first.map((item) => item.messageId)).toEqual(["r-0"]);
  });

  it("re-derives when the index changes", () => {
    const window = windowWith(skeleton);
    const first = chatTurnMinimapItems({
      rows: listRowsFor(window, "reply"),
      window,
      slot,
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
      slot,
    });

    expect(second).not.toBe(first);
    expect(second.map((item) => item.label)).toEqual(["edited question"]);
  });

  it("re-derives when an unplaced row is appended", () => {
    const window = windowWith(skeleton);
    const first = chatTurnMinimapItems({
      rows: listRowsFor(window, "reply"),
      window,
      slot,
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
      },
    ];
    const second = chatTurnMinimapItems({ rows: withPending, window, slot });

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
    const first = chatTurnMinimapItems({ rows, window, slot });

    // Same window, same trailing unplaced run (there is none) - only the
    // assistant row has gone.
    const suppressed = rows.filter((row) => row.key !== "r-1");
    expect(suppressed.length).toBe(rows.length - 1);

    const second = chatTurnMinimapItems({ rows: suppressed, window, slot });

    expect(second).not.toBe(first);
  });
});

/**
 * The derive does not run over a skeleton that is still streaming: each chunk
 * publishes a new window, which misses the cache, and the outline it would
 * build is not finished. It holds the slot's last complete outline instead.
 */
describe("chatTurnMinimapItems over an incomplete skeleton", () => {
  function windowOf(
    entries: ReadonlyArray<RowSkeletonEntry | undefined>,
    skeletonComplete: boolean,
  ): TranscriptWindow {
    return {
      epoch: 1,
      rowCount: entries.length,
      indexRevision: 1,
      indexRevisionRebuilding: false,
      skeleton: entries,
      skeletonComplete,
      skeletonStreamCoveredThrough: skeletonComplete ? entries.length : 0,
      records: { messages: new Map(), events: new Map(), revision: 0 },
      spans: [],
      staleSpans: [],
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

  function itemsFor(window: TranscriptWindow, slot: ChatTurnMinimapDeriveSlot) {
    return chatTurnMinimapItems({
      rows: transcriptListRows({ window, rendered: [] }),
      window,
      slot,
    });
  }

  const first = skeletonEntry("r-0", "user", "first question");
  const second = skeletonEntry("r-2", "user", "second question");
  const reply = skeletonEntry("r-1", "assistant", null);

  it("publishes no outline until the first skeleton completes, then the full one", () => {
    const slot = createChatTurnMinimapDeriveSlot();
    // A fresh stream: the first chunk has described one turn.
    expect(itemsFor(windowOf([first, reply, undefined], false), slot)).toEqual(
      [],
    );

    const complete = itemsFor(windowOf([first, reply, second], true), slot);

    expect(complete.map((item) => item.label)).toEqual([
      "first question",
      "second question",
    ]);
  });

  it("holds the last complete outline while a later stream is incomplete", () => {
    const slot = createChatTurnMinimapDeriveSlot();
    const settled = itemsFor(windowOf([first, reply, second], true), slot);

    // A rebuild restreaming, or the append republish declaring the skeleton
    // short for one publish - the outline must not blank.
    const held = itemsFor(
      windowOf([first, reply, second, undefined], false),
      slot,
    );

    expect(held).toBe(settled);
  });

  it("holds for a second minimap on the same chat, whose derive was a cache hit", () => {
    // Two tiles over one chat share the store, so they share the window - the
    // second one's complete outline comes out of the cache, and it has to be
    // remembered as that minimap's settled outline all the same.
    const complete = windowOf([first, reply, second], true);
    const firstTile = createChatTurnMinimapDeriveSlot();
    const secondTile = createChatTurnMinimapDeriveSlot();
    const rows = transcriptListRows({ window: complete, rendered: [] });
    chatTurnMinimapItems({ rows, window: complete, slot: firstTile });
    const settled = chatTurnMinimapItems({
      rows,
      window: complete,
      slot: secondTile,
    });

    expect(
      itemsFor(windowOf([first, reply, second, undefined], false), secondTile),
    ).toBe(settled);
  });

  it("keeps one minimap's outline out of another's", () => {
    const settledSlot = createChatTurnMinimapDeriveSlot();
    itemsFor(windowOf([first, reply, second], true), settledSlot);

    const freshSlot = createChatTurnMinimapDeriveSlot();
    expect(
      itemsFor(windowOf([first, reply, undefined], false), freshSlot),
    ).toEqual([]);
  });

  it("re-uses a label across skeleton copies and rebuilds it for a replaced entry", () => {
    const slot = createChatTurnMinimapDeriveSlot();
    const entries = [first, reply, second];
    const before = itemsFor(windowOf(entries, true), slot);
    // A chunk or index change copies the array; the entries are the same
    // objects, so their labels are too.
    const copied = itemsFor(windowOf([...entries], true), slot);
    expect(copied.map((item) => item.label)).toEqual(
      before.map((item) => item.label),
    );

    const edited = itemsFor(
      windowOf(
        [skeletonEntry("r-0", "user", "an edited question"), reply, second],
        true,
      ),
      slot,
    );
    expect(edited.map((item) => item.label)).toEqual([
      "an edited question",
      "second question",
    ]);
  });
});

/**
 * The compaction builds labels from whole-run slices. It must cut exactly
 * where the character-at-a-time loop it replaced did - the ellipsis decision
 * reads that length.
 */
describe("compactChatTurnMinimapPreview matches the character loop", () => {
  function referenceCollapse(text: string, maxOut: number): string {
    let out = "";
    let pendingSpace = false;
    const scanLimit = Math.min(text.length, 16_384);
    for (let index = 0; index < scanLimit; index += 1) {
      const ch = text[index];
      if (/\s/.test(ch)) {
        if (out.length > 0) pendingSpace = true;
        continue;
      }
      if (pendingSpace) {
        out += " ";
        pendingSpace = false;
      }
      out += ch;
      if (out.length > maxOut + 1) break;
    }
    return out;
  }

  function referencePreview(text: string): string | null {
    const compact = referenceCollapse(
      text,
      CHAT_TURN_MINIMAP_PREVIEW_MAX_CHARS,
    );
    if (compact.length === 0) return null;
    if (compact.length <= CHAT_TURN_MINIMAP_PREVIEW_MAX_CHARS) return compact;
    const cut = compact.slice(0, CHAT_TURN_MINIMAP_PREVIEW_MAX_CHARS);
    const last = cut.charCodeAt(cut.length - 1);
    const whole = last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
    return `${whole.trimEnd()}…`;
  }

  const max = CHAT_TURN_MINIMAP_PREVIEW_MAX_CHARS;
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["empty", ""],
    ["only whitespace", " \n\t  \r\n "],
    ["one word", "hello"],
    ["mixed whitespace runs", "  A\n\n useful \t  query "],
    ["exactly the cap", "x".repeat(max)],
    ["one past the cap", "x".repeat(max + 1)],
    ["two past the cap", "x".repeat(max + 2)],
    ["long single run", "y".repeat(max * 3)],
    ["word ending at the cap", `${"a".repeat(max - 1)} bcdef`],
    ["word starting past the cap", `${"a".repeat(max + 1)} bcdef`],
    ["space landing on the boundary", `${"a".repeat(max)} b c`],
    ["many short words", Array.from({ length: 150 }, () => "ab").join("  ")],
    [
      "surrogate pair at the cut",
      `${"a".repeat(max - 1)}\u{1F600}\u{1F600} tail`,
    ],
    ["unicode whitespace", "a\u00a0b\u2003c\u3000 d"],
    ["content only past the scan limit", `${" ".repeat(16_384)}late words`],
    ["a run crossing the scan limit", `${" ".repeat(16_380)}abcdefghij`],
  ];

  for (const [name, text] of cases) {
    it(name, () => {
      expect(compactChatTurnMinimapPreview(text)).toBe(referencePreview(text));
    });
  }
});
