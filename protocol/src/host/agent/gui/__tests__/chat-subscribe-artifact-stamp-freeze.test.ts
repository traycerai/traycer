import { describe, expect, it } from "vitest";
import { z } from "zod";
import { accumulateEvent } from "@traycer/protocol/host/agent/gui/agent-runtime-accumulator";
import {
  runtimeEventSchema,
  runtimeEventSchemaPreBrowser,
  runtimeEventSchemaPreDisplayFacts,
  runtimeEventSchemaPreFallback,
  runtimeEventSchemaPreMcpApp,
} from "@traycer/protocol/host/agent/gui/agent-runtime";
import {
  chatSubscribeV118,
  chatSubscribeV120,
  chatSubscribeV123,
  chatSubscribeV127,
  chatSubscribeV128,
  chatSubscribeV129,
  chatSubscribeV130,
} from "@traycer/protocol/host/agent/gui/subscribe";
import {
  ARTIFACT_STAMP_MAX_FILES,
  contentBlockSchema,
  contentBlockSchemaPreBrowser,
  contentBlockSchemaPreFallback,
  contentBlockSchemaPreHtml,
  contentBlockSchemaPreMcpApp,
  contentBlockSchemaPreReasonix,
  contentBlockSchemaPreReceipt,
  contentBlockSchemaPreShellHost,
  contentBlockSchemaV18,
  type ToolCallArtifactStamp,
  type ToolCallBlock,
} from "@traycer/protocol/persistence/epic/content-blocks";

/**
 * `chat.subscribe@1.30`: `artifact` on a `tool_call` block and on its
 * `tool_call.completed` event - the manifest an inline `traycer_render_inline`
 * artifact showed. A direct structural clone of `chat-subscribe-mcp-app-freeze.test.ts`
 * for this key, extended with the manifest's own size guards.
 *
 * PROJECTION, not tolerance: every line below `1.30` binds a hand-frozen block
 * and event that do not declare the key, so a frame carrying it parses there
 * with the key gone and everything else intact - on each channel a body
 * reaches a peer on (the tail, a `range` response, `blockDelta`). `1.29`
 * (the html/canvas/file artifact-KIND line) is frozen the same way: it is
 * where `contentBlockSchemaPreHtml` / `openContentBlockSchemaPreHtml`, which
 * used to bind the live `tool_call` schema BY REFERENCE, were repointed to the
 * newly-frozen `toolCallBlockSchemaPreArtifact` so they do not silently gain
 * this key.
 */

const SHA = "c".repeat(64);

const ARTIFACT: ToolCallArtifactStamp = {
  artifactId: "artifact-1",
  title: "Report",
  manifest: {
    files: {
      "index.html": { sha256: SHA, byteLength: 10, mediaType: "text/html" },
    },
    capturedAt: 1000,
  },
  originChatId: "chat-1",
};

/** A tool call exactly as a live host persists it, the artifact stamp present. */
function stampedToolCall(): Record<string, unknown> {
  return {
    type: "tool_call",
    blockId: "block-1",
    status: "completed",
    timestamp: 5,
    toolName: "traycer_render_inline",
    inputSummary: null,
    inputDetail: null,
    taskTodoItems: null,
    error: null,
    agentMessageSend: null,
    agentMessageReceipt: null,
    managedCommand: null,
    progress: null,
    backgroundOutput: null,
    startedAt: 4,
    endedAt: 5,
    backgroundTask: false,
    stopped: false,
    imageResults: [],
    artifact: ARTIFACT,
    mcpApp: null,
  };
}

function assistantRow(blocks: readonly unknown[]): Record<string, unknown> {
  return {
    role: "assistant",
    messageId: "assistant-1",
    sender: {
      type: "agent",
      harnessId: "claude",
      agentId: "agent-1",
      displayName: "Coder",
      reply: { expectsReply: false },
      inReplyTo: null,
    },
    blocks,
    startedAt: 1,
    timestamp: 6,
    turnId: "turn-1",
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
    envCredentialVar: null,
    imageResolutions: [],
  };
}

