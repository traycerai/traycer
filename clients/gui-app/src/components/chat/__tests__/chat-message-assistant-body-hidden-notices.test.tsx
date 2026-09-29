import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { QUEUE_PAUSED_AFTER_ERROR_CODE } from "@traycer/protocol/host/agent/gui/agent-runtime";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import { AssistantMessageBody } from "@/components/chat/chat-message-assistant-body";
import { ChatTranscriptProvider } from "@/components/chat/chat-transcript-context";
import { TranscriptQueuePauseReasonSupportContext } from "@/components/chat/use-transcript-queue-pause-reason-support";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { MessageSegment } from "@/stores/composer/chat-store";

vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ openSettings: vi.fn() }),
}));

// F2 renders the settled card (a receipt-carrying `fallback_settled` notice
// on the manual-rung anchor), which reaches `useHostClientForHostId` (throws
// outside a `<HostRuntimeProvider>`) and `useFallbackModelLabels` (mounts a
// TanStack query this suite has no `QueryClientProvider` for) - the same
// doubles `error-segment-fallback.test.tsx` uses for the identical reason.
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));

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

const TRANSCRIPT_EPIC_ID = "epic-hidden-notices";
const TRANSCRIPT_CHAT_ID = "chat-hidden-notices";
const TRANSCRIPT_HOST_ID = "tab-host-hidden-notices";

vi.mock("@/providers/use-open-epic-handle", () => ({
  useMaybeOpenEpicHandle: () => ({ epicId: TRANSCRIPT_EPIC_ID }),
}));

/**
 * The seeded session. Its `queuePauseReasonProtocolSupported` is what
 * `AssistantMessageBody` reads to decide whether the queue notice may draw, and
 * it reaches the body the way it does in the app: `renderBody` provides it
 * through `TranscriptQueuePauseReasonSupportContext`, as `ChatTileSessionView`
 * does from the handle it renders. No provider when nothing is seeded - the
 * "no session" reading, `null`.
 *
 * The rest is the slice `FallbackManualRungActions` still reads through the
 * registry (`useMaybeChatTranscript` + `useMaybeOpenEpicHandle` +
 * `useExistingChatSessionHandle`): the fields its hooks read unconditionally
 * (`lastFailedAttempt`, `pendingFallback`, `access`, `connectionStatus`), so
 * F2's settled-card row - which mounts that component on the manual-rung
 * anchor - reads a real "no live attempt" slice instead of throwing on an
 * absent field.
 */
type HiddenNoticesSessionSlice = {
  queuePauseReasonProtocolSupported: boolean | null;
  lastFailedAttempt: undefined;
  pendingFallback: undefined;
  access: { readonly canAct: boolean } | null;
  connectionStatus: "connecting" | "open" | "reconnecting" | "closed";
  chat: null;
};

function defaultSessionSlice(
  queuePauseReasonProtocolSupported: boolean | null,
): HiddenNoticesSessionSlice {
  return {
    queuePauseReasonProtocolSupported,
    lastFailedAttempt: undefined,
    pendingFallback: undefined,
    access: { canAct: true },
    connectionStatus: "open",
    chat: null,
  };
}

const sessionHarness = vi.hoisted(() => {
  let state: HiddenNoticesSessionSlice | null = null;
  const listeners = new Set<() => void>();
  const store = {
    getState: (): HiddenNoticesSessionSlice => {
      if (state === null) throw new Error("no session state seeded");
      return state;
    },
    getInitialState: (): HiddenNoticesSessionSlice => {
      if (state === null) throw new Error("no session state seeded");
      return state;
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    store,
    hasSession: (): boolean => state !== null,
    seed(value: HiddenNoticesSessionSlice): void {
      state = value;
    },
    clear(): void {
      state = null;
    },
  };
});

vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/registries/chat-session-registry")
  >()),
  useExistingChatSessionHandle: () =>
    sessionHarness.hasSession() ? { store: sessionHarness.store } : null,
}));

