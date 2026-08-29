import { describe, expect, it } from "vitest";
import type {
  AgentSender,
  ContentBlock,
  Message,
} from "@traycer/protocol/persistence/epic/schemas";
import type { ChatAccumulatedFileChange } from "@traycer/protocol/host/agent/gui/subscribe";
import {
  resolveHashBackedEndpoints,
  resolveSnapshotDiffContent,
  resolveSnapshotDiffContents,
  resolveSnapshotSegmentHashes,
} from "@/lib/chat/resolve-snapshot-diff-content";

const ASSISTANT_SENDER: AgentSender = {
  type: "agent" as const,
  harnessId: "claude" as const,
  agentId: "claude-sonnet-4",
  displayName: "Claude Sonnet 4",
  reply: { expectsReply: false },
  inReplyTo: null,
};

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_NEW = "d".repeat(64);

function fileChangeBlock(args: {
  readonly blockId: string;
  readonly filePath: string;
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
}): ContentBlock {
  return {
    type: "file_change",
    blockId: args.blockId,
    filePath: args.filePath,
    operation: "edit",
    diffSource: "snapshot",
    beforeHash: args.beforeHash,
    afterHash: args.afterHash,
    additions: 1,
    deletions: 1,
    reason: "snapshot",
    status: "completed",
    timestamp: 1,
  };
}

function assistantMessage(
  blocks: ReadonlyArray<ContentBlock>,
): Extract<Message, { role: "assistant" }> {
  return {
    role: "assistant",
    messageId: "assistant-1",
    sender: ASSISTANT_SENDER,
    blocks: [...blocks],
    startedAt: 1,
    timestamp: 1,
    turnId: "turn-1",
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
    envCredentialVar: null,
    imageResolutions: [],
  };
}

function cumulativeChange(
  filePath: string,
  beforeContent: string | null,
  afterContent: string | null,
): ChatAccumulatedFileChange {
  return {
    filePath,
    operation: "edit",
    diffSource: "snapshot",
    beforeContent,
    afterContent,
    reason: "snapshot",
    undoable: true,
  };
}

describe("resolveSnapshotSegmentHashes - segment", () => {
  const source = {
    messages: [
      assistantMessage([
        fileChangeBlock({
          blockId: "blk-1",
          filePath: "src/a.ts",
          beforeHash: HASH_A,
          afterHash: HASH_B,
        }),
        fileChangeBlock({
          blockId: "blk-2",
          filePath: "src/a.ts",
          beforeHash: HASH_B,
          afterHash: HASH_C,
        }),
      ]),
    ],
    liveAssistantBlocks: null,
    accumulatedFileChanges: [],
  };

  it("resolves a single block id to that edit's before/after hashes", () => {
    const resolved = resolveSnapshotSegmentHashes(
      {
        kind: "snapshot-segment",
        chatId: "c",
        sourceBlockIds: ["blk-1"],
        filePath: "src/a.ts",
        beforeHash: null,
        afterHash: null,
      },
      source,
    );
    expect(resolved).toEqual({
      filePath: "src/a.ts",
      beforeHash: HASH_A,
      afterHash: HASH_B,
    });
  });

  it("reconstructs a merged row (first before -> last after) from +-joined ids", () => {
    const resolved = resolveSnapshotSegmentHashes(
      {
        kind: "snapshot-segment",
        chatId: "c",
        sourceBlockIds: ["blk-1", "blk-2"],
        filePath: "src/a.ts",
        beforeHash: null,
        afterHash: null,
      },
      source,
    );
    expect(resolved).toEqual({
      filePath: "src/a.ts",
      beforeHash: HASH_A,
      afterHash: HASH_C,
    });
  });

  it("reads from live assistant blocks while streaming", () => {
    const resolved = resolveSnapshotSegmentHashes(
      {
        kind: "snapshot-segment",
        chatId: "c",
        sourceBlockIds: ["live-1"],
        filePath: "src/b.ts",
        beforeHash: null,
        afterHash: null,
      },
      {
        messages: [],
        liveAssistantBlocks: [
          fileChangeBlock({
            blockId: "live-1",
            filePath: "src/b.ts",
            beforeHash: null,
            afterHash: HASH_NEW,
          }),
        ],
        accumulatedFileChanges: [],
      },
    );
    expect(resolved).toEqual({
      filePath: "src/b.ts",
      beforeHash: null,
      afterHash: HASH_NEW,
    });
  });

  it("returns null when the block id is gone and nothing was captured", () => {
    // A tile persisted before the captured endpoints existed. It degrades
    // exactly as every segment tile used to.
    expect(
      resolveSnapshotSegmentHashes(
        {
          kind: "snapshot-segment",
          chatId: "c",
          sourceBlockIds: ["missing"],
          filePath: "src/a.ts",
          beforeHash: null,
          afterHash: null,
        },
        source,
      ),
    ).toBeNull();
  });

  /**
   * The windowed-transcript case, and the whole reason the capture exists: the
   * tile outlived the hydration of the row it was opened from. Before this it
   * rendered source-unavailable and there was no way back - a canvas reopened
   * a week later showed nothing for an edit that is still on disk.
   */
  it("falls back to the captured endpoints once the row is no longer hydrated", () => {
    expect(
      resolveSnapshotSegmentHashes(
        {
          kind: "snapshot-segment",
          chatId: "c",
          sourceBlockIds: ["blk-1"],
          filePath: "src/a.ts",
          beforeHash: HASH_A,
          afterHash: HASH_B,
        },
        { messages: [], liveAssistantBlocks: null, accumulatedFileChanges: [] },
      ),
    ).toEqual({
      filePath: "src/a.ts",
      beforeHash: HASH_A,
      afterHash: HASH_B,
    });
  });

  it("falls back for a capture with only one side, as a creation has", () => {
    expect(
      resolveSnapshotSegmentHashes(
        {
          kind: "snapshot-segment",
          chatId: "c",
          sourceBlockIds: ["blk-1"],
          filePath: "src/new.ts",
          beforeHash: null,
          afterHash: HASH_NEW,
        },
        { messages: [], liveAssistantBlocks: null, accumulatedFileChanges: [] },
      ),
    ).toEqual({
      filePath: "src/new.ts",
      beforeHash: null,
      afterHash: HASH_NEW,
    });
  });

  /**
   * Order matters, and this is the case that fixes it: a streaming edit's
   * `afterHash` moves, and the capture was taken at the first frame of it. The
   * blocks win wherever they resolve, so the open tile keeps updating.
   */
  it("prefers the live blocks over a capture that has gone stale", () => {
    expect(
      resolveSnapshotSegmentHashes(
        {
          kind: "snapshot-segment",
          chatId: "c",
          sourceBlockIds: ["blk-1"],
          filePath: "src/a.ts",
          beforeHash: HASH_A,
          afterHash: HASH_B,
        },
        {
          messages: [],
          liveAssistantBlocks: [
            fileChangeBlock({
              blockId: "blk-1",
              filePath: "src/a.ts",
              beforeHash: HASH_A,
              afterHash: HASH_NEW,
            }),
          ],
          accumulatedFileChanges: [],
        },
      ),
    ).toEqual({
      filePath: "src/a.ts",
      beforeHash: HASH_A,
      afterHash: HASH_NEW,
    });
  });
});

