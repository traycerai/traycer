import { describe, expect, it } from "vitest";
import type { ChatAccumulatedFileChange } from "@traycer/protocol/host/agent/gui/subscribe";
import { accumulatedFileChangesFromMessages } from "@/lib/chat/accumulated-file-changes-from-messages";
import type {
  ChatMessage,
  ChatMessageRunState,
  FileChangeSegment,
  MessageSegment,
} from "@/stores/composer/chat-store";

describe("accumulatedFileChangesFromMessages", () => {
  it("emits a content-less placeholder for an active-turn file the host hasn't recomputed yet", () => {
    // The chat doc no longer inlines before/after content; an active-turn row
    // for a file the host doesn't yet know about appears as a presence-only
    // placeholder (null content) until the host's recompute lands.
    const changes = accumulatedFileChangesFromMessages(
      [
        assistantMessage({
          id: "assistant:turn-1",
          runState: "running",
          segments: [
            fileChangeSegment({
              id: "change-1",
              filePath: "/repo/src/app.ts",
              beforeHash: "a".repeat(64),
              afterHash: "b".repeat(64),
              additions: 1,
              deletions: 1,
            }),
          ],
        }),
      ],
      [],
      "turn-1",
    );

    expect(changes).toEqual([
      {
        filePath: "/repo/src/app.ts",
        operation: "edit",
        diffSource: "snapshot",
        beforeContent: null,
        afterContent: null,
        reason: "snapshot",
        undoable: true,
        // The placeholder carries the per-edit magnitude summed from the merged
        // segment (here a single edit with additions/deletions = 1) so the panel
        // shows a live `+/-` before the host recomputes at turn end.
        streamingCounts: { additions: 1, deletions: 1 },
      },
    ]);
  });

  it("prefers the host accumulated row (with content) when present during an active turn", () => {
    // Content is resolved host-side from snapshot blobs, so when the host
    // already has the file its row is authoritative and used wholesale.
    const changes = accumulatedFileChangesFromMessages(
      [
        assistantMessage({
          id: "assistant:turn-2",
          runState: "running",
          segments: [
            fileChangeSegment({
              id: "change-2",
              filePath: "/repo/src/app.ts",
              beforeHash: "c".repeat(64),
              afterHash: "d".repeat(64),
              additions: 1,
              deletions: 1,
            }),
          ],
        }),
      ],
      [
        accumulatedChange({
          filePath: "/repo/src/app.ts",
          beforeContent: "old\n",
          afterContent: "middle\n",
        }),
      ],
      "turn-2",
    );

    expect(changes).toMatchObject([
      {
        filePath: "/repo/src/app.ts",
        beforeContent: "old\n",
        afterContent: "middle\n",
      },
    ]);
    // A host-backed row derives `+/-` from its resolved content, so it never
    // carries streaming counts even while the turn is active.
    expect(changes[0]?.streamingCounts).toBeNull();
  });

  it("suppresses an active-turn net no-op (equal endpoints) with no host row", () => {
    // Edited back to the original within the turn ⇒ equal content-addressed
    // endpoints ⇒ nothing to show.
    const changes = accumulatedFileChangesFromMessages(
      [
        assistantMessage({
          id: "assistant:turn-3",
          runState: "running",
          segments: [
            fileChangeSegment({
              id: "change-3",
              filePath: "/repo/src/app.ts",
              beforeHash: "e".repeat(64),
              afterHash: "e".repeat(64),
              additions: 1,
              deletions: 1,
            }),
          ],
        }),
      ],
      [],
      "turn-3",
    );

    expect(changes).toEqual([]);
  });

  it("sums per-edit streaming counts across multiple active-turn edits of the same file", () => {
    // The same file is edited twice this turn; the placeholder's
    // `streamingCounts` is the SUM of both edits' additions/deletions, so the
    // pinned panel's `+/-` grows on every edit instead of snapping at turn end.
    // Distinct before/after hashes (a→b, b→c) keep the merged endpoints
    // unequal so the row is not suppressed as a net no-op.
    const changes = accumulatedFileChangesFromMessages(
      [
        assistantMessage({
          id: "assistant:turn-4",
          runState: "running",
          segments: [
            fileChangeSegment({
              id: "change-4a",
              filePath: "/repo/src/app.ts",
              beforeHash: "a".repeat(64),
              afterHash: "b".repeat(64),
              additions: 3,
              deletions: 1,
            }),
            fileChangeSegment({
              id: "change-4b",
              filePath: "/repo/src/app.ts",
              beforeHash: "b".repeat(64),
              afterHash: "c".repeat(64),
              additions: 2,
              deletions: 4,
            }),
          ],
        }),
      ],
      [],
      "turn-4",
    );

    expect(changes).toEqual([
      {
        filePath: "/repo/src/app.ts",
        operation: "edit",
        diffSource: "snapshot",
        beforeContent: null,
        afterContent: null,
        reason: "snapshot",
        undoable: true,
        streamingCounts: { additions: 5, deletions: 5 },
      },
    ]);
  });
});

function assistantMessage(input: {
  readonly id: string;
  readonly runState: ChatMessageRunState | null;
  readonly segments: ReadonlyArray<MessageSegment>;
}): ChatMessage {
  return {
    id: input.id,
    role: "assistant",
    content: "",
    segments: input.segments,
    structuredContent: null,
    attachments: [],
    settings: null,
    createdAt: 1,
    completedAt: null,
    stopped: null,
    persistentMessageId: null,
    senderLabel: null,
    assistantMeta: null,
    statusLabel: null,
    agentSenderInfo: null,
    agentMessage: null,
    runState: input.runState,
    sessionAnchor: null,
    steerBadge: null,
  };
}

function fileChangeSegment(input: {
  readonly id: string;
  readonly filePath: string;
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
  readonly additions: number;
  readonly deletions: number;
}): FileChangeSegment {
  return {
    id: input.id,
    kind: "file_change",
    filePath: input.filePath,
    operation: "edit",
    diffSource: "snapshot",
    beforeHash: input.beforeHash,
    afterHash: input.afterHash,
    additions: input.additions,
    deletions: input.deletions,
    sourceBlockIds: [input.id],
    reason: "snapshot",
    isStreaming: false,
    endState: null,
    parentId: null,
  };
}

function accumulatedChange(input: {
  readonly filePath: string;
  readonly beforeContent: string | null;
  readonly afterContent: string | null;
}): ChatAccumulatedFileChange {
  return {
    filePath: input.filePath,
    operation: "edit",
    diffSource: "snapshot",
    beforeContent: input.beforeContent,
    afterContent: input.afterContent,
    reason: "snapshot",
    undoable: true,
  };
}
