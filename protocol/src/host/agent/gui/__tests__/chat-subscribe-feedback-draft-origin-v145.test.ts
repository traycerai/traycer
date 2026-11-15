import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import { toolCallBlockSchema } from "@traycer/protocol/persistence/epic/content-blocks";
import { assistantMessageSchema } from "@traycer/protocol/persistence/epic/messages";
import { CHAT_SYNC_SCHEMA_VERSION } from "@traycer/protocol/persistence/chat-sync/version";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  projectChatServerFrameForVersion,
  type ProjectedChatSubscribeServerFrame,
} from "../chat-frame-compat";

/**
 * T356. A bot's feedback draft rides two optional leaves that land together on
 * `chat.subscribe@1.45` and `chat-sync@1.15`: the host-owned
 * `tool_call.feedbackDraftOrigin` (where the draft was asked for) and the
 * channel row's `assistant.feedbackDraft` projection (the card). A peer below
 * 1.45 receives neither, in every carrier; the tool block's own `feedbackDraft`
 * stamp (1.42) is untouched by this change.
 */

const STAMP = {
  category: "tool_problem",
  toolName: "traycer_search_chats",
  goal: "find a chat",
  observed: "an opaque error",
  suggestion: null,
  suggestDiagnostics: false,
  state: "pending",
  decidedAt: null,
  failureReason: null,
};

const CHANNEL_ORIGIN = {
  kind: "channel",
  botId: "bot-1",
  hostEpoch: 3,
  conversationId: "conv-1",
  initiatingMessageId: "msg-1",
  initiatingRequestId: "req-1",
};

const THREAD_ORIGIN = { ...CHANNEL_ORIGIN, kind: "thread", channelId: "ch-1" };

const PROJECTION = {
  source: {
    hostId: "host-1",
    epicId: "epic-1",
    chatId: "chat-1",
    blockId: "b-1",
  },
  draft: STAMP,
};

const TOOL_BLOCK = {
  type: "tool_call",
  blockId: "b-1",
  feedbackDraft: STAMP,
  feedbackDraftOrigin: CHANNEL_ORIGIN,
};
const TEXT_BLOCK = { type: "text", blockId: "b-2" };
const ROW = {
  role: "assistant",
  blocks: [TOOL_BLOCK, TEXT_BLOCK],
  feedbackDraft: PROJECTION,
};

function version(minor: number): SchemaVersion {
  return { major: 1, minor };
}

const recordSchema = z.record(z.string(), z.unknown());

function asRecord(value: unknown): Record<string, unknown> {
  return recordSchema.parse(value);
}

function serverFrame(
  kind: string,
  body: Record<string, unknown>,
): ProjectedChatSubscribeServerFrame {
  return {
    ...body,
    kind,
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
  };
}

function rowsOf(container: unknown): unknown {
  return asRecord(container).messages;
}

const CARRIERS = [
  [
    "a range",
    () => serverFrame("range", { range: { messages: [ROW] } }),
    (frame: unknown) => rowsOf(asRecord(frame).range),
  ],
  [
    "a snapshot's tail",
    () =>
      serverFrame("snapshot", {
        snapshot: { tail: { messages: [ROW] } },
      }),
    (frame: unknown) => rowsOf(asRecord(asRecord(frame).snapshot).tail),
  ],
  [
    "a whole snapshot's chat",
    () =>
      serverFrame("snapshot", {
        snapshot: { chat: { messages: [ROW] } },
      }),
    (frame: unknown) => rowsOf(asRecord(asRecord(frame).snapshot).chat),
  ],
] as const;

