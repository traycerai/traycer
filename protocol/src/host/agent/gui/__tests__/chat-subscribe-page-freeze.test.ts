import { describe, expect, it } from "vitest";
import { z } from "zod";
import { accumulateEvent } from "@traycer/protocol/host/agent/gui/agent-runtime-accumulator";
import {
  runtimeEventSchema,
  runtimeEventSchemaPreBrowser,
  runtimeEventSchemaPreDisplayFacts,
  runtimeEventSchemaPreFallback,
  runtimeEventSchemaPrePage,
} from "@traycer/protocol/host/agent/gui/agent-runtime";
import {
  chatSubscribeV118,
  chatSubscribeV120,
  chatSubscribeV121,
  chatSubscribeV122,
} from "@traycer/protocol/host/agent/gui/subscribe";
import {
  contentBlockSchema,
  contentBlockSchemaPreBrowser,
  contentBlockSchemaPreFallback,
  contentBlockSchemaPrePage,
  contentBlockSchemaPreReasonix,
  contentBlockSchemaPreReceipt,
  contentBlockSchemaPreShellHost,
  contentBlockSchemaV18,
  type ToolCallBlock,
  type ToolCallMcpAppStamp,
  type ToolCallPageStamp,
} from "@traycer/protocol/persistence/epic/content-blocks";

/**
 * `chat.subscribe@1.22`: `page` and `mcpApp` on a `tool_call` block and on its
 * `tool_call.completed` event.
 *
 * PROJECTION, not tolerance: every line below `1.22` binds a hand-frozen block
 * and event that do not declare the keys, so a frame carrying them parses there
 * with the keys gone and everything else intact - on each channel a body
 * reaches a peer on (the tail, a `range` response, `blockDelta`). The live line
 * keeps them.
 */

const SHA = "c".repeat(64);

const PAGE: ToolCallPageStamp = {
  path: "files/pages/report-1.html",
  sha256: SHA,
  title: "Report",
  height: 320,
  heights: [{ width: 600, height: 410 }],
  derivedFrom: null,
  originChatId: "chat-1",
};

const MCP_APP: ToolCallMcpAppStamp = {
  server: "charts",
  tool: "render_chart",
  resourceUri: "ui://charts/view",
  snapshot: { path: "files/mcp-apps/view.html", sha256: SHA },
  csp: null,
  permissions: ["clipboard-write"],
  prefersBorder: true,
  toolInput: { series: "revenue" },
  toolResult: { content: [{ type: "text", text: "ok" }] },
  source: {
    originChatId: "chat-1",
    harnessId: "claude",
    nativeSessionId: "session-1",
    serverKey: SHA,
  },
  modelContext: null,
};