function renderBody(
  body: ReactNode,
  transcript: { chatId: string; hostId: string } | null,
) {
  const ui = sessionHarness.hasSession() ? (
    <TranscriptQueuePauseReasonSupportContext
      value={sessionHarness.store.getState().queuePauseReasonProtocolSupported}
    >
      {body}
    </TranscriptQueuePauseReasonSupportContext>
  ) : (
    body
  );
  const wrapped = (
    <TooltipProvider delay={0}>
      <TabHostProvider hostId={TRANSCRIPT_HOST_ID}>
        <ChatExpansionTestProviders tileInstanceId="hidden-notices-tile">
          {ui}
        </ChatExpansionTestProviders>
      </TabHostProvider>
    </TooltipProvider>
  );
  if (transcript === null) return render(wrapped);
  return render(
    <TooltipProvider delay={0}>
      <TabHostProvider hostId={TRANSCRIPT_HOST_ID}>
        <ChatTranscriptProvider value={transcript}>
          <ChatExpansionTestProviders tileInstanceId="hidden-notices-tile">
            {ui}
          </ChatExpansionTestProviders>
        </ChatTranscriptProvider>
      </TabHostProvider>
    </TooltipProvider>,
  );
}

const QUEUE_NOTICE_MESSAGE =
  "1 queued message was held because this turn ended with an error, and it was not sent. Resume the queue to send it.";

const QUEUE_NOTICE: MessageSegment = {
  id: "queue-paused:u1",
  kind: "error",
  message: QUEUE_NOTICE_MESSAGE,
  recoverable: true,
  code: QUEUE_PAUSED_AFTER_ERROR_CODE,
  failure: null,
};

const CANCELLATION_TITLE =
  "Fallback ended - no further providers will be tried for this turn";
const CANCELLATION_MESSAGE = "What was tried is recorded below.";

function cancellationNotice(input: {
  readonly id: string;
  readonly noticeKind: "fallback_settled" | "fallback_applied";
  readonly codeValue: string;
  readonly causeValue: string;
}): MessageSegment {
  return {
    id: input.id,
    kind: "provider_notice",
    status: "completed",
    noticeKind: input.noticeKind,
    tone: "info",
    title: CANCELLATION_TITLE,
    message: CANCELLATION_MESSAGE,
    details: [
      { label: "Code", value: input.codeValue },
      {
        label: "Detail",
        value: "Routing was cancelled. The turn's original error stands.",
      },
      { label: "Cause", value: input.causeValue },
      { label: "Reason", value: "Hit a rate limit" },
      { label: "Failed on", value: "Claude Code · claude-sonnet-4" },
    ],
    receipt: null,
    parentId: null,
  };
}

const CANCELLATION_NOTICE = cancellationNotice({
  id: "fallback-settled:t1",
  noticeKind: "fallback_settled",
  codeValue: "FALLBACK_CANCELLED",
  causeValue: "You chose not to switch",
});

const EXHAUSTED_NOTICE = cancellationNotice({
  id: "fallback-settled:t2",
  noticeKind: "fallback_settled",
  codeValue: "FALLBACK_EXHAUSTED",
  causeValue: "Every step was tried",
});

/** Code EXHAUSTED, but its Cause prose happens to mention cancellation. */
const EXHAUSTED_WITH_CANCEL_PROSE_NOTICE = cancellationNotice({
  id: "fallback-settled:t3",
  noticeKind: "fallback_settled",
  codeValue: "FALLBACK_EXHAUSTED",
  causeValue: "You chose to cancel this run",
});

/** Code CANCELLED, but on a `fallback_applied` notice, not `fallback_settled`. */
const CANCELLED_CODE_ON_APPLIED_NOTICE = cancellationNotice({
  id: "fallback-settled:t4",
  noticeKind: "fallback_applied",
  codeValue: "FALLBACK_CANCELLED",
  causeValue: "You chose not to switch",
});

