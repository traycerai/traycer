import { cleanup, render, screen } from "@testing-library/react";
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type {
  AgentSender,
  Message,
} from "@traycer/protocol/persistence/epic/schemas";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { LastFailedAttempt } from "@traycer/protocol/host/agent/gui/subscribe";
import {
  useRenderedMessages,
  type RenderedMessagesDisplayContext,
  type RenderedMessagesInput,
} from "@/stores/chats/rendered-messages";
import { ChatMessage } from "@/components/chat/chat-message";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import { ChatTranscriptProvider } from "@/components/chat/chat-transcript-context";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * F11 - the review's finding. `withManualRungAnchor` (`rendered-messages.ts`)
 * resolves `manualRungAnchorSegmentId` over the WHOLE turn's segments, so a
 * turn that fails, gets steered, and only then reaches its real terminal error
 * still gets ONE recovery group rather than one per split row. Nothing
 * exercised a turn that actually splits before this file.
 *
 * "Over the whole turn" is a claim about the INPUT, not about running before
 * the split - an earlier version of this comment said the latter and was
 * wrong. `planAssistantTurnRows` splits first and the rows are built;
 * `withManualRungAnchor` then runs last, after the completion and run-state
 * passes, and rebuilds the ordered whole-turn segment list from those finished
 * rows with `assistantTurnSegments`. That ordering is why the first assertion
 * below is `assistantRows.length === 2`: the split has already happened by the
 * time the anchor is chosen, so a fixture that failed to split would let this
 * file pass while measuring the unsplit case it was written to exclude.
 */

const EPIC_ID = "epic-anchor";
const CHAT_ID = "chat-anchor";
const HOST_ID = "host-anchor";

const CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "steer" }] }],
};

const ASSISTANT_SENDER: AgentSender = {
  type: "agent",
  harnessId: "claude",
  agentId: "claude-sonnet-4",
  displayName: "Claude Sonnet 4",
  reply: { expectsReply: false },
  inReplyTo: null,
};

const BINDING = {
  epicId: EPIC_ID,
  ownerId: "owner-1",
  ownerKind: "chat" as const,
  viewTabId: "tab-1",
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
    envCredentialVar: null,
    imageResolutions: [],
  };
}

type AssistantBlock = Extract<Message, { role: "assistant" }>["blocks"][number];

function nonTerminalErrorBlock(
  blockId: string,
  timestamp: number,
): AssistantBlock {
  return {
    type: "error",
    blockId,
    status: "completed",
    timestamp,
    message: "A provider extension raised a warning.",
    recoverable: true,
    code: "extension_warning",
    failure: null,
  };
}

function terminalErrorBlock(
  blockId: string,
  timestamp: number,
): AssistantBlock {
  return {
    type: "error",
    blockId,
    status: "completed",
    timestamp,
    message: "Rate limited.",
    recoverable: true,
    code: null,
    failure: { reason: "rate_limit" },
  };
}

function queuePausedBlock(blockId: string, timestamp: number): AssistantBlock {
  return {
    type: "error",
    blockId,
    status: "completed",
    timestamp,
    message: "2 queued messages were held. Resume the queue to send them.",
    recoverable: false,
    code: "QUEUE_PAUSED_AFTER_ERROR",
    failure: null,
  };
}

function steerBlock(
  blockId: string,
  messageId: string,
  timestamp: number,
): AssistantBlock {
  return {
    type: "steer",
    blockId,
    status: "completed",
    timestamp,
    queueItemId: `queue:${blockId}`,
    messageId,
    content: CONTENT,
    mode: "safe_point",
    sender: null,
  };
}

function renderRenderedMessages(patch: Partial<RenderedMessagesInput>) {
  const value: RenderedMessagesInput = {
    messages: [],
    events: [],
    rowContext: {},
    pendingUserMessages: [],
    liveAssistantMessage: null,
    activeTurn: null,
    runStatus: "idle",
    setupCardWindows: [],
    ...BINDING,
    ...patch,
  };
  return renderHook(
    ({ current }: { current: RenderedMessagesInput }) =>
      useRenderedMessages(current, displayContext),
    { initialProps: { current: value } },
  );
}