/** A tool call exactly as a 1.22 host persists it, both stamps present. */
function stampedToolCall(): Record<string, unknown> {
  return {
    type: "tool_call",
    blockId: "block-1",
    status: "completed",
    timestamp: 5,
    toolName: "traycer_show_page",
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
    page: PAGE,
    mcpApp: MCP_APP,
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
    toolName: "traycer_show_page",
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
  { label: "1.21", contract: chatSubscribeV121 },
] as const;

describe.each(FROZEN_LINES)(
  "chat.subscribe@$label never shows a peer a page or MCP App stamp",
  ({ contract }) => {
    const frames = contract.serverFrameSchema;

    it("drops both keys from a stamped block on the snapshot tail, keeping the call", () => {
      const parsed = frames.parse(
        snapshotFrame(assistantRow([stampedToolCall()])),
      );
      const block = firstToolCall(tailMessage(parsed));
      expect(has(block, "page")).toBe(false);
      expect(has(block, "mcpApp")).toBe(false);
      expect(block).toMatchObject({
        blockId: "block-1",
        toolName: "traycer_show_page",
        status: "completed",
      });
    });

    it("drops both keys from a stamped block on a range response", () => {
      const parsed = frames.parse(
        rangeFrame(assistantRow([stampedToolCall()])),
      );
      const block = firstToolCall(rangeMessage(parsed));
      expect(has(block, "page")).toBe(false);
      expect(has(block, "mcpApp")).toBe(false);
      expect(block).toMatchObject({ toolName: "traycer_show_page" });
    });

    it("drops both keys from a tool_call.completed on blockDelta, keeping the event", () => {
      const parsed = frames.parse(
        blockDeltaFrame(completedEvent({ page: PAGE, mcpApp: MCP_APP })),
      );
      if (parsed.kind !== "blockDelta") throw new Error("wrong kind");
      expect(has(parsed.event, "page")).toBe(false);
      expect(has(parsed.event, "mcpApp")).toBe(false);
      expect(parsed.event).toMatchObject({
        type: "tool_call.completed",
        toolName: "traycer_show_page",
      });
    });
  },
);

describe("chat.subscribe@1.22 carries the stamps", () => {
  const frames = chatSubscribeV122.serverFrameSchema;

  it("round-trips both stamps on the snapshot tail and on a range response", () => {
    const row = assistantRow([stampedToolCall()]);
    const tail = firstToolCall(tailMessage(frames.parse(snapshotFrame(row))));
    expect(tail).toMatchObject({ page: PAGE, mcpApp: MCP_APP });
    const range = firstToolCall(rangeMessage(frames.parse(rangeFrame(row))));
    expect(range).toMatchObject({ page: PAGE, mcpApp: MCP_APP });
  });

  it("round-trips both stamps on a tool_call.completed blockDelta", () => {
    const parsed = frames.parse(
      blockDeltaFrame(completedEvent({ page: PAGE, mcpApp: MCP_APP })),
    );
    if (parsed.kind !== "blockDelta") throw new Error("wrong kind");
    expect(parsed.event).toMatchObject({ page: PAGE, mcpApp: MCP_APP });
  });

  it("reads a block persisted before the keys as 'no stamp' (null), not as absent", () => {
    const legacy = Object.fromEntries(
      Object.entries(stampedToolCall()).filter(
        ([key]) => key !== "page" && key !== "mcpApp",
      ),
    );
    const block = firstToolCall(
      tailMessage(frames.parse(snapshotFrame(assistantRow([legacy])))),
    );
    expect(block).toMatchObject({ page: null, mcpApp: null });
  });

  it("refuses a stamp that is malformed rather than passing it to a renderer", () => {
    const badSha = { ...PAGE, sha256: "not-a-sha" };
    const shortHeight = { ...PAGE, height: 79 };
    const badScheme = { ...MCP_APP, resourceUri: "https://evil.example/app" };
    for (const stamps of [
      { page: badSha },
      { page: shortHeight },
      { mcpApp: badScheme },
    ]) {
      expect(
        frames.safeParse(
          snapshotFrame(
            assistantRow([{ ...stampedToolCall(), page: null, ...stamps }]),
          ),
        ).success,
      ).toBe(false);
    }
  });
});

describe("every historical content-block union strips the stamps from a tool call", () => {
  const unions = [
    ["PreReasonix", contentBlockSchemaPreReasonix],
    ["PreFallback", contentBlockSchemaPreFallback],
    ["PreShellHost", contentBlockSchemaPreShellHost],
    ["PreBrowser", contentBlockSchemaPreBrowser],
    ["PreReceipt", contentBlockSchemaPreReceipt],
    ["V18", contentBlockSchemaV18],
    ["PrePage", contentBlockSchemaPrePage],
  ] as const;

  it.each(unions)(
    "%s parses a stamped block with both keys gone",
    (_label, union) => {
      const parsed = union.parse(stampedToolCall());
      expect(parsed).toMatchObject({
        type: "tool_call",
        blockId: "block-1",
        toolName: "traycer_show_page",
      });
      expect(has(parsed, "page")).toBe(false);
      expect(has(parsed, "mcpApp")).toBe(false);
    },
  );

  it("the live union keeps them - the positive control for the strips above", () => {
    expect(contentBlockSchema.parse(stampedToolCall())).toMatchObject({
      page: PAGE,
      mcpApp: MCP_APP,
    });
  });
});

describe("every historical runtime-event union strips the stamps from tool_call.completed", () => {
  const unions = [
    ["PrePage", runtimeEventSchemaPrePage],
    ["PreDisplayFacts", runtimeEventSchemaPreDisplayFacts],
    ["PreBrowser", runtimeEventSchemaPreBrowser],
    ["PreFallback", runtimeEventSchemaPreFallback],
  ] as const;

  it.each(unions)(
    "%s parses a stamped event with both keys gone",
    (_label, union) => {
      const parsed = union.parse(
        completedEvent({ page: PAGE, mcpApp: MCP_APP }),
      );
      expect(parsed).toMatchObject({ type: "tool_call.completed" });
      expect(has(parsed, "page")).toBe(false);
      expect(has(parsed, "mcpApp")).toBe(false);
    },
  );
});

describe("the live tool_call.completed event", () => {
  it("accepts a stamp, an explicit null and an omission", () => {
    for (const stamps of [
      { page: PAGE },
      { mcpApp: MCP_APP },
      { page: null, mcpApp: null },
      {},
    ]) {
      expect(runtimeEventSchema.safeParse(completedEvent(stamps)).success).toBe(
        true,
      );
    }
  });

  it("leaves an omitted key omitted, so 'nothing to say' stays distinguishable from a stamp", () => {
    const parsed = runtimeEventSchema.parse(completedEvent({}));
    expect(has(parsed, "page")).toBe(false);
    expect(has(parsed, "mcpApp")).toBe(false);
  });
});

describe("accumulating a tool call's stamps", () => {
  function started(): ToolCallBlock[] {
    const blocks = accumulateEvent([], {
      type: "tool_call.started",
      blockId: "block-1",
      timestamp: 1,
      toolName: "traycer_show_page",
      agentMessageSend: null,
    });
    return blocks.filter((block) => block.type === "tool_call");
  }

  function completed(
    blocks: ToolCallBlock[],
    stamps: Record<string, unknown>,
  ): ToolCallBlock {
    const event = runtimeEventSchema.parse(completedEvent(stamps));
    const next = accumulateEvent(blocks, event);
    const [block] = next.filter((candidate) => candidate.type === "tool_call");
    if (block === undefined) throw new Error("expected a tool_call block");
    return block;
  }

  it("starts a call with no stamps", () => {
    expect(started()[0]).toMatchObject({ page: null, mcpApp: null });
  });

  it("stamps the block on completion", () => {
    const block = completed(started(), { page: PAGE, mcpApp: MCP_APP });
    expect(block.page).toEqual(PAGE);
    expect(block.mcpApp).toEqual(MCP_APP);
  });

  it.each([
    ["omits the keys", {}],
    ["sends them as null", { page: null, mcpApp: null }],
  ])("keeps the stamps through a re-completion that %s", (_label, stamps) => {
    const first = completed(started(), { page: PAGE, mcpApp: MCP_APP });
    const again = completed([first], stamps);
    expect(again.page).toEqual(PAGE);
    expect(again.mcpApp).toEqual(MCP_APP);
  });

  it("completes an unstamped call to null stamps, and a late re-completion can still stamp it", () => {
    const plain = completed(started(), {});
    expect(plain).toMatchObject({ page: null, mcpApp: null });
    const stamped = completed([plain], { page: PAGE });
    expect(stamped.page).toEqual(PAGE);
    expect(stamped.mcpApp).toBeNull();
  });

  it("stamps a completion that arrives with no started event", () => {
    const block = completed([], { mcpApp: MCP_APP });
    expect(block.mcpApp).toEqual(MCP_APP);
    expect(block.page).toBeNull();
  });
});