describe.each(CARRIERS)(
  "the channel feedback draft on %s",
  (_carrier, frameOf, rowsIn) => {
    it.each([42, 44])(
      "loses the origin and the projection but keeps the stamp for chat.subscribe@1.%i",
      (minor) => {
        const projected = projectChatServerFrameForVersion(
          frameOf(),
          version(minor),
        );

        expect(rowsIn(projected)).toEqual([
          {
            role: "assistant",
            blocks: [
              { type: "tool_call", blockId: "b-1", feedbackDraft: STAMP },
              TEXT_BLOCK,
            ],
          },
        ]);
      },
    );

    it("loses all three for chat.subscribe@1.41", () => {
      const projected = projectChatServerFrameForVersion(
        frameOf(),
        version(41),
      );

      expect(rowsIn(projected)).toEqual([
        {
          role: "assistant",
          blocks: [{ type: "tool_call", blockId: "b-1" }, TEXT_BLOCK],
        },
      ]);
    });

    it("reaches chat.subscribe@1.45 whole", () => {
      expect(
        rowsIn(projectChatServerFrameForVersion(frameOf(), version(45))),
      ).toEqual([ROW]);
    });
  },
);

describe("the live leaves", () => {
  const toolCall = {
    type: "tool_call",
    blockId: "b-1",
    status: "completed",
    timestamp: 1,
    toolName: "traycer_draft_feedback",
    error: null,
    feedbackDraft: STAMP,
  };

  it.each([CHANNEL_ORIGIN, THREAD_ORIGIN])(
    "keep a $kind origin on the tool block",
    (origin) => {
      expect(
        toolCallBlockSchema.parse({ ...toolCall, feedbackDraftOrigin: origin })
          .feedbackDraftOrigin,
      ).toEqual(origin);
    },
  );

  it("default the origin to absent for a task agent's block", () => {
    expect(
      toolCallBlockSchema.parse(toolCall).feedbackDraftOrigin,
    ).toBeUndefined();
  });

  it.each([
    ["a thread with no channel", { ...CHANNEL_ORIGIN, kind: "thread" }],
    ["an unknown kind", { ...CHANNEL_ORIGIN, kind: "dm" }],
    ["an empty conversation", { ...CHANNEL_ORIGIN, conversationId: "" }],
    ["a negative epoch", { ...CHANNEL_ORIGIN, hostEpoch: -1 }],
    ["a caller-chosen actor", { ...CHANNEL_ORIGIN, actor: "someone" }],
  ])("refuse %s", (_name, origin) => {
    expect(
      toolCallBlockSchema.safeParse({
        ...toolCall,
        feedbackDraftOrigin: origin,
      }).success,
    ).toBe(false);
  });

  it("keep the projection on the assistant row and refuse an unsettled source", () => {
    const row = {
      role: "assistant",
      messageId: "m-1",
      sender: {
        type: "agent",
        harnessId: "claude",
        agentId: "agent-1",
        displayName: "Claude",
      },
      blocks: [],
      startedAt: 1,
      timestamp: 1,
      turnId: "t-1",
      usage: null,
    };

    expect(
      assistantMessageSchema.parse({ ...row, feedbackDraft: PROJECTION })
        .feedbackDraft,
    ).toEqual(PROJECTION);
    expect(
      assistantMessageSchema.safeParse({
        ...row,
        feedbackDraft: {
          ...PROJECTION,
          source: { ...PROJECTION.source, blockId: "" },
        },
      }).success,
    ).toBe(false);
  });

  it("ride chat-sync 1.15", () => {
    expect(CHAT_SYNC_SCHEMA_VERSION).toEqual({ major: 1, minor: 15 });
  });
});

