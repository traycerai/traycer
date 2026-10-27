import { describe, expect, it } from "vitest";
import type { AutonomousResumeTrigger } from "@traycer/protocol/persistence/epic/content-blocks";
import { makeMessageAt } from "@/components/chat/__tests__/chat-message-fixtures";
import { foldBackgroundEventRows } from "@/stores/chats/background-event-fold";
import {
  emptyTranscriptWindow,
  type TranscriptWindow,
} from "@/stores/chats/transcript-window";
import type { ChatMessage } from "@/stores/composer/chat-store";

function shellTrigger(
  commandId: string,
  summary: string,
  overrides: Partial<AutonomousResumeTrigger>,
): AutonomousResumeTrigger {
  return {
    kind: "command",
    title: commandId,
    status: "completed",
    live: true,
    summary,
    blockId: `block-${commandId}`,
    outputFile: null,
    mcp: null,
    managedCommand: { commandId, monitoring: false, hostId: "host-1" },
    ...overrides,
  };
}

function monitorTrigger(
  blockId: string,
  overrides: Partial<AutonomousResumeTrigger>,
): AutonomousResumeTrigger {
  return {
    kind: "monitor",
    title: "watch",
    status: "completed",
    live: false,
    summary: "done",
    blockId,
    outputFile: null,
    mcp: null,
    managedCommand: null,
    ...overrides,
  };
}

function wakeTrigger(blockId: string): AutonomousResumeTrigger {
  return monitorTrigger(blockId, { kind: "wakeup", title: "wake" });
}

interface RowOptions {
  readonly completedAt: number | null;
  readonly elapsedStartedAt: number | undefined;
  readonly pausedDurationMs: number | undefined;
  readonly showCompletionFooter: boolean | undefined;
}

const DEFAULT_OPTIONS: RowOptions = {
  completedAt: 5_000,
  elapsedStartedAt: undefined,
  pausedDurationMs: undefined,
  showCompletionFooter: undefined,
};

/** A finished turn that is one background event and nothing else. */
function silentRow(
  id: string,
  triggers: ReadonlyArray<AutonomousResumeTrigger>,
  options: Partial<RowOptions>,
): ChatMessage {
  const resolved = { ...DEFAULT_OPTIONS, ...options };
  return {
    ...makeMessageAt(0, "assistant", 1_000),
    id,
    segments: [{ id: `${id}-resume`, kind: "autonomous_resume", triggers }],
    turnHasOnlyAutonomousResumeSegments: true,
    completedAt: resolved.completedAt,
    elapsedStartedAt: resolved.elapsedStartedAt,
    pausedDurationMs: resolved.pausedDurationMs,
    showCompletionFooter: resolved.showCompletionFooter,
  };
}

/** A turn a background event started and the agent then acted on. */
function actedRow(id: string, trigger: AutonomousResumeTrigger): ChatMessage {
  return {
    ...makeMessageAt(0, "assistant", 1_000),
    id,
    segments: [
      { id: `${id}-resume`, kind: "autonomous_resume", triggers: [trigger] },
      {
        id: `${id}-text`,
        kind: "text",
        markdown: "On it.",
        isStreaming: false,
      },
    ],
    completedAt: 9_000,
  };
}

function userRow(id: string): ChatMessage {
  return { ...makeMessageAt(0, "user", 1_000), id };
}

function ids(rows: ReadonlyArray<ChatMessage>): ReadonlyArray<string> {
  return rows.map((row) => row.id);
}

function foldedKeys(row: ChatMessage | undefined): ReadonlyArray<string> {
  return (row?.foldedBackgroundEvents ?? []).map((event) => event.key);
}

const SHELL = (summary: string) => shellTrigger("cmd-1", summary, {});

function windowOf(input: {
  readonly rowCount: number;
  readonly skeletonIds: ReadonlyArray<string>;
  readonly invalidated: boolean;
}): TranscriptWindow {
  return {
    ...emptyTranscriptWindow(),
    rowCount: input.rowCount,
    skeleton: input.skeletonIds.map((rowId, ordinal) => ({
      rowId,
      createdAt: 1_000 + ordinal,
      role: "assistant",
      byteLength: 128,
      bodyDigest: `d-${rowId}`,
    })),
    invalidated: input.invalidated,
  };
}

