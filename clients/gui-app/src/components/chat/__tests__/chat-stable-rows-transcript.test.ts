import { describe, expect, it } from "vitest";
import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import {
  computeStableTranscriptListRows,
  didTranscriptListKeySequenceChange,
  EMPTY_STABLE_TRANSCRIPT_LIST_ROWS_STATE,
  transcriptListKeySequence,
} from "@/components/chat/chat-stable-rows";
import type { TranscriptListRow } from "@/stores/chats/transcript-list-rows";

function model(id: string, content: string): ChatMessageModel {
  return {
    id,
    role: "assistant",
    content,
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

function placeholder(
  key: string,
  ordinal: number,
  entry: RowSkeletonEntry | null,
): TranscriptListRow {
  return { kind: "placeholder", key, ordinal, entry };
}

function hydrated(
  key: string,
  ordinal: number,
  message: ChatMessageModel,
): TranscriptListRow {
  return { kind: "hydrated", key, ordinal, model: message };
}

describe("stable transcript list rows", () => {
  it("returns the previous state object for identical input arrays", () => {
    const rows: readonly TranscriptListRow[] = [
      hydrated("a", 0, model("a", "same")),
    ];
    const previous = computeStableTranscriptListRows(
      rows,
      EMPTY_STABLE_TRANSCRIPT_LIST_ROWS_STATE,
    );

    expect(computeStableTranscriptListRows(rows, previous)).toBe(previous);
  });

  it("reuses a placeholder row when its entry reference is unchanged", () => {
    const entry: RowSkeletonEntry = {
      rowId: "p",
      createdAt: 1000,
      role: "assistant",
      byteLength: 16,
      bodyDigest: "d0",
    };
    const previous = computeStableTranscriptListRows(
      [placeholder("p", 0, entry)],
      EMPTY_STABLE_TRANSCRIPT_LIST_ROWS_STATE,
    );
    const next = computeStableTranscriptListRows(
      [placeholder("p", 0, entry)],
      previous,
    );

    expect(next.result[0]).toBe(previous.result[0]);
  });

  it("does not reuse a placeholder whose entry arrived", () => {
    // A skeleton chunk landing under a rendered placeholder moves `entry` from
    // `null` to a delivered one. Nothing about the row's KEY changes, so a
    // reuse rule keyed on identity alone would hold the old element - and the
    // placeholder's height is derived from `byteLength`, so the row would keep
    // the 120px "nothing known" guess for a row the skeleton now describes.
    const previous = computeStableTranscriptListRows(
      [placeholder("r-1", 1, null)],
      EMPTY_STABLE_TRANSCRIPT_LIST_ROWS_STATE,
    );
    const next = computeStableTranscriptListRows(
      [
        placeholder("r-1", 1, {
          rowId: "r-1",
          createdAt: 1000,
          role: "assistant",
          byteLength: 65_536,
          bodyDigest: "d1",
        }),
      ],
      previous,
    );

    expect(next.result[0]).not.toBe(previous.result[0]);
  });

  it("does not reuse a row when it changes from placeholder to hydrated", () => {
    const entry: RowSkeletonEntry = {
      rowId: "r-1",
      createdAt: 1000,
      role: "assistant",
      byteLength: 16,
      bodyDigest: "d2",
    };
    const previous = computeStableTranscriptListRows(
      [placeholder("r-1", 1, entry)],
      EMPTY_STABLE_TRANSCRIPT_LIST_ROWS_STATE,
    );
    const next = computeStableTranscriptListRows(
      [hydrated("r-1", 1, model("r-1", "body"))],
      previous,
    );

    expect(next.result[0]).not.toBe(previous.result[0]);
    expect(next.result[0].kind).toBe("hydrated");
  });

  it("updates only a hydrated row whose message content changed", () => {
    const unchanged = model("b", "same");
    const previous = computeStableTranscriptListRows(
      [hydrated("a", 0, model("a", "old")), hydrated("b", 1, unchanged)],
      EMPTY_STABLE_TRANSCRIPT_LIST_ROWS_STATE,
    );
    const next = computeStableTranscriptListRows(
      [hydrated("a", 0, model("a", "new")), hydrated("b", 1, unchanged)],
      previous,
    );

    expect(next.result[0]).not.toBe(previous.result[0]);
    expect(next.result[1]).toBe(previous.result[1]);
  });
});

describe("transcript list key sequence", () => {
  const rows: readonly TranscriptListRow[] = [
    hydrated("a", 0, model("a", "old")),
    hydrated("b", 1, model("b", "same")),
  ];

  it("returns keys in list order", () => {
    expect(transcriptListKeySequence(rows)).toEqual(["a", "b"]);
  });

  it("detects reorder but not in-place content changes", () => {
    expect(didTranscriptListKeySequenceChange(["a", "b"], rows)).toBe(false);
    expect(didTranscriptListKeySequenceChange(["b", "a"], rows)).toBe(true);
    expect(
      didTranscriptListKeySequenceChange(
        ["a", "b"],
        [hydrated("a", 0, model("a", "new")), rows[1]],
      ),
    ).toBe(false);
  });

  it("treats an undefined committed baseline as unchanged", () => {
    expect(didTranscriptListKeySequenceChange(undefined, rows)).toBe(false);
  });
});
