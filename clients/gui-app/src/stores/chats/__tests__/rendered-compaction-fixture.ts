import { renderHook } from "@testing-library/react";
import type {
  AgentSender,
  ContentBlock,
  Message,
} from "@traycer/protocol/persistence/epic/schemas";
import { contentBlockSchema } from "@traycer/protocol/persistence/epic/content-blocks";
import {
  useRenderedMessages,
  type RenderedMessagesDisplayContext,
  type RenderedMessagesInput,
} from "@/stores/chats/rendered-messages";
import type {
  ChatMessage as ChatMessageModel,
  MessageSegment,
} from "@/stores/composer/chat-store";

/**
 * A persisted compaction block decoded by the live block schema and carried
 * through the real rendered-message mapper, for the suites that assert what
 * the `notApplied` outcome becomes on each presentation surface.
 */

export const REFUSED_COMPACTION_ERROR =
  "Copilot did not apply this compaction.";

const ASSISTANT_SENDER: AgentSender = {
  type: "agent",
  harnessId: "copilot",
  agentId: "copilot-agent",
  displayName: "Copilot",
  reply: { expectsReply: false },
  inReplyTo: null,
};

const DISPLAY_CONTEXT: RenderedMessagesDisplayContext = {
  resolveUserSenderLabel: () => "You",
  resolveUserSenderAvatarUrl: () => null,
  resolveAgentSenderDisplay: () => ({
    senderLabel: "Copilot",
    providerLabel: "GitHub Copilot",
    modelLabel: null,
  }),
  resolveAgentReasoningLabel: () => null,
  resolveAgentServiceTierLabel: () => null,
  contentBlocksPreview: () => "",
};

const CANONICAL_INPUT: RenderedMessagesInput = {
  messages: [],
  events: [],
  rowContext: {},
  pendingUserMessages: [],
  withdrawnMessageId: null,
  liveAssistantMessage: null,
  activeTurn: null,
  runStatus: "idle",
  setupCardWindows: [],
  epicId: "epic-1",
  ownerId: "chat-1",
  ownerKind: "chat",
  viewTabId: "tab-1",
};

/** What a persisted compaction block looks like before the live decode. */
export function persistedCompaction(
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  return {
    blockId: "compaction-1",
    status: "errored",
    timestamp: 3000,
    type: "compaction",
    trigger: "manual",
    preTokens: null,
    postTokens: null,
    durationMs: null,
    summary: null,
    error: REFUSED_COMPACTION_ERROR,
    ...overrides,
  };
}

function assistantWith(block: ContentBlock): Message {
  return {
    role: "assistant",
    messageId: "turn-1",
    sender: ASSISTANT_SENDER,
    blocks: [block],
    startedAt: 2000,
    timestamp: 2000,
    turnId: "turn-1",
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
    envCredentialVar: null,
    imageResolutions: [],
  };
}

/** The rendered messages for one assistant row holding the decoded block. */
export function renderedCompactionMessages(
  persisted: Record<string, unknown>,
): ReadonlyArray<ChatMessageModel> {
  const block = contentBlockSchema.parse(persisted);
  const { result } = renderHook(
    ({ value }: { value: RenderedMessagesInput }) =>
      useRenderedMessages(value, DISPLAY_CONTEXT),
    {
      initialProps: {
        value: { ...CANONICAL_INPUT, messages: [assistantWith(block)] },
      },
    },
  );
  return result.current;
}

export type CompactionSegmentValue = Extract<
  MessageSegment,
  { kind: "compaction" }
>;

export function mappedCompactionSegment(
  persisted: Record<string, unknown>,
): CompactionSegmentValue {
  const segment = renderedCompactionMessages(persisted)[0]?.segments.find(
    (candidate): candidate is CompactionSegmentValue =>
      candidate.kind === "compaction",
  );
  if (segment === undefined) throw new Error("expected a compaction segment");
  return segment;
}