describe("F11: manualRungAnchorId over a turn that splits", () => {
  it("names exactly one anchor - the row holding the TERMINAL error - never the pre-steer row or the queue-paused block", () => {
    const assistant = {
      ...assistantMessage("turn-split", 2000),
      blocks: [
        nonTerminalErrorBlock("err-pre", 2001),
        steerBlock("steer-1", "steer-msg-1", 2002),
        terminalErrorBlock("err-terminal", 2003),
        queuePausedBlock("err-queue-paused", 2004),
      ],
    };
    const { result } = renderRenderedMessages({ messages: [assistant] });
    const assistantRows = result.current.filter(
      (row) => row.role === "assistant",
    );
    // Precondition: the fixture actually SPLIT. Without this, "one row
    // carries the anchor" could just mean the turn never split at all.
    expect(assistantRows).toHaveLength(2);

    // Read WITHOUT `?.` deliberately, and not only to satisfy the linter:
    // `toHaveLength(2)` above has already failed the test if either row is
    // missing, so the chain could never short-circuit - and on the first
    // assertion it was actively harmful, because `undefined?.x` is `undefined`
    // and would have satisfied `.toBeUndefined()` vacuously for a row that did
    // not exist. Dropping it converts that silent pass into a failure.
    const [preSteerRow, postSteerRow] = assistantRows;
    expect(preSteerRow.manualRungAnchorId).toBeUndefined();
    expect(postSteerRow.manualRungAnchorId).toBe("err-terminal");
    expect(postSteerRow.manualRungAnchorId).not.toBe("err-queue-paused");

    const anchored = assistantRows.filter(
      (row) => row.manualRungAnchorId !== undefined,
    );
    expect(anchored).toHaveLength(1);
  });

  // POSITIVE CONTROL for the fixture above: the SAME turn, steer removed,
  // still produces exactly one anchor on the terminal error. Without this,
  // "one anchor" in the split case could also be what a fixture that failed
  // to actually split gives you by accident.
  it("positive control: the same turn with no steer still names exactly one anchor, on the terminal error", () => {
    const assistant = {
      ...assistantMessage("turn-unsplit", 2000),
      blocks: [
        nonTerminalErrorBlock("err-pre-u", 2001),
        terminalErrorBlock("err-terminal-u", 2002),
        queuePausedBlock("err-queue-paused-u", 2003),
      ],
    };
    const { result } = renderRenderedMessages({ messages: [assistant] });
    const assistantRows = result.current.filter(
      (row) => row.role === "assistant",
    );
    expect(assistantRows).toHaveLength(1);
    // Same reasoning as the split case: guarded by the length assertion above,
    // and `noUncheckedIndexedAccess` is off in this workspace, so the index
    // read is already typed non-nullish.
    expect(assistantRows[0].manualRungAnchorId).toBe("err-terminal-u");
  });
});

// ---------------------------------------------------------------------------
// The render-through-ChatMessage half: the same split turn, mounted for real,
// counted by its VISIBLE recovery groups rather than by the projected field.

const harnessStore = vi.hoisted(() => ({
  lastFailedAttempt: undefined as LastFailedAttempt | undefined,
}));

vi.mock("@/lib/registries/chat-session-registry", () => ({
  useExistingChatSessionHandle: () => ({
    store: {
      getState: () => ({
        lastFailedAttempt: harnessStore.lastFailedAttempt,
        publishConfirmedManualFallbackAction: () => undefined,
      }),
      getInitialState: () => ({
        lastFailedAttempt: harnessStore.lastFailedAttempt,
        publishConfirmedManualFallbackAction: () => undefined,
      }),
      subscribe: () => () => undefined,
    },
  }),
}));

vi.mock("@/providers/use-open-epic-handle", () => ({
  useMaybeOpenEpicHandle: () => ({ epicId: EPIC_ID }),
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));

vi.mock("@/hooks/host/use-host-scoped-mutation", () => ({
  useHostScopedMutationForClient: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}));

vi.mock("@/components/chat/fallback/open-fallback-settings", () => ({
  useOpenFallbackSettings: () => () => undefined,
}));

function renderMounted(ui: ReactNode) {
  return render(
    <TooltipProvider delayDuration={0}>
      <TabHostProvider hostId={HOST_ID}>
        <ChatTranscriptProvider value={{ chatId: CHAT_ID, hostId: HOST_ID }}>
          <ChatExpansionTestProviders tileInstanceId="manual-rung-anchor-tile">
            {ui}
          </ChatExpansionTestProviders>
        </ChatTranscriptProvider>
      </TabHostProvider>
    </TooltipProvider>,
  );
}

describe("F11: exactly one recovery group reaches the document for a split turn", () => {
  afterEach(() => {
    cleanup();
    harnessStore.lastFailedAttempt = undefined;
  });

  it("renders Retry exactly once, on the row containing the terminal error", () => {
    harnessStore.lastFailedAttempt = {
      userMessageId: "user-split",
      turnId: "turn-split",
      failure: { reason: "rate_limit" },
      eligibleRungs: ["retry"],
      waitDisposition: "no_verified_reset",
      // This suite is about WHICH ROW the affordances anchor to, never about
      // which of them the host admits. `unknown` is the value that claims
      // nothing and renders no explanatory sentence, so it keeps the rendered
      // output here exactly what these assertions were written against.
      switchDisposition: "unknown",
      failedTuple: null,
    };
    const assistant = {
      ...assistantMessage("turn-split", 2000),
      blocks: [
        nonTerminalErrorBlock("err-pre", 2001),
        steerBlock("steer-1", "steer-msg-1", 2002),
        terminalErrorBlock("err-terminal", 2003),
        queuePausedBlock("err-queue-paused", 2004),
      ],
    };
    const { result } = renderRenderedMessages({ messages: [assistant] });
    const assistantRows = result.current.filter(
      (row) => row.role === "assistant",
    );
    expect(assistantRows).toHaveLength(2);

    renderMounted(
      <>
        {assistantRows.map((row) => (
          <ChatMessage
            key={row.id}
            message={row}
            actions={null}
            backgroundToolBlockIds={new Set()}
            nextStepActions={null}
          />
        ))}
      </>,
    );

    // Falsification (the review's own finding): change `withManualRungAnchor`
    // to stamp `manualRungAnchorSegmentId(row.segments)` on EACH assistant row
    // instead of resolving over `assistantTurnSegments(rows)` first. Predicted:
    // TWO rows carry an anchor (the pre-steer row picks its own last
    // candidate, `err-pre`), and this becomes `toHaveLength(2)`. If it does
    // NOT redden, the fixture above did not actually split - re-check
    // `assistantRows.length` before trusting this arm.
    expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(1);
  });
});