describe("foldBackgroundEventRows", () => {
  describe("on the legacy line", () => {
    it("folds silent rows into the turn the same shell's next update started, oldest first", () => {
      const rows = [
        silentRow("a", [SHELL("one")], {}),
        silentRow("b", [SHELL("two")], {}),
        silentRow("c", [SHELL("three")], {}),
        actedRow("d", SHELL("four")),
      ];

      const folded = foldBackgroundEventRows(rows, null);

      expect(ids(folded)).toEqual(["d"]);
      expect(foldedKeys(folded[0])).toEqual(["a#0", "b#0", "c#0"]);
      expect(
        folded[0].foldedBackgroundEvents?.map((event) => event.trigger.summary),
      ).toEqual(["one", "two", "three"]);
    });

    it("leaves the newest of a trailing run of silent rows carrying the earlier ones", () => {
      const rows = [
        silentRow("a", [SHELL("one")], {}),
        silentRow("b", [SHELL("two")], {}),
        silentRow("c", [SHELL("three")], {}),
      ];

      const folded = foldBackgroundEventRows(rows, null);

      expect(ids(folded)).toEqual(["c"]);
      expect(foldedKeys(folded[0])).toEqual(["a#0", "b#0"]);
    });

    it("folds each of two interleaved sources into its own newest row", () => {
      const other = shellTrigger("cmd-2", "other", {});
      const rows = [
        silentRow("a1", [SHELL("one")], {}),
        silentRow("b1", [other], {}),
        silentRow("a2", [SHELL("two")], {}),
        silentRow("b2", [other], {}),
      ];

      const folded = foldBackgroundEventRows(rows, null);

      expect(ids(folded)).toEqual(["a2", "b2"]);
      expect(foldedKeys(folded[0])).toEqual(["a1#0"]);
      expect(foldedKeys(folded[1])).toEqual(["b1#0"]);
    });

    it("folds scheduled wakes, whatever their block ids, as one source", () => {
      const rows = [
        silentRow("a", [wakeTrigger("wake-1")], {}),
        silentRow("b", [wakeTrigger("wake-2")], {}),
      ];

      const folded = foldBackgroundEventRows(rows, null);

      expect(ids(folded)).toEqual(["b"]);
      expect(foldedKeys(folded[0])).toEqual(["a#0"]);
    });

    it("does not fold across a user row", () => {
      const rows = [
        silentRow("a", [SHELL("one")], {}),
        userRow("u"),
        silentRow("b", [SHELL("two")], {}),
      ];

      expect(foldBackgroundEventRows(rows, null)).toBe(rows);
    });

    it("does not fold a row whose triggers span several sources", () => {
      const mixed = silentRow(
        "a",
        [SHELL("one"), shellTrigger("cmd-2", "two", {})],
        {},
      );
      const rows = [mixed, silentRow("b", [SHELL("three")], {})];

      expect(foldBackgroundEventRows(rows, null)).toBe(rows);
    });

    it("does not fold a trigger that names no block", () => {
      const unnamed = monitorTrigger("", {});
      const rows = [
        silentRow("a", [unnamed], {}),
        silentRow("b", [unnamed], {}),
      ];

      expect(foldBackgroundEventRows(rows, null)).toBe(rows);
    });

    it("does not fold triggers an older host wrote with no blockId key at all", () => {
      const first = monitorTrigger("x", {});
      const second = monitorTrigger("x", {});
      Reflect.deleteProperty(first, "blockId");
      Reflect.deleteProperty(second, "blockId");
      const rows = [silentRow("a", [first], {}), silentRow("b", [second], {})];

      expect(foldBackgroundEventRows(rows, null)).toBe(rows);
    });

    it("returns the same array when nothing can fold", () => {
      const rows = [userRow("u"), actedRow("a", SHELL("one"))];

      expect(foldBackgroundEventRows(rows, null)).toBe(rows);
    });

    it("keeps a lone silent row as it is", () => {
      const rows = [silentRow("a", [SHELL("one")], {})];

      expect(foldBackgroundEventRows(rows, null)).toBe(rows);
    });
  });

  describe("how a folded event ended", () => {
    it("measures a turn that ran as completedAt minus its start minus the time it was paused", () => {
      const rows = [
        silentRow("a", [SHELL("one")], {
          completedAt: 10_000,
          elapsedStartedAt: 4_000,
          pausedDurationMs: 1_500,
        }),
        silentRow("b", [SHELL("two")], {}),
      ];

      const folded = foldBackgroundEventRows(rows, null);

      expect(folded[0].foldedBackgroundEvents?.[0].ending).toEqual({
        kind: "no-reply",
        elapsedMs: 4_500,
      });
    });

    it("counts from the row's creation when it has no separate start", () => {
      const rows = [
        silentRow("a", [SHELL("one")], { completedAt: 3_500 }),
        silentRow("b", [SHELL("two")], {}),
      ];

      const folded = foldBackgroundEventRows(rows, null);

      expect(folded[0].foldedBackgroundEvents?.[0].ending).toEqual({
        kind: "no-reply",
        elapsedMs: 2_500,
      });
    });

    it("reports a turn no provider adopted as not resumed", () => {
      const rows = [
        silentRow("a", [SHELL("one")], { showCompletionFooter: false }),
        silentRow("b", [SHELL("two")], {}),
      ];

      const folded = foldBackgroundEventRows(rows, null);

      expect(folded[0].foldedBackgroundEvents?.[0].ending).toEqual({
        kind: "not-resumed",
      });
    });
  });

  describe("on the windowed line", () => {
    const pair = [
      silentRow("a", [SHELL("one")], {}),
      silentRow("b", [SHELL("two")], {}),
    ];

    it("folds rows with consecutive ordinals", () => {
      const window = windowOf({
        rowCount: 4,
        skeletonIds: ["x", "a", "b", "y"],
        invalidated: false,
      });

      expect(ids(foldBackgroundEventRows(pair, window))).toEqual(["b"]);
    });

    it("does not fold across an ordinal the client never loaded", () => {
      const window = windowOf({
        rowCount: 4,
        skeletonIds: ["a", "gap", "b", "y"],
        invalidated: false,
      });

      expect(foldBackgroundEventRows(pair, window)).toBe(pair);
    });

    it("reads a row's ordinal from the span that served it before the skeleton", () => {
      const window: TranscriptWindow = {
        ...windowOf({
          rowCount: 4,
          skeletonIds: ["a", "gap", "b", "y"],
          invalidated: false,
        }),
        spans: [
          {
            fromOrdinal: 1,
            rowIds: ["a", "b"],
            rowContext: {},
            messageIds: [],
            eventIds: [],
            contextBytes: 0,
          },
        ],
      };

      expect(ids(foldBackgroundEventRows(pair, window))).toEqual(["b"]);
    });

    it("folds rows with no ordinal after the last one", () => {
      const window = windowOf({
        rowCount: 2,
        skeletonIds: ["x", "a"],
        invalidated: false,
      });
      const rows = [
        silentRow("a", [SHELL("one")], {}),
        silentRow("tail-1", [SHELL("two")], {}),
        silentRow("tail-2", [SHELL("three")], {}),
      ];

      const folded = foldBackgroundEventRows(rows, window);

      expect(ids(folded)).toEqual(["tail-2"]);
      expect(foldedKeys(folded[0])).toEqual(["a#0", "tail-1#0"]);
    });

    it("does not fold a row with no ordinal after a lower one", () => {
      const window = windowOf({
        rowCount: 4,
        skeletonIds: ["a", "x", "y", "z"],
        invalidated: false,
      });
      const rows = [
        silentRow("a", [SHELL("one")], {}),
        silentRow("tail", [SHELL("two")], {}),
      ];

      expect(foldBackgroundEventRows(rows, window)).toBe(rows);
    });

    it("does not fold rows only a stale span holds", () => {
      const staleSpan = (rowId: string, fromOrdinal: number) => ({
        fromOrdinal,
        rowIds: [rowId],
        rowContext: {},
        messageIds: [],
        eventIds: [],
        contextBytes: 0,
      });
      const window: TranscriptWindow = {
        ...windowOf({ rowCount: 30, skeletonIds: [], invalidated: false }),
        staleSpans: [staleSpan("a", 10), staleSpan("b", 20)],
      };

      expect(foldBackgroundEventRows(pair, window)).toBe(pair);
    });

    it("never folds in an invalidated window", () => {
      const window = windowOf({
        rowCount: 4,
        skeletonIds: ["x", "a", "b", "y"],
        invalidated: true,
      });

      expect(foldBackgroundEventRows(pair, window)).toBe(pair);
    });
  });
});