describe("the chat.subscribe registry", () => {
  const versions = hostStreamRpcRegistry["chat.subscribe"][1].versions;

  it("serves 1.45 as its own contract above a frozen 1.44", () => {
    expect(versions[45].contract.schemaVersion).toEqual({
      major: 1,
      minor: 45,
    });
    expect(versions[45].contract).not.toBe(versions[44].contract);
    expect(versions[45].contract.serverFrameSchema).not.toBe(
      versions[44].contract.serverFrameSchema,
    );
  });

  // What each registered line's own server-frame parser keeps of a range
  // frame the host built at 1.45: the released lines bind frozen leaves
  // without the new keys, so they drop them; a peer negotiating 1.45 keeps
  // both. This is the parser, not the outbound projector above.
  const SENDER = {
    type: "agent",
    harnessId: "claude",
    agentId: "agent-1",
    displayName: "Claude",
  };

  function tailRow(): unknown {
    return {
      role: "assistant",
      messageId: "m-1",
      sender: SENDER,
      blocks: [
        {
          type: "tool_call",
          blockId: "b-1",
          status: "completed",
          timestamp: 1,
          toolName: "traycer_draft_feedback",
          error: null,
          feedbackDraft: STAMP,
          feedbackDraftOrigin: CHANNEL_ORIGIN,
        },
      ],
      startedAt: 1,
      timestamp: 1,
      turnId: "t-1",
      usage: null,
      feedbackDraft: PROJECTION,
    };
  }

  function rangeFrame(): unknown {
    return {
      kind: "range",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      range: {
        requestId: "range-1",
        epoch: 0,
        fromOrdinal: 0,
        rowIds: ["m-1"],
        messages: [tailRow()],
        events: [],
        rowContext: {},
        reachedStart: true,
        reachedEnd: true,
      },
    };
  }

  // The windowed opening frame: the chat carries no rows, the tail does.
  function snapshotFrame(): unknown {
    return {
      kind: "snapshot",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
      snapshot: {
        chat: {
          parentId: null,
          id: "chat-1",
          userId: "user-1",
          hostId: "host-1",
          title: "Chat",
          createdAt: 1000,
          updatedAt: 1000,
          isTitleEditedByUser: false,
        },
        access: { role: "owner", ownerUserId: "user-1", canAct: true },
        queue: { status: "idle", items: [] },
        runStatus: "idle",
        activeTurn: null,
        pendingApprovals: [],
        pendingInterviews: [],
        worktreeBinding: null,
        missingWorktreePaths: [],
        pendingFileEditApprovals: [],
        accumulatedFileChangeCount: 0,
        transcriptEpoch: 0,
        rowCount: 1,
        indexRevision: null,
        tail: { fromOrdinal: 0, messages: [tailRow()], events: [] },
        derived: {
          latestAssistantUsage: null,
          pinnedTodo: null,
          pinnedTaskTodoItems: [],
          latestForkableAssistantMessageId: null,
          restorableSetupInterruption: null,
          interviewAnswerability: [],
          latestAssistantAuthFailureTurnKey: null,
          setupCardWindows: [],
        },
      },
    };
  }

  const PARSED_CARRIERS = [
    ["range", rangeFrame, (data: unknown) => asRecord(asRecord(data).range)],
    [
      "snapshot tail",
      snapshotFrame,
      (data: unknown) => asRecord(asRecord(asRecord(data).snapshot).tail),
    ],
  ] as const;

  function parsedRow(
    minor: number,
    frameOf: () => unknown,
    containerOf: (data: unknown) => Record<string, unknown>,
  ): Record<string, unknown> {
    const result =
      versions[minor].contract.serverFrameSchema.safeParse(frameOf());
    expect(result.success).toBe(true);
    const rows = z.array(z.unknown()).parse(containerOf(result.data).messages);
    return asRecord(rows[0]);
  }

  function toolBlockOf(row: Record<string, unknown>): Record<string, unknown> {
    return asRecord(z.array(z.unknown()).parse(row.blocks)[0]);
  }

  describe.each(PARSED_CARRIERS)(
    "a 1.45 %s parsed per line",
    (_carrier, frameOf, containerOf) => {
      it.each([42, 43, 44])(
        "keeps the stamp but drops the origin and the row projection on the frozen 1.%i line",
        (minor) => {
          const row = parsedRow(minor, frameOf, containerOf);
          expect(row).not.toHaveProperty("feedbackDraft");
          expect(toolBlockOf(row)).not.toHaveProperty("feedbackDraftOrigin");
          expect(toolBlockOf(row).feedbackDraft).toEqual(STAMP);
        },
      );

      it("keeps the origin and the row projection on 1.45", () => {
        const row = parsedRow(45, frameOf, containerOf);
        expect(row.feedbackDraft).toEqual(PROJECTION);
        expect(toolBlockOf(row).feedbackDraftOrigin).toEqual(CHANNEL_ORIGIN);
      });
    },
  );
});
