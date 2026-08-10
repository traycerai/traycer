import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  AgentSender,
  ContentBlock,
  Message,
} from "@traycer/protocol/persistence/epic/schemas";
import type { ImageResolutionEntry } from "@traycer/protocol/persistence/epic/messages";
import type { ImageGenerationResult } from "@traycer/protocol/persistence/epic/content-blocks";
import { deriveToolInputDetail } from "@traycer/protocol/host/agent/gui/tool-input-detail";
import { deriveToolInputSummary } from "@traycer/protocol/host/agent/gui/tool-input-summary";
import {
  isTaskTodoToolName,
  parseTaskTodoToolPayloads,
} from "@traycer/protocol/host/agent/gui/task-todo-tools";
import {
  computeStableChatTimelineRows,
  EMPTY_STABLE_CHAT_TIMELINE_ROWS_STATE,
} from "@/components/chat/chat-stable-rows";
import {
  useRenderedMessages,
  type RenderedMessagesDisplayContext,
  type RenderedMessagesInput,
} from "@/stores/chats/rendered-messages";
import type { MessageSegment } from "@/stores/composer/chat-store";

const CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }],
};

const BINDING = {
  epicId: "epic-1",
  ownerId: "chat-1",
  ownerKind: "chat" as const,
  viewTabId: "tab-1",
};

const ASSISTANT_SENDER: AgentSender = {
  type: "agent",
  harnessId: "claude",
  agentId: "claude-sonnet-4",
  displayName: "Claude Sonnet 4",
  reply: { expectsReply: false },
  inReplyTo: null,
};

const displayContext: RenderedMessagesDisplayContext = {
  resolveUserSenderLabel: () => "You",
  resolveAgentSenderDisplay: () => ({
    senderLabel: "Claude",
    providerLabel: "Claude Code",
    modelLabel: null,
  }),
  resolveAgentReasoningLabel: () => null,
  contentBlocksText: () => "",
};

function toolCallInputFields(toolName: string, input: unknown) {
  return {
    inputSummary: deriveToolInputSummary(toolName, input),
    inputDetail: deriveToolInputDetail(toolName, input),
    taskTodoItems: isTaskTodoToolName(toolName)
      ? parseTaskTodoToolPayloads({ toolName, payloads: [input] })
      : null,
  };
}

function userMessage(messageId: string): Extract<Message, { role: "user" }> {
  return {
    role: "user",
    messageId,
    sender: { type: "user", userId: "owner-1" },
    message: {
      kind: "user",
      content: CONTENT,
    },
    timestamp: 1000,
    sessionAnchor: null,
  };
}

function assistantMessage(
  turnId: string,
  timestamp: number,
): Extract<Message, { role: "assistant" }> {
  return {
    role: "assistant",
    messageId: turnId,
    sender: ASSISTANT_SENDER,
    blocks: [],
    startedAt: timestamp,
    timestamp,
    turnId,
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
    imageResolutions: [],
  };
}

function textBlock(
  blockId: string,
  timestamp: number,
  text: string,
): ContentBlock {
  return {
    type: "text",
    blockId,
    status: "completed",
    timestamp,
    text,
    providerNotice: null,
  };
}

function imageResult(
  overrides: Partial<ImageGenerationResult> & {
    readonly attachmentHash: string;
  },
): ImageGenerationResult {
  return {
    mediaType: "image/png",
    byteLength: 128,
    width: null,
    height: null,
    alt: null,
    revisedPrompt: null,
    filePath: null,
    ...overrides,
  };
}

function toolCallWithImages(args: {
  readonly blockId: string;
  readonly timestamp: number;
  readonly imageResults: ReadonlyArray<ImageGenerationResult>;
}): ContentBlock {
  return {
    type: "tool_call",
    blockId: args.blockId,
    toolName: "image_generation",
    ...toolCallInputFields("image_generation", { prompt: "a cat" }),
    error: null,
    agentMessageSend: null,
    progress: null,
    backgroundOutput: null,
    backgroundTask: false,
    stopped: false,
    status: "completed",
    timestamp: args.timestamp,
    startedAt: args.timestamp,
    endedAt: args.timestamp,
    imageResults: [...args.imageResults],
  };
}

function resolvedEntry(
  source: string,
  attachmentHash: string,
  overrides: Partial<Extract<ImageResolutionEntry, { state: "resolved" }>>,
): Extract<ImageResolutionEntry, { state: "resolved" }> {
  return {
    source,
    canonicalSource: source,
    width: null,
    height: null,
    state: "resolved",
    attachmentHash,
    mediaType: "image/png",
    ...overrides,
  };
}

