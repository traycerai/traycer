import {
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import type { TokenUsage } from "@traycer/protocol/persistence/epic/foundation";
import { domAnimation, LazyMotion } from "motion/react";
import { AssistantMessageBody } from "@/components/chat/chat-message-assistant-body";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import { ContextUsageChip } from "@/components/chat/context-usage-chip";
import {
  buildContextUsageRows,
  computeEffectiveContextUsage,
  formatContextUsageRowValue,
} from "@/components/chat/context-usage";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { RenderedMessagesDisplayContext } from "@/stores/chats/rendered-messages";
import { useRenderedMessages } from "@/stores/chats/rendered-messages";
import {
  createChatSessionStore,
  type ChatSessionState,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { selectContextUsage } from "@/components/epic-canvas/renderers/chat-tile-session-state";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";

const EPIC_ID = "epic-reasonix-usage";
const CHAT_ID = "chat-reasonix-usage";
const OWNER_ID = "owner-reasonix-usage";

// These values are the host's U2 / M1 row. Keep them literal on the OSS side:
// the paired host manager suite asserts the same durable shape.
const M1_USAGE: TokenUsage = {
  inputTokens: 25_000,
  outputTokens: 700,
  totalTokens: 25_700,
  contextTokens: 41_200,
  contextWindow: 128_000,
  costUsd: 0.012,
};
const M4_USAGE: TokenUsage = {
  inputTokens: 25_000,
  outputTokens: 700,
  totalTokens: 25_700,
  costUsd: 0.012,
};
const M5_USAGE: TokenUsage = M4_USAGE;
const M6_ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  contextTokens: 1_200,
  contextWindow: 128_000,
};
const SUBSCRIPTION_USAGE: TokenUsage = {
  inputTokens: 25_000,
  outputTokens: 700,
  totalTokens: 25_700,
  contextTokens: 41_200,
  contextWindow: 128_000,
};

const DISPLAY_CONTEXT: RenderedMessagesDisplayContext = {
  resolveUserSenderLabel: () => "You",
  resolveUserSenderAvatarUrl: () => null,
  resolveAgentSenderDisplay: () => ({
    senderLabel: "Reasonix",
    providerLabel: "Reasonix",
    modelLabel: null,
  }),
  resolveAgentReasoningLabel: (_sender, effort) =>
    effort === null ? null : `Resolved ${effort}`,
  resolveAgentServiceTierLabel: (_sender, tier) =>
    tier === null ? null : `Resolved ${tier}`,
  contentBlocksPreview: () => "",
};

function assistantMessage(
  messageId: string,
  usage: TokenUsage | null,
  timestamp: number,
): Extract<Message, { role: "assistant" }> {
  return {
    role: "assistant",
    messageId,
    sender: {
      type: "agent",
      harnessId: "reasonix",
      agentId: "reasonix/model",
      displayName: "Reasonix",
      reply: { expectsReply: false },
      inReplyTo: null,
    },
    blocks: [],
    startedAt: timestamp,
    timestamp,
    turnId: messageId,
    usage,
    reasoningEffort: null,
    serviceTier: null,
    envCredentialVar: null,
    imageResolutions: [],
  };
}

function selectFromRows(messages: readonly Message[]): TokenUsage | null {
  const state: Pick<
    ChatSessionState,
    "liveTurnUsage" | "messages" | "transcriptDerived"
  > = {
    liveTurnUsage: null,
    messages,
    transcriptDerived: null,
  };
  return selectContextUsage(state);
}

function renderChip(usage: TokenUsage | null) {
  return render(
    <TooltipProvider delayDuration={0}>
      <LazyMotion features={domAnimation}>
        <ContextUsageChip usage={usage} onCompact={null} />
      </LazyMotion>
    </TooltipProvider>,
  );
}

function bodyProps(meta: Parameters<typeof AssistantMessageBody>[0]["meta"]) {
  return {
    segments: [
      {
        id: "reasonix-reply",
        kind: "text" as const,
        markdown: "Here is the answer.",
        isStreaming: false,
      },
    ],
    backgroundToolBlockIds: new Set<string>(),
    runState: null,
    messageId: "assistant:reasonix-turn",
    elapsedStartedAt: 1_000,
    turnHasOnlyAutonomousResumeSegments: false,
    autonomousResumeOwed: false,
    showCompletionFooter: true,
    pausedDurationMs: 0,
    pausedSinceMs: null,
    completedAt: 2_000,
    stopped: null,
    meta,
    turnId: null,
    manualRungAnchorId: null,
    routingSettledNoticeId: null,
    nextStepActions: null,
    forkAction: null,
    interviewDeliveryRetry: null,
  };
}

function renderAssistantBody(
  meta: Parameters<typeof AssistantMessageBody>[0]["meta"],
) {
  return render(
    <TooltipProvider delayDuration={0}>
      <ChatExpansionTestProviders tileInstanceId="reasonix-usage-test">
        <AssistantMessageBody {...bodyProps(meta)} />
      </ChatExpansionTestProviders>
    </TooltipProvider>,
  );
}

function resetLayout(): void {
  window.localStorage.clear();
  useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
}

beforeEach(resetLayout);
afterEach(() => {
  cleanup();
  resetLayout();
});

describe("Reasonix usage consumers", () => {
  it("C1: the chat store carries live usage across a stopped terminal", () => {
    const callbackSlot: { current: ChatStreamCallbacks | null } = {
      current: null,
    };
    const handle = createChatSessionStore({
      environment: CHAT_STORE_TEST_ENVIRONMENT,
      hostId: "host-reasonix-usage",
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      userId: OWNER_ID,
      onAuthError: null,
      onProviderAuthError: null,
      wakeTransport: null,
      streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
      streamClientFactory: (_epicId, _chatId, nextCallbacks) => {
        callbackSlot.current = nextCallbacks;
        return {
          sendAction: vi.fn(),
          sameTurnSteeringProtocolSupported: () => true,
          draftBlobBridgeSupported: () => true,
          requestTranscriptRange: vi.fn(),
          requestResnapshot: vi.fn(),
          close: vi.fn(),
        };
      },
    });
    const callbacks = callbackSlot.current;
    if (callbacks === null)
      throw new Error("chat store did not create callbacks");

    try {
      callbacks.onTurnStateChanged({
        kind: "turnStateChanged",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        runStatus: "running",
        activeTurn: {
          agentMode: "regular",
          sameTurnSteeringSupported: false,
          turnId: "turn-stop",
          status: "running",
          harnessId: "reasonix",
          model: "reasonix/model",
          profileId: null,
          userMessageId: "message-stop",
          startedAt: 2_001,
          updatedAt: 2_001,
          reasoningEffort: null,
          serviceTier: null,
        },
      });
      callbacks.onBlockDelta({
        kind: "blockDelta",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        event: {
          type: "tool_call.started",
          blockId: "tool-stop-in-flight",
          timestamp: 2_002,
          toolName: "read_file",
          input: {},
          agentMessageSend: null,
        },
      });
      callbacks.onBlockDelta({
        kind: "blockDelta",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        event: {
          type: "usage.updated",
          blockId: "turn-stop",
          timestamp: 2_003,
          turnId: "turn-stop",
          usage: M1_USAGE,
        },
      });
      expect(handle.store.getState().liveTurnUsage).toEqual(M1_USAGE);
      expect(
        handle.store.getState().liveAssistantMessage?.blocks[0]?.status,
      ).toBe("streaming");

      callbacks.onBlockDelta({
        kind: "blockDelta",
        hasBinaryPayload: false,
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        event: {
          type: "turn.stopped",
          blockId: "turn-stop",
          timestamp: 2_004,
          turnId: "turn-stop",
          reason: "cancelled",
        },
      });
      const stoppedState = handle.store.getState();
      expect(stoppedState.liveAssistantMessage?.blocks[0]?.status).toBe(
        "interrupted",
      );
      expect(stoppedState.liveTurnUsage).toEqual(M1_USAGE);
    } finally {
      handle.dispose();
    }
  });

  it("C2: M1 selects and draws the 41,200 / 128,000 window usage", () => {
    const selected = selectFromRows([assistantMessage("m1", M1_USAGE, 2_000)]);
    expect(selected).toEqual(M1_USAGE);
    const effective = computeEffectiveContextUsage(selected);
    expect(effective).toEqual({
      used: 41_200,
      window: 128_000,
      percentLeft: 68,
    });
    if (effective === null) throw new Error("M1 context usage was absent");
    const rows = buildContextUsageRows(M1_USAGE, effective);
    expect(rows).toEqual([
      { key: "used", label: "Used", value: 41_200, total: 128_000 },
      { key: "output", label: "Output", value: 700, total: null },
    ]);
    expect(formatContextUsageRowValue(rows[0])).toBe("41K / 128K");

    renderChip(selected);
    expect(
      screen.getByRole("button", { name: /Context window 68% left/ }),
    ).toBeTruthy();
  });

  it("C3: hides the chip for M4's 1.39.7 row", () => {
    const selected = selectFromRows([
      assistantMessage("legacy", M4_USAGE, 2_000),
    ]);
    expect(selected).toEqual(M4_USAGE);
    renderChip(selected);
    expect(screen.queryByRole("button", { name: /Context window/ })).toBeNull();
  });

  it("C4: the newest M5 tokens-only row replaces the previous window gauge", () => {
    const selected = selectFromRows([
      assistantMessage("previous-m1", M1_USAGE, 2_000),
      assistantMessage("newest-m5", M5_USAGE, 3_000),
    ]);
    expect(selected).toEqual(M5_USAGE);
    renderChip(selected);
    expect(screen.queryByRole("button", { name: /Context window/ })).toBeNull();
  });

  it.each([
    ["M1 payg", M1_USAGE, 0.012],
    ["U4 subscription quote", SUBSCRIPTION_USAGE, null],
  ] as const)(
    "C5/C6: carries %s cost into rendered assistant metadata and its tooltip",
    async (_name, usage, expectedCost) => {
      const assistant = assistantMessage("reasonix-cost", usage, 2_000);
      const input = {
        messages: [assistant],
        events: [],
        rowContext: {},
        pendingUserMessages: [],
        withdrawnMessageId: null,
        liveAssistantMessage: null,
        activeTurn: null,
        runStatus: "idle" as const,
        setupCardWindows: [],
        epicId: EPIC_ID,
        ownerId: OWNER_ID,
        ownerKind: "chat" as const,
        viewTabId: "reasonix-usage-tab",
      };
      const { result } = renderHook(() =>
        useRenderedMessages(input, DISPLAY_CONTEXT),
      );
      const rendered = result.current.find(
        (message) => message.role === "assistant",
      );
      expect(rendered?.assistantMeta?.costUsd ?? null).toBe(expectedCost);

      renderAssistantBody(rendered?.assistantMeta ?? null);
      await userEvent
        .setup()
        .hover(screen.getByTestId("assistant-elapsed-footer"));
      if (expectedCost === null) {
        await waitFor(() => expect(screen.getByText("Provider")).toBeTruthy());
        expect(screen.queryByText("Cost")).toBeNull();
      } else {
        expect(await screen.findByText("Cost")).toBeTruthy();
        expect(screen.getByText("$0.0120")).toBeTruthy();
      }
    },
  );

  it("C7: keeps M1 through an absent newest row, while real zero plus gauge replaces it", () => {
    const absent = selectFromRows([
      assistantMessage("m1-before-absence", M1_USAGE, 2_000),
      assistantMessage("m6a-no-usage", null, 3_000),
    ]);
    expect(absent).toEqual(M1_USAGE);
    renderChip(absent);
    expect(
      screen.getByRole("button", { name: /Context window 68% left/ }),
    ).toBeTruthy();

    cleanup();
    const zero = selectFromRows([
      assistantMessage("m1-before-zero", M1_USAGE, 2_000),
      assistantMessage("m6b-zero", M6_ZERO_USAGE, 3_000),
    ]);
    expect(zero).toEqual(M6_ZERO_USAGE);
    const effective = computeEffectiveContextUsage(zero);
    expect(effective).toEqual({
      used: 1_200,
      window: 128_000,
      percentLeft: 99,
    });
    if (effective === null) throw new Error("M6 context usage was absent");
    renderChip(zero);
    expect(
      screen.getByRole("button", { name: /Context window 99% left/ }),
    ).toBeTruthy();
  });
});