/** The body under test, with everything but `segments` held fixed. */
function Body({
  segments,
}: {
  readonly segments: ReadonlyArray<MessageSegment>;
}) {
  return (
    <AssistantMessageBody
      segments={segments}
      backgroundToolBlockIds={new Set()}
      runState={null}
      messageId="assistant:turn-hidden-notices"
      turnId="turn-hidden-notices"
      manualRungAnchorId={null}
      elapsedStartedAt={0}
      turnHasOnlyAutonomousResumeSegments={false}
      showCompletionFooter={false}
      pausedDurationMs={0}
      pausedSinceMs={null}
      completedAt={null}
      stopped={null}
      meta={null}
      nextStepActions={null}
      forkAction={null}
      interviewDeliveryRetry={null}
      routingSettledNoticeId={null}
    />
  );
}

/** The body under test for the "elapsed footer" describe: a completed, failed turn. */
function CompletedBody({
  segments,
}: {
  readonly segments: ReadonlyArray<MessageSegment>;
}) {
  return (
    <AssistantMessageBody
      segments={segments}
      backgroundToolBlockIds={new Set()}
      runState={null}
      messageId="assistant:turn-hidden-notices-footer"
      turnId="turn-hidden-notices-footer"
      manualRungAnchorId="queue-paused:u1"
      elapsedStartedAt={0}
      turnHasOnlyAutonomousResumeSegments={false}
      showCompletionFooter
      pausedDurationMs={0}
      pausedSinceMs={null}
      completedAt={1000}
      stopped={null}
      meta={null}
      nextStepActions={null}
      forkAction={null}
      interviewDeliveryRetry={null}
      routingSettledNoticeId={null}
    />
  );
}

describe("AssistantMessageBody hides for the queue notice", () => {
  afterEach(() => {
    sessionHarness.clear();
    cleanup();
  });

  // N1: session says the host protocol cannot carry a pause reason
  // (`queuePauseReasonProtocolSupported === false`) - the ONE case the queue
  // notice must draw.
  it("N1: draws the queue notice when the session says the protocol is not supported", () => {
    sessionHarness.seed(defaultSessionSlice(false));
    renderBody(<Body segments={[QUEUE_NOTICE]} />, {
      chatId: TRANSCRIPT_CHAT_ID,
      hostId: TRANSCRIPT_HOST_ID,
    });

    expect(screen.getByText(QUEUE_NOTICE_MESSAGE)).not.toBeNull();
    expect(
      document.querySelector('[data-block-id="queue-paused:u1"]'),
    ).not.toBeNull();
  });

  // N2: session says the protocol IS supported (a genuinely paused queue) -
  // the notice stays hidden, same as today.
  it("N2: hides the queue notice when the session says the protocol is supported", () => {
    sessionHarness.seed(defaultSessionSlice(true));
    renderBody(<Body segments={[QUEUE_NOTICE]} />, {
      chatId: TRANSCRIPT_CHAT_ID,
      hostId: TRANSCRIPT_HOST_ID,
    });

    expect(screen.queryByText(QUEUE_NOTICE_MESSAGE)).toBeNull();
  });

  // N3: no session at all - the absent-probe reading is `null`, which hides.
  it("N3: hides the queue notice when there is no session", () => {
    renderBody(<Body segments={[QUEUE_NOTICE]} />, null);

    expect(screen.queryByText(QUEUE_NOTICE_MESSAGE)).toBeNull();
  });

  // N4: a hidden queue notice must mount no navigation anchor either - not
  // just hidden text - in both the "session true" and "no session" cases.
  it("N4: mounts no navigation anchor for a hidden queue notice (session true)", () => {
    sessionHarness.seed(defaultSessionSlice(true));
    renderBody(<Body segments={[QUEUE_NOTICE]} />, {
      chatId: TRANSCRIPT_CHAT_ID,
      hostId: TRANSCRIPT_HOST_ID,
    });

    expect(
      document.querySelector('[data-block-id="queue-paused:u1"]'),
    ).toBeNull();
  });

  it("N4: mounts no navigation anchor for a hidden queue notice (no session)", () => {
    renderBody(<Body segments={[QUEUE_NOTICE]} />, null);

    expect(
      document.querySelector('[data-block-id="queue-paused:u1"]'),
    ).toBeNull();
  });
});

