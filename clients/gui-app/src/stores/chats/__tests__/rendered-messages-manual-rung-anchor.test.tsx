import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type {
  AgentSender,
  Message,
} from "@traycer/protocol/persistence/epic/schemas";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { LastFailedAttempt } from "@traycer/protocol/host/agent/gui/subscribe";
import type { ProviderNoticeReceipt } from "@traycer/protocol/persistence/epic/content-blocks";
import { QUEUE_PAUSED_AFTER_ERROR_CODE } from "@traycer/protocol/host/agent/gui/agent-runtime";
import {
  useRenderedMessages,
  type RenderedMessagesDisplayContext,
  type RenderedMessagesInput,
} from "@/stores/chats/rendered-messages";
import { ChatMessage } from "@/components/chat/chat-message";
import { chatFindSegmentUnitId } from "@/components/chat/chat-find-projection";
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

function terminalErrorBlockSaying(
  blockId: string,
  timestamp: number,
  message: string,
): AssistantBlock {
  return {
    type: "error",
    blockId,
    status: "completed",
    timestamp,
    message,
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
    code: QUEUE_PAUSED_AFTER_ERROR_CODE,
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
    withdrawnMessageId: null,
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

  // F11 (review): every case above also carries a terminal `err-terminal*`
  // block, so `lastWithFailure` always wins and the QUEUE_PAUSED_AFTER_ERROR_CODE
  // skip in `manualRungAnchorSegmentId` could be deleted without turning any
  // of them red. This case removes the terminal failure entirely, so
  // `lastWithFailure` stays null and `lastCandidate` is what decides - the
  // only path where that skip actually matters.
  it("falls back to the last non-queue-paused candidate when nothing in the turn carries a typed failure", () => {
    const assistant = {
      ...assistantMessage("turn-no-failure", 2000),
      blocks: [
        nonTerminalErrorBlock("err-pre-only", 2001),
        queuePausedBlock("err-queue-paused-only", 2002),
      ],
    };
    const { result } = renderRenderedMessages({ messages: [assistant] });
    const assistantRows = result.current.filter(
      (row) => row.role === "assistant",
    );
    expect(assistantRows).toHaveLength(1);
    // Same reasoning as the positive control above: guarded by the length
    // assertion, and `noUncheckedIndexedAccess` is off in this workspace.
    //
    // Falsification (the review's own finding): delete the
    // `if (segment.code === QUEUE_PAUSED_AFTER_ERROR_CODE) continue;` guard in
    // `manualRungAnchorSegmentId` and this must go red - with the guard gone,
    // the queue-paused block becomes eligible as `lastCandidate` too, and
    // being LAST in iteration order it would win, landing the anchor on
    // "err-queue-paused-only" instead.
    expect(assistantRows[0].manualRungAnchorId).toBe("err-pre-only");
    expect(assistantRows[0].manualRungAnchorId).not.toBe(
      "err-queue-paused-only",
    );
  });
});

const SETTLED_TITLE = "Routing stopped";
const SETTLED_MESSAGE =
  "Every account and model that could take this turn said no.";

const RECEIPT: ProviderNoticeReceipt = {
  causeLabel: "Rate limit reached",
  steps: [
    {
      kind: "switch",
      providerLabel: "Claude Code",
      modelLabel: "claude-sonnet-4",
      profileLabel: "Work",
      resumedAt: null,
      endedLabel: "rate limited",
    },
    {
      kind: "retry",
      providerLabel: "Claude Code",
      modelLabel: "claude-sonnet-4",
      profileLabel: "Work",
      resumedAt: null,
      endedLabel: "still rate limited",
    },
  ],
};

/**
 * The host's settled notice: a text block carrying `providerNotice`. `receipt`
 * takes three shapes on purpose - a receipt, `null` (a superseded settlement)
 * and ABSENT (an older host, or a notice persisted before the key) - because
 * the projection folds the last two into one answer and the type must not
 * hide which one a fixture built.
 */
function settledNoticeBlock(
  blockId: string,
  timestamp: number,
  receipt: ProviderNoticeReceipt | null | "absent",
  parentBlockId: string | null,
): AssistantBlock {
  return {
    type: "text",
    blockId,
    status: "completed",
    timestamp,
    text: SETTLED_TITLE,
    ...(parentBlockId === null ? {} : { parentBlockId }),
    providerNotice: {
      harnessId: "claude",
      noticeKind: "fallback_settled",
      tone: "warning",
      title: SETTLED_TITLE,
      message: SETTLED_MESSAGE,
      details: [{ label: "Tried", value: "2 accounts" }],
      metadata: null,
      ...(receipt === "absent" ? {} : { receipt }),
    },
  };
}

