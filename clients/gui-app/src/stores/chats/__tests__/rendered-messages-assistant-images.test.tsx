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
  contentBlocksPreview: () => "",
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
    managedCommand: null,
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

function textSegmentContexts(
  segments: ReadonlyArray<MessageSegment>,
): ReadonlyArray<
  NonNullable<
    Extract<MessageSegment, { kind: "text" }>["assistantImageContext"]
  >
> {
  return segments.flatMap((segment) =>
    segment.kind === "text" && segment.assistantImageContext !== undefined
      ? [segment.assistantImageContext]
      : [],
  );
}

describe("useRenderedMessages assistant image echo dedup", () => {
  it("projects source -> {toolBlockId,rowId} when resolution hash matches imageResults", () => {
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
    expect(context?.deduplicatedTargetsBySource.get(source)).toEqual({
      toolBlockId: "tool-img-1",
      rowId: "assistant:turn-img-hash",
    });
  });

  it("deduplicates an image generation owned by a subagent", () => {
    const source = "/generated/subagent-cat.png";
    const hash = "hash-subagent-cat";
    const parentedTool = {
      ...toolCallWithImages({
        blockId: "tool-img-subagent",
        timestamp: 2001,
        imageResults: [imageResult({ attachmentHash: hash })],
      }),
      parentBlockId: "agent-1",
    } satisfies ContentBlock;
    const assistant: Message = {
      ...assistantMessage("turn-img-subagent", 2000),
      blocks: [parentedTool, textBlock("text-1", 2002, `![cat](${source})`)],
      imageResolutions: [resolvedEntry(source, hash, {})],
    };

    const { result } = renderRenderedMessages({ messages: [assistant] });
    const context = textSegmentContext(result.current[0]?.segments ?? []);
    expect(context?.deduplicatedTargetsBySource.get(source)).toEqual({
      toolBlockId: "tool-img-subagent",
      rowId: "assistant:turn-img-subagent",
    });
  });

  it("does not deduplicate matching paths when the resolved hashes differ", () => {
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
    expect(context?.deduplicatedTargetsBySource.has(authored)).toBe(false);
    expect(context?.deduplicatedTargetsBySource.has(canonical)).toBe(false);
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
    expect(pendingContext?.deduplicatedTargetsBySource.has(source)).toBe(false);

    const committed: Message = {
      ...pending,
      // Fresh array identity so the turn signature invalidates.
      imageResolutions: [resolvedEntry(source, hash, {})],
    };
    driver.patch({ messages: [committed] });

    const committedContext = textSegmentContext(
      driver.result.current[0]?.segments ?? [],
    );
    expect(committedContext?.deduplicatedTargetsBySource.get(source)).toEqual({
      toolBlockId: "tool-img-1",
      rowId: "assistant:turn-img-pending",
    });
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
    expect(context?.deduplicatedTargetsBySource.size ?? -1).toBe(0);
  });

  it("pins toolBlockId to the pre-steer row when the echo lives after a steer split", () => {
    // tool_call before steer, prose echo after: virtualized rows diverge, so
    // the projected rowId must name the card's slice (part:0), not the echo's.
    const source = "/generated/steered.png";
    const hash = "hash-steered-1";
    const content = {
      type: "doc" as const,
      content: [
        {
          type: "paragraph" as const,
          content: [{ type: "text" as const, text: "steer follow-up" }],
        },
      ],
    };
    const assistant: Message = {
      ...assistantMessage("turn-img-steer-split", 2000),
      blocks: [
        toolCallWithImages({
          blockId: "tool-img-pre-steer",
          timestamp: 2001,
          imageResults: [imageResult({ attachmentHash: hash, filePath: null })],
        }),
        {
          type: "steer",
          blockId: "steer:queue-img",
          status: "completed",
          timestamp: 2002,
          queueItemId: "queue-img",
          messageId: "message-queue-img",
          mode: "safe_point",
          sender: null,
          content,
        },
        textBlock("text-post-steer", 2003, `![steered](${source})`),
      ],
      imageResolutions: [resolvedEntry(source, hash, {})],
    };
    const steered: Message = {
      ...userMessage("message-queue-img"),
      message: { kind: "user", content },
      timestamp: 2002,
    };

    const { result } = renderRenderedMessages({
      messages: [assistant, steered],
    });

    expect(result.current.map((message) => message.role)).toEqual([
      "assistant",
      "user",
      "assistant",
    ]);
    // Pre-steer assistant slice owns the generation card.
    expect(result.current[0]?.id).toBe("assistant:turn-img-steer-split:part:0");
    // Post-steer echo slice is a different virtualized row.
    expect(result.current[2]?.id).toBe("assistant:turn-img-steer-split:part:1");

    const echoContext = textSegmentContext(result.current[2]?.segments ?? []);
    expect(echoContext).not.toBeNull();
    expect(echoContext?.deduplicatedTargetsBySource.get(source)).toEqual({
      toolBlockId: "tool-img-pre-steer",
      // Target row is the card's pre-steer slice, not the echo slice.
      rowId: "assistant:turn-img-steer-split:part:0",
    });
  });
});