function consentEntry(source: string): ImageResolutionEntry {
  return {
    source,
    canonicalSource: source,
    width: null,
    height: null,
    state: "consent-required",
    attachmentHash: null,
    mediaType: null,
  };
}

const CANONICAL_INPUT: RenderedMessagesInput = {
  messages: [],
  events: [],
  pendingUserMessages: [],
  liveAssistantMessage: null,
  activeTurn: null,
  runStatus: "idle",
  ...BINDING,
};

function renderRenderedMessages(patch: Partial<RenderedMessagesInput>) {
  let current: RenderedMessagesInput = { ...CANONICAL_INPUT, ...patch };
  const hook = renderHook(
    ({ value }: { value: RenderedMessagesInput }) =>
      useRenderedMessages(value, displayContext),
    { initialProps: { value: current } },
  );
  return {
    result: hook.result,
    patch(next: Partial<RenderedMessagesInput>): void {
      current = { ...current, ...next };
      hook.rerender({ value: current });
    },
  };
}

function textSegmentContext(
  segments: ReadonlyArray<MessageSegment>,
): NonNullable<
  Extract<MessageSegment, { kind: "text" }>["assistantImageContext"]
> | null {
  const text = segments.find(
    (segment): segment is Extract<MessageSegment, { kind: "text" }> =>
      segment.kind === "text",
  );
  return text?.assistantImageContext ?? null;
}

describe("useRenderedMessages assistant image echo dedup", () => {
  it("deduplicates a prose image whose resolution hash matches a tool card imageResults hash", () => {
    const source = "/generated/cat.png";
    const hash = "hash-cat-1";
    const assistant: Message = {
      ...assistantMessage("turn-img-hash", 2000),
      blocks: [
        toolCallWithImages({
          blockId: "tool-img-1",
          timestamp: 2001,
          imageResults: [imageResult({ attachmentHash: hash, filePath: null })],
        }),
        textBlock("text-1", 2002, `![cat](${source})`),
      ],
      imageResolutions: [resolvedEntry(source, hash, {})],
    };

    const { result } = renderRenderedMessages({ messages: [assistant] });
    const context = textSegmentContext(result.current[0]?.segments ?? []);
    expect(context).not.toBeNull();
    expect(context?.deduplicatedSources.has(source)).toBe(true);
  });

  it("deduplicates by canonical source / tool filePath when hashes differ", () => {
    const authored = "./relative-cat.png";
    const canonical = "/abs/generated/cat.png";
    const assistant: Message = {
      ...assistantMessage("turn-img-source", 2000),
      blocks: [
        toolCallWithImages({
          blockId: "tool-img-1",
          timestamp: 2001,
          imageResults: [
            imageResult({
              attachmentHash: "tool-hash",
              filePath: canonical,
            }),
          ],
        }),
        textBlock("text-1", 2002, `![cat](${authored})`),
      ],
      imageResolutions: [
        resolvedEntry(authored, "prose-hash", {
          canonicalSource: canonical,
        }),
      ],
    };

    const { result } = renderRenderedMessages({ messages: [assistant] });
    const context = textSegmentContext(result.current[0]?.segments ?? []);
    expect(context).not.toBeNull();
    expect(context?.deduplicatedSources.has(authored)).toBe(true);
    expect(context?.deduplicatedSources.has(canonical)).toBe(true);
  });

  it("keeps pending prose images until the resolution record commits, then collapses", () => {
    const source = "/generated/pending.png";
    const hash = "hash-pending-1";
    const tool = toolCallWithImages({
      blockId: "tool-img-1",
      timestamp: 2001,
      imageResults: [imageResult({ attachmentHash: hash, filePath: source })],
    });
    const text = textBlock("text-1", 2002, `![pending](${source})`);

    const pending: Message = {
      ...assistantMessage("turn-img-pending", 2000),
      blocks: [tool, text],
      // Still consent/pending: no resolved entry yet, so no echo collapse.
      imageResolutions: [consentEntry(source)],
    };

    const driver = renderRenderedMessages({ messages: [pending] });
    const pendingContext = textSegmentContext(
      driver.result.current[0]?.segments ?? [],
    );
    expect(pendingContext?.deduplicatedSources.has(source)).toBe(false);

    const committed: Message = {
      ...pending,
      // Fresh array identity so the turn signature invalidates.
      imageResolutions: [resolvedEntry(source, hash, {})],
    };
    driver.patch({ messages: [committed] });

    const committedContext = textSegmentContext(
      driver.result.current[0]?.segments ?? [],
    );
    expect(committedContext?.deduplicatedSources.has(source)).toBe(true);
  });

  it("does not collapse when neither hash nor source matches any tool imageResults", () => {
    const assistant: Message = {
      ...assistantMessage("turn-img-unrelated", 2000),
      blocks: [
        toolCallWithImages({
          blockId: "tool-img-1",
          timestamp: 2001,
          imageResults: [
            imageResult({
              attachmentHash: "other-hash",
              filePath: "/generated/other.png",
            }),
          ],
        }),
        textBlock("text-1", 2002, "![local](/workspace/local.png)"),
      ],
      imageResolutions: [
        resolvedEntry("/workspace/local.png", "local-hash", {}),
      ],
    };

    const { result } = renderRenderedMessages({ messages: [assistant] });
    const context = textSegmentContext(result.current[0]?.segments ?? []);
    expect(context?.deduplicatedSources.size ?? -1).toBe(0);
  });
});