function snapshotFrame(message: unknown): Record<string, unknown> {
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
      tail: { fromOrdinal: 0, messages: [message], events: [] },
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

function rangeFrame(message: unknown): Record<string, unknown> {
  return {
    kind: "range",
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    range: {
      requestId: "range-1",
      epoch: 0,
      fromOrdinal: 0,
      rowIds: ["assistant-1"],
      messages: [message],
      events: [],
      reachedStart: true,
      reachedEnd: true,
    },
  };
}

function completedEvent(
  stamps: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: "tool_call.completed",
    blockId: "block-1",
    timestamp: 5,
    toolName: "traycer_render_inline",
    ...stamps,
  };
}

function blockDeltaFrame(event: unknown): Record<string, unknown> {
  return {
    kind: "blockDelta",
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    event,
  };
}

function has(value: object, key: string): boolean {
  return Object.hasOwn(value, key);
}

const toolCallShape = z.object({ type: z.literal("tool_call") }).loose();
const messageWithBlocks = z.object({ blocks: z.array(z.unknown()) }).loose();

/** The first block of the one message a parsed snapshot tail / range carries. */
function firstToolCall(message: unknown): Record<string, unknown> {
  const blocks = messageWithBlocks.parse(message).blocks;
  return toolCallShape.parse(blocks[0]);
}

function tailMessage(parsed: { kind: string; snapshot?: unknown }): unknown {
  const snapshot = z
    .object({ tail: z.object({ messages: z.array(z.unknown()) }) })
    .parse(parsed.snapshot);
  return snapshot.tail.messages[0];
}

function rangeMessage(parsed: { kind: string; range?: unknown }): unknown {
  const range = z
    .object({ messages: z.array(z.unknown()) })
    .parse(parsed.range);
  return range.messages[0];
}

const FROZEN_LINES = [
  { label: "1.18", contract: chatSubscribeV118 },
  { label: "1.20", contract: chatSubscribeV120 },
  { label: "1.23", contract: chatSubscribeV123 },
  { label: "1.27", contract: chatSubscribeV127 },
  { label: "1.28", contract: chatSubscribeV128 },
  { label: "1.29", contract: chatSubscribeV129 },
] as const;

describe.each(FROZEN_LINES)(
  "chat.subscribe@$label never shows a peer an artifact stamp",
  ({ contract }) => {
    const frames = contract.serverFrameSchema;

    it("drops the key from a stamped block on the snapshot tail, keeping the call", () => {
      const parsed = frames.parse(
        snapshotFrame(assistantRow([stampedToolCall()])),
      );
      const block = firstToolCall(tailMessage(parsed));
      expect(has(block, "artifact")).toBe(false);
      expect(block).toMatchObject({
        blockId: "block-1",
        toolName: "traycer_render_inline",
        status: "completed",
      });
    });

    it("drops the key from a stamped block on a range response", () => {
      const parsed = frames.parse(
        rangeFrame(assistantRow([stampedToolCall()])),
      );
      const block = firstToolCall(rangeMessage(parsed));
      expect(has(block, "artifact")).toBe(false);
      expect(block).toMatchObject({ toolName: "traycer_render_inline" });
    });

    it("drops the key from a tool_call.completed on blockDelta, keeping the event", () => {
      const parsed = frames.parse(
        blockDeltaFrame(completedEvent({ artifact: ARTIFACT })),
      );
      if (parsed.kind !== "blockDelta") throw new Error("wrong kind");
      expect(has(parsed.event, "artifact")).toBe(false);
      expect(parsed.event).toMatchObject({
        type: "tool_call.completed",
        toolName: "traycer_render_inline",
      });
    });
  },
);