describe("AssistantMessageBody hides the cancellation notice unconditionally", () => {
  afterEach(() => {
    sessionHarness.clear();
    cleanup();
  });

  // X1: the cancellation notice is hidden regardless of the queue-notice-only
  // flag - both with session true and with session false.
  it.each([
    ["true", true],
    ["false", false],
  ] as const)(
    "X1: hides the cancellation notice with session=%s",
    (_label, protocolSupported) => {
      sessionHarness.seed(defaultSessionSlice(protocolSupported));
      renderBody(<Body segments={[CANCELLATION_NOTICE]} />, {
        chatId: TRANSCRIPT_CHAT_ID,
        hostId: TRANSCRIPT_HOST_ID,
      });

      expect(screen.queryByText(CANCELLATION_TITLE)).toBeNull();
      expect(
        document.querySelector('[data-block-id="fallback-settled:t1"]'),
      ).toBeNull();
    },
  );

  // X2: the FALLBACK_EXHAUSTED variant of the same shape is NOT hidden - the
  // Code-specific rule does not apply to it.
  it("X2: draws the FALLBACK_EXHAUSTED variant", () => {
    renderBody(<Body segments={[EXHAUSTED_NOTICE]} />, {
      chatId: TRANSCRIPT_CHAT_ID,
      hostId: TRANSCRIPT_HOST_ID,
    });

    expect(screen.getByText(CANCELLATION_TITLE)).not.toBeNull();
  });

  // X3: Code EXHAUSTED with Cause prose that happens to mention "cancel" is
  // still drawn - the hide keys ONLY on the Code field, never on any prose.
  it("X3: draws a Code=EXHAUSTED notice even when its Cause prose mentions cancellation", () => {
    renderBody(<Body segments={[EXHAUSTED_WITH_CANCEL_PROSE_NOTICE]} />, {
      chatId: TRANSCRIPT_CHAT_ID,
      hostId: TRANSCRIPT_HOST_ID,
    });

    expect(screen.getByText(CANCELLATION_TITLE)).not.toBeNull();
  });

  // X4: Code=CANCELLED on a `fallback_applied` notice (not `fallback_settled`)
  // is still drawn - the hide requires BOTH the noticeKind and the Code value.
  it("X4: draws a Code=CANCELLED notice whose noticeKind is fallback_applied, not fallback_settled", () => {
    renderBody(<Body segments={[CANCELLED_CODE_ON_APPLIED_NOTICE]} />, {
      chatId: TRANSCRIPT_CHAT_ID,
      hostId: TRANSCRIPT_HOST_ID,
    });

    expect(screen.getByText(CANCELLATION_TITLE)).not.toBeNull();
  });
});