describe("useRenderedMessages image resolution stable-row identity", () => {
  it("keeps same-source resolutions scoped to their owning message", () => {
    const source = "/workspace/shared.png";
    const first: Message = {
      ...assistantMessage("turn-shared", 2000),
      messageId: "assistant-first",
      blocks: [textBlock("text-first", 2001, `![first](${source})`)],
      imageResolutions: [resolvedEntry(source, "hash-first", {})],
    };
    const second: Message = {
      ...assistantMessage("turn-shared", 3000),
      messageId: "assistant-second",
      blocks: [textBlock("text-second", 3001, `![second](${source})`)],
      imageResolutions: [resolvedEntry(source, "hash-second", {})],
    };

    const { result } = renderRenderedMessages({ messages: [first, second] });
    const contexts = textSegmentContexts(result.current[0]?.segments ?? []);
    expect(contexts).toHaveLength(2);
    expect(contexts[0]?.resolutions[0]).toMatchObject({
      messageId: "assistant-first",
      entry: { attachmentHash: "hash-first" },
    });
    expect(contexts[1]?.resolutions[0]).toMatchObject({
      messageId: "assistant-second",
      entry: { attachmentHash: "hash-second" },
    });
  });

  it("threads buffered resolutions onto an ordinary standalone live row", () => {
    const source = "C:%5Cwork%5Cchart.png";
    const entry = resolvedEntry(source, "hash-live", {
      canonicalSource: "C:\\work\\chart.png",
    });
    const live = {
      turnId: "turn-live",
      sender: ASSISTANT_SENDER,
      blocks: [textBlock("text-live", 2001, `![chart](${source})`)],
      startedAt: 2000,
      blocksVersion: 1,
      imageResolutions: [
        {
          messageId: "assistant-live",
          entry,
        },
      ],
      imageResolutionsVersion: 1,
      timestamp: 2001,
      reasoningEffort: null,
      serviceTier: null,
    };
    const driver = renderRenderedMessages({
      liveAssistantMessage: live,
      runStatus: "running",
    });

    const context = textSegmentContext(
      driver.result.current[0]?.segments ?? [],
    );
    expect(context?.resolutions).toEqual([
      { messageId: "assistant-live", entry },
    ]);

    driver.patch({
      liveAssistantMessage: {
        ...live,
        blocks: [
          ...live.blocks,
          textBlock("text-live-future", 2002, `again ![chart](${source})`),
        ],
        blocksVersion: 2,
        imageResolutions: [
          {
            ...live.imageResolutions[0],
            entry: { ...entry, attachmentHash: "hash-live-updated" },
          },
        ],
        imageResolutionsVersion: 2,
      },
    });
    const updated = textSegmentContexts(
      driver.result.current[0]?.segments ?? [],
    );
    expect(
      updated.map((context) => context.resolutions[0]?.entry.attachmentHash),
    ).toEqual(["hash-live-updated", "hash-live-updated"]);
  });

  it("scopes merged live resolutions to the latest assistant message", () => {
    const source = "/workspace/shared-live.png";
    const first: Message = {
      ...assistantMessage("turn-live-shared", 2000),
      messageId: "assistant-first",
      blocks: [textBlock("text-first", 2001, `![first](${source})`)],
      imageResolutions: [resolvedEntry(source, "hash-first", {})],
    };
    const second: Message = {
      ...assistantMessage("turn-live-shared", 3000),
      messageId: "assistant-second",
      blocks: [textBlock("text-second", 3001, `![second](${source})`)],
      imageResolutions: [resolvedEntry(source, "hash-second", {})],
    };
    const live = {
      turnId: "turn-live-shared",
      sender: ASSISTANT_SENDER,
      blocks: [textBlock("text-live", 4001, `![live](${source})`)],
      startedAt: 2000,
      blocksVersion: 1,
      imageResolutions: [
        {
          messageId: "assistant-first",
          entry: resolvedEntry(source, "hash-first-live", {}),
        },
        {
          messageId: "assistant-second",
          entry: resolvedEntry(source, "hash-second-live", {}),
        },
      ],
      imageResolutionsVersion: 1,
      timestamp: 4001,
      reasoningEffort: null,
      serviceTier: null,
    };

    const { result } = renderRenderedMessages({
      messages: [first, second],
      liveAssistantMessage: live,
      runStatus: "running",
    });
    const contexts = textSegmentContexts(result.current[0]?.segments ?? []);
    expect(contexts.at(-1)?.resolutions).toEqual([
      {
        messageId: "assistant-second",
        entry: resolvedEntry(source, "hash-second-live", {}),
      },
    ]);
  });

  it("uses the live block owner while its persisted row still points to the prior message", () => {
    const source = "/workspace/live-owner.png";
    const first: Message = {
      ...assistantMessage("turn-live-owner", 2000),
      messageId: "assistant-first",
      blocks: [textBlock("text-first", 2001, `![first](${source})`)],
      imageResolutions: [],
    };
    const live = {
      turnId: "turn-live-owner",
      sender: ASSISTANT_SENDER,
      blocks: [textBlock("text-live", 3001, `![live](${source})`)],
      startedAt: 2000,
      blocksVersion: 1,
      imageResolutions: [
        {
          messageId: "assistant-second",
          entry: resolvedEntry(source, "hash-second-live", {}),
        },
      ],
      imageResolutionOwnerMessageId: "assistant-second",
      imageResolutionsVersion: 1,
      timestamp: 3001,
      reasoningEffort: null,
      serviceTier: null,
    };

    const { result } = renderRenderedMessages({
      messages: [first],
      liveAssistantMessage: live,
      runStatus: "running",
    });

    const context = textSegmentContexts(result.current[0]?.segments ?? []).at(
      -1,
    );
    expect(context?.resolutions).toEqual([
      {
        messageId: "assistant-second",
        entry: resolvedEntry(source, "hash-second-live", {}),
      },
    ]);
  });

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