describe("resolveHashBackedEndpoints", () => {
  const emptySource = {
    messages: [],
    liveAssistantBlocks: null,
    accumulatedFileChanges: [],
  };

  it("returns an artifact-hash payload's hashes verbatim, ignoring the source", () => {
    expect(
      resolveHashBackedEndpoints(
        {
          kind: "snapshot-hash",
          chatId: "c",
          filePath: "index.md",
          beforeHash: HASH_A,
          afterHash: HASH_B,
          title: "Auth Spec",
        },
        emptySource,
      ),
    ).toEqual({ filePath: "index.md", beforeHash: HASH_A, afterHash: HASH_B });
  });

  it("delegates to the block resolver for a segment payload", () => {
    const source = {
      messages: [
        assistantMessage([
          fileChangeBlock({
            blockId: "blk-1",
            filePath: "src/a.ts",
            beforeHash: HASH_A,
            afterHash: HASH_B,
          }),
        ]),
      ],
      liveAssistantBlocks: null,
      accumulatedFileChanges: [],
    };
    expect(
      resolveHashBackedEndpoints(
        {
          kind: "snapshot-segment",
          chatId: "c",
          sourceBlockIds: ["blk-1"],
          filePath: "src/a.ts",
          beforeHash: null,
          afterHash: null,
        },
        source,
      ),
    ).toEqual({ filePath: "src/a.ts", beforeHash: HASH_A, afterHash: HASH_B });
  });

  it("returns null for cumulative and bundle payloads (content-inline)", () => {
    expect(
      resolveHashBackedEndpoints(
        { kind: "snapshot-cumulative", chatId: "c", filePath: "src/a.ts" },
        emptySource,
      ),
    ).toBeNull();
    expect(
      resolveHashBackedEndpoints(
        {
          kind: "snapshot-cumulative-bundle",
          chatId: "c",
          filePaths: ["src/a.ts"],
        },
        emptySource,
      ),
    ).toBeNull();
  });
});

describe("resolveSnapshotDiffContent - cumulative", () => {
  const source = {
    messages: [],
    liveAssistantBlocks: null,
    accumulatedFileChanges: [cumulativeChange("src/a.ts", "v1\n", "v9\n")],
  };

  it("resolves the chat-level cumulative change by path", () => {
    expect(
      resolveSnapshotDiffContent(
        { kind: "snapshot-cumulative", chatId: "c", filePath: "src/a.ts" },
        source,
      ),
    ).toEqual({
      filePath: "src/a.ts",
      beforeContent: "v1\n",
      afterContent: "v9\n",
    });
  });

  it("returns null when the file is no longer in the cumulative set", () => {
    expect(
      resolveSnapshotDiffContent(
        { kind: "snapshot-cumulative", chatId: "c", filePath: "src/other.ts" },
        source,
      ),
    ).toBeNull();
  });

  it("resolves a cumulative bundle from the listed file paths", () => {
    const resolved = resolveSnapshotDiffContents(
      {
        kind: "snapshot-cumulative-bundle",
        chatId: "c",
        filePaths: ["src/a.ts", "src/missing.ts"],
      },
      source,
    );

    expect(resolved).toEqual([
      {
        filePath: "src/a.ts",
        beforeContent: "v1\n",
        afterContent: "v9\n",
      },
    ]);
  });
});