function assistantRowsOf(patch: Partial<RenderedMessagesInput>) {
  const { result } = renderRenderedMessages(patch);
  return result.current.filter((row) => row.role === "assistant");
}

describe("routingSettledNoticeId projection", () => {
  it("stamps the notice with a receipt on the anchor's own row, beside the anchor", () => {
    const rows = assistantRowsOf({
      messages: [
        {
          ...assistantMessage("turn-settled", 2000),
          blocks: [
            terminalErrorBlock("err-settled", 2001),
            settledNoticeBlock("notice-settled", 2002, RECEIPT, null),
          ],
        },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].manualRungAnchorId).toBe("err-settled");
    expect(rows[0].routingSettledNoticeId).toBe("notice-settled");
  });

  it("stamps it whichever order the host wrote the two blocks in", () => {
    const rows = assistantRowsOf({
      messages: [
        {
          ...assistantMessage("turn-settled-first", 2000),
          blocks: [
            settledNoticeBlock("notice-first", 2001, RECEIPT, null),
            terminalErrorBlock("err-after", 2002),
          ],
        },
      ],
    });
    expect(rows[0].manualRungAnchorId).toBe("err-after");
    expect(rows[0].routingSettledNoticeId).toBe("notice-first");
  });

  it("does not stamp a notice whose receipt is null: it stays a divider", () => {
    const rows = assistantRowsOf({
      messages: [
        {
          ...assistantMessage("turn-null-receipt", 2000),
          blocks: [
            terminalErrorBlock("err-null", 2001),
            settledNoticeBlock("notice-null", 2002, null, null),
          ],
        },
      ],
    });
    expect(rows[0].manualRungAnchorId).toBe("err-null");
    expect(rows[0].routingSettledNoticeId).toBeUndefined();
  });

  it("does not stamp a notice with NO receipt key at all (an older host)", () => {
    const rows = assistantRowsOf({
      messages: [
        {
          ...assistantMessage("turn-absent-receipt", 2000),
          blocks: [
            terminalErrorBlock("err-absent", 2001),
            settledNoticeBlock("notice-absent", 2002, "absent", null),
          ],
        },
      ],
    });
    expect(rows[0].manualRungAnchorId).toBe("err-absent");
    expect(rows[0].routingSettledNoticeId).toBeUndefined();
  });

  it("does not stamp a receipt notice that nests under a subagent", () => {
    const rows = assistantRowsOf({
      messages: [
        {
          ...assistantMessage("turn-nested", 2000),
          blocks: [
            terminalErrorBlock("err-nested", 2001),
            settledNoticeBlock("notice-nested", 2002, RECEIPT, "subagent-1"),
          ],
        },
      ],
    });
    expect(rows[0].manualRungAnchorId).toBe("err-nested");
    expect(rows[0].routingSettledNoticeId).toBeUndefined();
  });

  it("stamps nothing on a turn with a receipt notice but no error to fold it into", () => {
    const rows = assistantRowsOf({
      messages: [
        {
          ...assistantMessage("turn-no-error", 2000),
          blocks: [settledNoticeBlock("notice-alone", 2001, RECEIPT, null)],
        },
      ],
    });
    expect(rows[0].manualRungAnchorId).toBeUndefined();
    expect(rows[0].routingSettledNoticeId).toBeUndefined();
  });

  it("puts the card on the LATEST slice's row only when one turn is split in two by a steer", () => {
    // Hop one failed and settled, the user steered, hop two failed and settled
    // again: each row carries an error AND a receipt notice, and only the row
    // holding the latest attempt's error is the anchor.
    const rows = assistantRowsOf({
      messages: [
        {
          ...assistantMessage("turn-two-hop", 2000),
          blocks: [
            terminalErrorBlock("err-hop-1", 2001),
            settledNoticeBlock("notice-hop-1", 2002, RECEIPT, null),
            steerBlock("steer-hop", "steer-msg-hop", 2003),
            terminalErrorBlock("err-hop-2", 2004),
            settledNoticeBlock("notice-hop-2", 2005, RECEIPT, null),
          ],
        },
      ],
    });
    // Precondition: the fixture actually split into two rows.
    expect(rows).toHaveLength(2);
    const [hopOne, hopTwo] = rows;
    expect(hopOne.manualRungAnchorId).toBeUndefined();
    expect(hopOne.routingSettledNoticeId).toBeUndefined();
    expect(hopTwo.manualRungAnchorId).toBe("err-hop-2");
    expect(hopTwo.routingSettledNoticeId).toBe("notice-hop-2");
  });

  it("stamps the LAST receipt notice when a row somehow carries two", () => {
    const rows = assistantRowsOf({
      messages: [
        {
          ...assistantMessage("turn-two-notices", 2000),
          blocks: [
            settledNoticeBlock("notice-old", 2001, RECEIPT, null),
            settledNoticeBlock("notice-new", 2002, RECEIPT, null),
            terminalErrorBlock("err-two-notices", 2003),
          ],
        },
      ],
    });
    expect(rows[0].routingSettledNoticeId).toBe("notice-new");
  });

  it("re-projects when a repeat upsert ADDS the receipt to a notice already cached", () => {
    const withoutReceipt: Extract<Message, { role: "assistant" }> = {
      ...assistantMessage("turn-upsert", 2000),
      blocks: [
        terminalErrorBlock("err-upsert", 2001),
        settledNoticeBlock("notice-upsert", 2002, null, null),
      ],
    };
    const withReceipt: Extract<Message, { role: "assistant" }> = {
      ...withoutReceipt,
      blocks: [
        terminalErrorBlock("err-upsert", 2001),
        settledNoticeBlock("notice-upsert", 2002, RECEIPT, null),
      ],
    };
    const base: RenderedMessagesInput = {
      messages: [withoutReceipt],
      events: [],
      rowContext: {},
      pendingUserMessages: [],
      withdrawnMessageId: null,
      liveAssistantMessage: null,
      activeTurn: null,
      runStatus: "idle",
      setupCardWindows: [],
      ...BINDING,
    };
    const { result, rerender } = renderHook(
      ({ current }: { current: RenderedMessagesInput }) =>
        useRenderedMessages(current, displayContext),
      { initialProps: { current: base } },
    );
    expect(result.current[0].routingSettledNoticeId).toBeUndefined();

    rerender({ current: { ...base, messages: [withReceipt] } });

    // The same block id and every text field unchanged: only the receipt
    // arrived, and the cached segment must not be served.
    expect(result.current[0].routingSettledNoticeId).toBe("notice-upsert");
  });
});

// ---------------------------------------------------------------------------
// The render-through-ChatMessage half: the same split turn, mounted for real,
// counted by its VISIBLE recovery groups rather than by the projected field.

const harnessStore = vi.hoisted(() => ({
  lastFailedAttempt: undefined as LastFailedAttempt | undefined,
}));

/** What the recovery actions read off the session: a live chat this viewer may act on. */
function sessionSlice() {
  return {
    lastFailedAttempt: harnessStore.lastFailedAttempt,
    access: { canAct: true },
    connectionStatus: "open",
    chat: null,
    publishConfirmedManualFallbackAction: () => undefined,
  };
}

vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) => ({
  // The rest of the module stays real: the error card's transitive imports
  // (the turn-completion helpers) read other exports at load.
  ...(await importOriginal<
    typeof import("@/lib/registries/chat-session-registry")
  >()),
  useExistingChatSessionHandle: () => ({
    store: {
      getState: () => sessionSlice(),
      getInitialState: () => sessionSlice(),
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

// The card's routing chooser names its host; this suite has no host directory
// and reads no label off it.
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => null,
}));

vi.mock("@/components/chat/fallback/open-fallback-settings", () => ({
  useOpenFallbackSettings: () => () => undefined,
}));

/**
 * `useFallbackModelLabels` alone, kept real everywhere else in the module - see
 * `chat-messages-fallback.test.tsx`'s copy of this double for the argument.
 *
 * This file is about WHERE the recovery group anchors, not about what it says:
 * it counts Retry buttons and asserts nothing on a model string. The double is
 * here only so the real resolver's TanStack queries do not demand a
 * `QueryClientProvider` this suite has no other use for, so a pass-through is
 * the whole of it.
 */
vi.mock(
  "@/components/chat/fallback/fallback-identity",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/components/chat/fallback/fallback-identity")
      >();
    return {
      ...actual,
      useFallbackModelLabels: () => (_harnessId: string, model: string) =>
        model,
    };
  },
);

function renderMounted(ui: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={0}>
        <TabHostProvider hostId={HOST_ID}>
          <ChatTranscriptProvider value={{ chatId: CHAT_ID, hostId: HOST_ID }}>
            <ChatExpansionTestProviders tileInstanceId="manual-rung-anchor-tile">
              {ui}
            </ChatExpansionTestProviders>
          </ChatTranscriptProvider>
        </TabHostProvider>
      </TooltipProvider>
    </QueryClientProvider>,
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

describe("the settled routing card, mounted", () => {
  afterEach(() => {
    cleanup();
    harnessStore.lastFailedAttempt = undefined;
  });

  function failedAttemptFor(turnId: string): LastFailedAttempt {
    return {
      userMessageId: `user-${turnId}`,
      turnId,
      failure: { reason: "rate_limit" },
      eligibleRungs: ["retry"],
      waitDisposition: "no_verified_reset",
      switchDisposition: "unknown",
      failedTuple: null,
    };
  }

  function mountTurn(
    turnId: string,
    receipt: ProviderNoticeReceipt | null | "absent",
  ) {
    harnessStore.lastFailedAttempt = failedAttemptFor(turnId);
    const rows = assistantRowsOf({
      messages: [
        {
          ...assistantMessage(turnId, 2000),
          blocks: [
            terminalErrorBlock(`err-${turnId}`, 2001),
            settledNoticeBlock(`notice-${turnId}`, 2002, receipt, null),
          ],
        },
      ],
    });
    return renderMounted(
      <>
        {rows.map((row) => (
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
  }

  it("folds the notice and the error into ONE card with the receipt, the gear and the failed-turn actions", () => {
    mountTurn("turn-card", RECEIPT);

    const card = screen.getByTestId("routing-settled-card");
    expect(screen.getAllByTestId("routing-settled-card")).toHaveLength(1);
    // The notice's own words, painted once - by the card, not also by a divider.
    expect(screen.getAllByText(SETTLED_TITLE)).toHaveLength(1);
    expect(within(card).getByText(SETTLED_TITLE)).toBeTruthy();
    expect(within(card).getByText(SETTLED_MESSAGE)).toBeTruthy();

    const steps = within(
      within(card).getByTestId("routing-receipt"),
    ).getAllByRole("listitem");
    expect(steps).toHaveLength(2);
    expect(steps[0]?.textContent).toContain(
      "Switched to claude-sonnet-4 · Work",
    );
    expect(steps[0]?.textContent).toContain("rate limited");
    expect(steps[1]?.textContent).toContain("Retried claude-sonnet-4 · Work");
    // Why each step ended reads as a failure, in the destructive text colour.
    const ended = within(steps[0]).getByText("rate limited");
    expect(ended.className).toContain("text-destructive");

    expect(
      within(card).getByRole("button", { name: "Model routing settings" }),
    ).toBeTruthy();
    // The failed-turn card's own action, so the user continues from here.
    expect(within(card).getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(1);
  });

  it("paints the notice's title and message inside the find unit the projection indexes", () => {
    mountTurn("turn-find", RECEIPT);

    const card = screen.getByTestId("routing-settled-card");
    const unit = card.querySelector(
      `[data-chat-find-unit="${chatFindSegmentUnitId("notice-turn-find")}"]`,
    );
    expect(unit).not.toBeNull();
    expect(unit?.textContent).toContain(SETTLED_TITLE);
    expect(unit?.textContent).toContain(SETTLED_MESSAGE);
    // The absorbed error paints no unit of its own for find to count.
    expect(
      document.querySelector(
        `[data-chat-find-unit="${chatFindSegmentUnitId("err-turn-find")}"]`,
      ),
    ).toBeNull();
  });

  it("with two attempts (two turns) puts the card on the replacement turn's row and leaves the original a plain, action-less error", () => {
    harnessStore.lastFailedAttempt = failedAttemptFor("turn-replacement");
    const rows = assistantRowsOf({
      messages: [
        {
          ...assistantMessage("turn-original", 2000),
          blocks: [
            terminalErrorBlockSaying(
              "err-original",
              2001,
              "Original attempt failed.",
            ),
          ],
        },
        {
          ...assistantMessage("turn-replacement", 3000),
          blocks: [
            terminalErrorBlockSaying(
              "err-replacement",
              3001,
              "Replacement attempt failed.",
            ),
            settledNoticeBlock("notice-replacement", 3002, RECEIPT, null),
          ],
        },
      ],
    });
    // Precondition: two rows, one per turn.
    expect(rows).toHaveLength(2);
    const { container } = renderMounted(
      <>
        {rows.map((row) => (
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

    const card = screen.getByTestId("routing-settled-card");
    expect(screen.getAllByTestId("routing-settled-card")).toHaveLength(1);
    expect(within(card).getByTestId("routing-receipt")).toBeTruthy();
    expect(
      within(card).getByRole("button", { name: "Model routing settings" }),
    ).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Retry" })).toBeTruthy();

    // The original turn's error stays a plain card: its message, no actions.
    const plain = container.querySelectorAll("[data-failure-presentation]");
    expect(plain).toHaveLength(1);
    const original = plain[0] as HTMLElement;
    expect(within(original).getByText("Original attempt failed.")).toBeTruthy();
    expect(card.contains(original)).toBe(false);
    expect(
      within(original).queryByRole("button", { name: "Retry" }),
    ).toBeNull();
    expect(
      within(original).queryByRole("button", { name: /Switch to/ }),
    ).toBeNull();
    expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(1);
  });

  it("draws each wait step's line without claiming a resume, and its ending in the destructive column", () => {
    const resumedAt = new Date(2026, 5, 15, 1, 2, 0).getTime();
    const REFUSED =
      "Couldn't resume: the account or model is no longer available";
    mountTurn("turn-wait-steps", {
      causeLabel: "Rate limit reached",
      steps: [
        {
          kind: "wait",
          providerLabel: "Claude Code",
          modelLabel: "claude-sonnet-4",
          profileLabel: "Personal 3",
          resumedAt,
          endedLabel: "rate limited",
        },
        {
          kind: "wait",
          providerLabel: "Claude Code",
          modelLabel: "claude-sonnet-4",
          profileLabel: "Personal 3",
          resumedAt,
          endedLabel: REFUSED,
        },
      ],
    });

    const steps = within(
      within(screen.getByTestId("routing-settled-card")).getByTestId(
        "routing-receipt",
      ),
    ).getAllByRole("listitem");
    expect(steps).toHaveLength(2);
    const expected = ["rate limited", REFUSED];
    steps.forEach((step, index) => {
      // li children: the number, the step text, the ending.
      const line = step.children[1].textContent;
      const ending = step.children[2];
      expect(line).toMatch(/Waited until 1:02\sAM for Personal 3$/);
      expect(line).not.toMatch(/resumed/i);
      expect(ending.textContent).toBe(expected[index]);
      expect(ending.className).toContain("text-destructive");
    });
  });

  it("is a warning card, never the red error treatment, and has no plain error card beside it", () => {
    const { container } = mountTurn("turn-tone", RECEIPT);

    const card = screen.getByTestId("routing-settled-card");
    expect(card.className).toContain("border-warning/30");
    expect(card.className).not.toContain("border-destructive");
    expect(container.querySelector("[data-failure-presentation]")).toBeNull();
  });

  it("keeps the raw error and the notice's own rows behind 'Details for a bug report'", () => {
    mountTurn("turn-details", RECEIPT);
    const card = screen.getByTestId("routing-settled-card");
    expect(within(card).queryByText("Rate limited.")).toBeNull();

    const toggle = within(card).getByRole("button", {
      name: "Details for a bug report",
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(within(card).getByText("Rate limited.")).toBeTruthy();
    expect(within(card).getByText("Tried")).toBeTruthy();
    expect(within(card).getByText("2 accounts")).toBeTruthy();
  });

  it("says 'Nothing could be tried' for a receipt with no steps", () => {
    mountTurn("turn-empty", { causeLabel: "Rate limit reached", steps: [] });

    const card = screen.getByTestId("routing-settled-card");
    expect(within(card).getByTestId("routing-receipt-empty").textContent).toBe(
      "Nothing could be tried",
    );
    expect(within(card).queryByTestId("routing-receipt")).toBeNull();
  });

  it.each([
    ["a null receipt", null],
    ["no receipt key (an older host)", "absent"],
  ] as const)(
    "with %s the notice stays a divider and the plain error card keeps its actions",
    (_name, receipt) => {
      const { container } = mountTurn("turn-divider", receipt);

      expect(screen.queryByTestId("routing-settled-card")).toBeNull();
      expect(screen.queryByTestId("routing-receipt")).toBeNull();
      // The notice's own row...
      expect(screen.getByText(SETTLED_TITLE)).toBeTruthy();
      // ...and the plain error card, its message and its Retry.
      const errorCard = container.querySelector("[data-failure-presentation]");
      expect(errorCard).not.toBeNull();
      expect(
        within(errorCard as HTMLElement).getByText("Rate limited."),
      ).toBeTruthy();
      expect(
        within(errorCard as HTMLElement).getByRole("button", { name: "Retry" }),
      ).toBeTruthy();
    },
  );
});