describe("chat.subscribe@1.30 carries the artifact stamp", () => {
  const frames = chatSubscribeV130.serverFrameSchema;

  it("round-trips the stamp on the snapshot tail and on a range response", () => {
    const row = assistantRow([stampedToolCall()]);
    const tail = firstToolCall(tailMessage(frames.parse(snapshotFrame(row))));
    expect(tail).toMatchObject({ artifact: ARTIFACT });
    const range = firstToolCall(rangeMessage(frames.parse(rangeFrame(row))));
    expect(range).toMatchObject({ artifact: ARTIFACT });
  });

  it("round-trips the stamp on a tool_call.completed blockDelta", () => {
    const parsed = frames.parse(
      blockDeltaFrame(completedEvent({ artifact: ARTIFACT })),
    );
    if (parsed.kind !== "blockDelta") throw new Error("wrong kind");
    expect(parsed.event).toMatchObject({ artifact: ARTIFACT });
  });

  it("reads a block persisted before the key as 'no stamp' (null), not as absent", () => {
    const legacy = Object.fromEntries(
      Object.entries(stampedToolCall()).filter(([key]) => key !== "artifact"),
    );
    const block = firstToolCall(
      tailMessage(frames.parse(snapshotFrame(assistantRow([legacy])))),
    );
    expect(block).toMatchObject({ artifact: null });
  });

  it("refuses a stamp that is malformed rather than passing it to a renderer", () => {
    const badSha = {
      ...ARTIFACT,
      manifest: {
        ...ARTIFACT.manifest,
        files: {
          "index.html": {
            sha256: "not-a-sha",
            byteLength: 10,
            mediaType: "text/html",
          },
        },
      },
    };
    // JSON.parse makes __proto__ an own property; an object literal with a
    // `__proto__:` key would set the prototype instead and prove nothing.
    const fileRef = { sha256: SHA, byteLength: 10, mediaType: "text/html" };
    const protoFiles: unknown = JSON.parse(
      `{"__proto__":${JSON.stringify(fileRef)}}`,
    );
    const protoPath = {
      ...ARTIFACT,
      manifest: { ...ARTIFACT.manifest, files: protoFiles },
    };
    const noOrigin = { ...ARTIFACT, originChatId: "" };
    for (const artifact of [badSha, protoPath, noOrigin]) {
      expect(
        frames.safeParse(
          snapshotFrame(assistantRow([{ ...stampedToolCall(), artifact }])),
        ).success,
      ).toBe(false);
    }
  });

  it("refuses a manifest over the file-count limit, and accepts exactly the limit", () => {
    const filesAt = (count: number) =>
      Object.fromEntries(
        Array.from({ length: count }, (_unused, index) => [
          `f${index}.html`,
          { sha256: SHA, byteLength: 10, mediaType: "text/html" },
        ]),
      );
    const over = {
      ...ARTIFACT,
      manifest: {
        files: filesAt(ARTIFACT_STAMP_MAX_FILES + 1),
        capturedAt: 1000,
      },
    };
    const atLimit = {
      ...ARTIFACT,
      manifest: { files: filesAt(ARTIFACT_STAMP_MAX_FILES), capturedAt: 1000 },
    };
    expect(
      frames.safeParse(blockDeltaFrame(completedEvent({ artifact: over })))
        .success,
    ).toBe(false);
    expect(
      frames.safeParse(blockDeltaFrame(completedEvent({ artifact: atLimit })))
        .success,
    ).toBe(true);
  });
});

describe("every historical content-block union strips the artifact stamp from a tool call", () => {
  const unions = [
    ["PreReasonix", contentBlockSchemaPreReasonix],
    ["PreFallback", contentBlockSchemaPreFallback],
    ["PreShellHost", contentBlockSchemaPreShellHost],
    ["PreBrowser", contentBlockSchemaPreBrowser],
    ["PreReceipt", contentBlockSchemaPreReceipt],
    ["V18", contentBlockSchemaV18],
    ["PreMcpApp", contentBlockSchemaPreMcpApp],
    ["PreHtml", contentBlockSchemaPreHtml],
  ] as const;

  it.each(unions)(
    "%s parses a stamped block with the key gone",
    (_label, union) => {
      const parsed = union.parse(stampedToolCall());
      expect(parsed).toMatchObject({
        type: "tool_call",
        blockId: "block-1",
        toolName: "traycer_render_inline",
      });
      expect(has(parsed, "artifact")).toBe(false);
    },
  );

  it("the live union keeps it - the positive control for the strips above", () => {
    expect(contentBlockSchema.parse(stampedToolCall())).toMatchObject({
      artifact: ARTIFACT,
    });
  });
});