describe("useRenderedMessages image resolution stable-row identity", () => {
  it("rebuilds only the assistant row whose imageResolutions record changed", () => {
    const turnA: Message = {
      ...assistantMessage("turn-a", 2000),
      blocks: [textBlock("text-a", 2001, "![a](/a.png)")],
      imageResolutions: [consentEntry("/a.png")],
    };
    const turnB: Message = {
      ...assistantMessage("turn-b", 3000),
      blocks: [textBlock("text-b", 3001, "![b](/b.png)")],
      imageResolutions: [consentEntry("/b.png")],
    };
    const user = userMessage("user-1");

    const driver = renderRenderedMessages({
      messages: [user, turnA, turnB],
    });
    const initial = driver.result.current;
    expect(initial).toHaveLength(3);

    let stable = computeStableChatTimelineRows(
      initial,
      EMPTY_STABLE_CHAT_TIMELINE_ROWS_STATE,
    );
    const rowABefore = stable.result.find((row) => row.id.includes("turn-a"));
    const rowBBefore = stable.result.find((row) => row.id.includes("turn-b"));
    expect(rowABefore).toBeDefined();
    expect(rowBBefore).toBeDefined();

    const updatedTurnA: Message = {
      ...turnA,
      imageResolutions: [resolvedEntry("/a.png", "hash-a", {})],
    };
    driver.patch({ messages: [user, updatedTurnA, turnB] });

    const next = driver.result.current;
    stable = computeStableChatTimelineRows(next, stable);

    const rowAAfter = stable.result.find((row) => row.id.includes("turn-a"));
    const rowBAfter = stable.result.find((row) => row.id.includes("turn-b"));
    expect(rowAAfter).toBeDefined();
    expect(rowBAfter).toBeDefined();

    // The resolution change must produce a new row identity for A only.
    expect(rowAAfter).not.toBe(rowABefore);
    expect(rowBAfter).toBe(rowBBefore);

    const contextA = textSegmentContext(rowAAfter?.segments ?? []);
    expect(contextA?.resolutions[0]?.entry.state).toBe("resolved");
    expect(contextA?.resolutions[0]?.entry.attachmentHash).toBe("hash-a");
  });

  it("threads image context onto text segments only", () => {
    const assistant: Message = {
      ...assistantMessage("turn-context", 2000),
      blocks: [
        toolCallWithImages({
          blockId: "tool-1",
          timestamp: 2001,
          imageResults: [],
        }),
        textBlock("text-1", 2002, "see ![x](/x.png)"),
      ],
      imageResolutions: [consentEntry("/x.png")],
    };

    const { result } = renderRenderedMessages({ messages: [assistant] });
    const segments = result.current[0]?.segments ?? [];
    const text = segments.find((segment) => segment.kind === "text");
    const tool = segments.find((segment) => segment.kind === "tool");
    expect(text).toBeDefined();
    expect(tool).toBeDefined();
    expect(
      text && "assistantImageContext" in text
        ? text.assistantImageContext
        : null,
    ).toMatchObject({
      epicId: "epic-1",
      chatId: "chat-1",
    });
    expect(
      tool && "assistantImageContext" in tool
        ? // tool segments must not carry assistant image context
          (tool as { assistantImageContext?: unknown }).assistantImageContext
        : undefined,
    ).toBeUndefined();
  });
});