describe("elapsed footer", () => {
  afterEach(() => {
    sessionHarness.clear();
    cleanup();
  });

  // F1: a completed, failed turn whose segments are [error, cancellation
  // notice] draws no elapsed footer.
  it("F1: draws no elapsed footer for [error, cancellation notice]", () => {
    const ERROR_SEGMENT: MessageSegment = {
      id: "error-f1",
      kind: "error",
      message: "The turn failed.",
      recoverable: true,
      code: "RUNTIME",
      failure: null,
    };
    renderBody(
      <CompletedBody segments={[ERROR_SEGMENT, CANCELLATION_NOTICE]} />,
      { chatId: TRANSCRIPT_CHAT_ID, hostId: TRANSCRIPT_HOST_ID },
    );

    expect(screen.queryByTestId("assistant-elapsed-footer")).toBeNull();
  });

  // F2: [error as the manual-rung anchor, fallback_settled WITH a non-null
  // receipt] draws no elapsed footer.
  it("F2: draws no elapsed footer for [error anchor, fallback_settled with a receipt]", () => {
    const ERROR_SEGMENT: MessageSegment = {
      id: "queue-paused:u1",
      kind: "error",
      message: "The turn failed.",
      recoverable: true,
      code: "RUNTIME",
      failure: null,
    };
    const SETTLED_WITH_RECEIPT: MessageSegment = {
      id: "fallback-settled:receipt",
      kind: "provider_notice",
      status: "completed",
      noticeKind: "fallback_settled",
      tone: "info",
      title: CANCELLATION_TITLE,
      message: CANCELLATION_MESSAGE,
      details: [{ label: "Code", value: "FALLBACK_EXHAUSTED" }],
      receipt: {
        causeLabel: "Every step was tried",
        steps: [],
      },
      parentId: null,
    };
    render(
      <TooltipProvider delay={0}>
        <TabHostProvider hostId={TRANSCRIPT_HOST_ID}>
          <ChatTranscriptProvider
            value={{ chatId: TRANSCRIPT_CHAT_ID, hostId: TRANSCRIPT_HOST_ID }}
          >
            <ChatExpansionTestProviders tileInstanceId="hidden-notices-tile">
              <AssistantMessageBody
                segments={[ERROR_SEGMENT, SETTLED_WITH_RECEIPT]}
                backgroundToolBlockIds={new Set()}
                runState={null}
                messageId="assistant:turn-hidden-notices-footer"
                turnId="turn-hidden-notices-footer"
                manualRungAnchorId="queue-paused:u1"
                elapsedStartedAt={0}
                turnHasOnlyAutonomousResumeSegments={false}
                showCompletionFooter
                pausedDurationMs={0}
                pausedSinceMs={null}
                completedAt={1000}
                stopped={null}
                meta={null}
                nextStepActions={null}
                forkAction={null}
                interviewDeliveryRetry={null}
                routingSettledNoticeId="fallback-settled:receipt"
              />
            </ChatExpansionTestProviders>
          </ChatTranscriptProvider>
        </TabHostProvider>
      </TooltipProvider>,
    );

    expect(screen.queryByTestId("assistant-elapsed-footer")).toBeNull();
  });

  // F3: [error, fallback_applied] - pins TODAY's actual behavior: the footer
  // renders, because the last segment is a `provider_notice`, not an `error`.
  it("F3: draws the elapsed footer for [error, fallback_applied] (today's behavior)", () => {
    const ERROR_SEGMENT: MessageSegment = {
      id: "error-f3",
      kind: "error",
      message: "The turn failed.",
      recoverable: true,
      code: "RUNTIME",
      failure: null,
    };
    const FALLBACK_APPLIED: MessageSegment = {
      id: "seg-applied-f3",
      kind: "provider_notice",
      receipt: null,
      status: "completed",
      noticeKind: "fallback_applied",
      tone: "info",
      title: "Switched providers",
      message: "Moved to Codex.",
      details: [],
      parentId: null,
    };
    renderBody(<CompletedBody segments={[ERROR_SEGMENT, FALLBACK_APPLIED]} />, {
      chatId: TRANSCRIPT_CHAT_ID,
      hostId: TRANSCRIPT_HOST_ID,
    });

    expect(screen.queryByTestId("assistant-elapsed-footer")).not.toBeNull();
  });

  // F4: [error, queue notice] with session=false (drawn), and the LAST
  // segment in the transcript is the error-type queue notice - no elapsed
  // footer, already true today because the last segment being an error type
  // already suppresses the footer, independent of the new hide logic.
  it("F4: draws no elapsed footer for [error, queue notice] with session=false", () => {
    sessionHarness.seed(defaultSessionSlice(false));
    const ERROR_SEGMENT: MessageSegment = {
      id: "error-f4",
      kind: "error",
      message: "The turn failed.",
      recoverable: true,
      code: "RUNTIME",
      failure: null,
    };
    renderBody(<CompletedBody segments={[ERROR_SEGMENT, QUEUE_NOTICE]} />, {
      chatId: TRANSCRIPT_CHAT_ID,
      hostId: TRANSCRIPT_HOST_ID,
    });

    expect(screen.queryByTestId("assistant-elapsed-footer")).toBeNull();
  });
});