describe("every historical runtime-event union strips the artifact stamp from tool_call.completed", () => {
  const unions = [
    ["PreMcpApp", runtimeEventSchemaPreMcpApp],
    ["PreDisplayFacts", runtimeEventSchemaPreDisplayFacts],
    ["PreBrowser", runtimeEventSchemaPreBrowser],
    ["PreFallback", runtimeEventSchemaPreFallback],
  ] as const;

  it.each(unions)(
    "%s parses a stamped event with the key gone",
    (_label, union) => {
      const parsed = union.parse(completedEvent({ artifact: ARTIFACT }));
      expect(parsed).toMatchObject({ type: "tool_call.completed" });
      expect(has(parsed, "artifact")).toBe(false);
    },
  );
});

describe("the live tool_call.completed event", () => {
  it("accepts a stamp, an explicit null and an omission", () => {
    for (const stamps of [{ artifact: ARTIFACT }, { artifact: null }, {}]) {
      expect(runtimeEventSchema.safeParse(completedEvent(stamps)).success).toBe(
        true,
      );
    }
  });

  it("leaves an omitted key omitted, so 'nothing to say' stays distinguishable from a stamp", () => {
    const parsed = runtimeEventSchema.parse(completedEvent({}));
    expect(has(parsed, "artifact")).toBe(false);
  });
});

describe("accumulating a tool call's artifact stamp", () => {
  function startedBlocks(): ToolCallBlock[] {
    const blocks = accumulateEvent([], {
      type: "tool_call.started",
      blockId: "block-1",
      timestamp: 1,
      toolName: "traycer_render_inline",
      agentMessageSend: null,
    });
    return blocks.filter((block) => block.type === "tool_call");
  }

  function completedBlock(
    blocks: ToolCallBlock[],
    stamps: Record<string, unknown>,
  ): ToolCallBlock {
    const event = runtimeEventSchema.parse(completedEvent(stamps));
    const next = accumulateEvent(blocks, event);
    const [block] = next.filter((candidate) => candidate.type === "tool_call");
    if (block === undefined) throw new Error("expected a tool_call block");
    return block;
  }

  it("starts a call with no stamp", () => {
    expect(startedBlocks()[0]).toMatchObject({ artifact: null });
  });

  it("stamps the block on completion", () => {
    const block = completedBlock(startedBlocks(), { artifact: ARTIFACT });
    expect(block.artifact).toEqual(ARTIFACT);
  });

  it.each([
    ["omits the key", {}],
    ["sends it as null", { artifact: null }],
  ])("keeps the stamp through a re-completion that %s", (_label, stamps) => {
    const first = completedBlock(startedBlocks(), { artifact: ARTIFACT });
    const again = completedBlock([first], stamps);
    expect(again.artifact).toEqual(ARTIFACT);
  });

  it("completes an unstamped call to a null stamp, and a late re-completion can still stamp it", () => {
    const plain = completedBlock(startedBlocks(), {});
    expect(plain).toMatchObject({ artifact: null });
    const stamped = completedBlock([plain], { artifact: ARTIFACT });
    expect(stamped.artifact).toEqual(ARTIFACT);
  });

  it("stamps a completion that arrives with no started event", () => {
    const block = completedBlock([], { artifact: ARTIFACT });
    expect(block.artifact).toEqual(ARTIFACT);
  });
});
