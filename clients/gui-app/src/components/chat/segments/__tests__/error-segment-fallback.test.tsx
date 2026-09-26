import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  LastFailedAttempt,
  PendingFallback,
} from "@traycer/protocol/host/agent/gui/subscribe";
import { ChatTranscriptProvider } from "@/components/chat/chat-transcript-context";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { AgentFailure } from "@traycer/protocol/persistence/epic/content-blocks";
import { QUEUE_PAUSED_AFTER_ERROR_CODE } from "@traycer/protocol/host/agent/gui/agent-runtime";
import type { FallbackRungRefusalDetail } from "@traycer/protocol/host/chat-fallback";
import { ErrorSegment } from "../error-segment";
import {
  FAILED_CLAUDE_TUPLE,
  TARGET_CODEX_TUPLE,
  lastFailedAttempt,
  pendingFallback,
} from "../../fallback/__tests__/fallback-fixtures";

vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ openSettings: vi.fn() }),
}));

// The mocks below are the same shape `fallback-manual-rungs.test.tsx` uses to
// exercise `ManualRungActions` directly - lifted here because this file is
// where its HOST, `FallbackManualRungActions`, is actually mounted (via
// `ErrorSegment`) and where the traversal-is-live gate this suite is about
// (`fallback-manual-rungs.tsx`'s `if (traversalIsLive) return null;`) can be
// driven end to end. Every mock below stands in for a real host RPC or query
// hook this component tree reaches - `useHostClientForHostId` (null client is
// fine: nothing here presses a button that dispatches), the manual-rung
// mutation, the fallback-target catalogue list, and the providers catalogue -
// none of which this suite's earlier cases needed because they never mount a
// transcript context for `FallbackManualRungActions` to find.
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));

// The chooser has its own suite. Here the Switch… trigger is a plain button that
// carries the variant the row handed it, so the row's ordering and fill can be
// asserted without the picker's query and lease machinery.
vi.mock("@/components/chat/fallback/routing-destination-picker", () => ({
  RoutingDestinationPicker: (props: {
    readonly triggerVariant: string;
    readonly triggerLabel: string;
  }) => (
    <button type="button" data-variant={props.triggerVariant}>
      {props.triggerLabel}
    </button>
  ),
}));

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => null,
}));

// What the host answers a press with, and the toast spy: a refusal is written
// on the card and never toasted (spec Flow 4).
const rungAnswer = vi.hoisted(() => ({
  response: null as {
    readonly outcome: string;
    readonly detail: FallbackRungRefusalDetail | null;
  } | null,
  toast: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: rungAnswer.toast }));

vi.mock("@/hooks/host/use-host-scoped-mutation", () => ({
  useHostScopedMutationForClient: () => ({
    mutate: (
      _variables: unknown,
      options:
        | {
            readonly onSuccess:
              | ((response: {
                  readonly outcome: string;
                  readonly detail: FallbackRungRefusalDetail | null;
                }) => void)
              | undefined;
          }
        | undefined,
    ) => {
      const response = rungAnswer.response;
      if (response === null || options === undefined) return;
      if (options.onSuccess !== undefined) options.onSuccess(response);
    },
    isPending: false,
    variables: undefined,
  }),
}));

vi.mock("@/components/chat/fallback/use-fallback-targets", () => ({
  useFallbackListTargets: () => ({
    data: undefined,
    isPending: false,
    isError: false,
  }),
}));

vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersListForClient: () => ({ data: undefined }),
}));

// `useFallbackModelLabels` alone, same as `fallback-manual-rungs.test.tsx`'s
// own copy of this double: the real hook mounts a TanStack query
// (`useGuiHarnessesQueryForClient`) this suite has no `QueryClientProvider`
// for, and no case below asserts on a rendered model label.
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

const FALLBACK_EPIC_ID = "epic-fallback-live-gate";

vi.mock("@/providers/use-open-epic-handle", () => ({
  useMaybeOpenEpicHandle: () => ({ epicId: FALLBACK_EPIC_ID }),
}));

/**
 * The session slice `use-last-failed-attempt.ts` and `use-confirmed-manual-
 * action.ts` read off `useExistingChatSessionHandle(...).store` - the two
 * fields under test (`lastFailedAttempt`, `pendingFallback`) plus the two
 * publishers `ManualRungAffordances` reaches unconditionally on mount, so a
 * slice omitting either fails as a production-looking `TypeError` thrown
 * inside those hook modules rather than as a fixture gap (see
 * `fallback-manual-rungs.test.tsx`'s own comment on this same shape).
 */
type FallbackSessionSlice = {
  lastFailedAttempt: LastFailedAttempt | undefined;
  pendingFallback: PendingFallback | undefined;
  access: { readonly canAct: boolean } | null;
  connectionStatus: "connecting" | "open" | "reconnecting" | "closed";
  chat: null;
  publishConfirmedManualFallbackAction: (input: unknown) => void;
  publishUnattendedFallbackOutcome: (input: unknown) => void;
};

const fallbackSessionHarness = vi.hoisted(() => {
  const initialSlice = (): FallbackSessionSlice => ({
    lastFailedAttempt: undefined,
    pendingFallback: undefined,
    access: { canAct: true },
    connectionStatus: "open",
    chat: null,
    publishConfirmedManualFallbackAction: () => {},
    publishUnattendedFallbackOutcome: () => {},
  });
  let state: FallbackSessionSlice = initialSlice();
  const listeners = new Set<() => void>();
  const store = {
    getState: (): FallbackSessionSlice => state,
    getInitialState: (): FallbackSessionSlice => initialSlice(),
    setState: (next: Partial<FallbackSessionSlice>): FallbackSessionSlice => {
      state = { ...state, ...next };
      for (const listener of listeners) listener();
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
    reset: (): void => {
      state = initialSlice();
    },
  };
});

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  // The row reads "is any rung in flight" through the QueryClient; this suite
  // mocks the mutation itself and has no client, so nothing is ever in flight.
  useIsMutating: () => 0,
}));

vi.mock("@/lib/registries/chat-session-registry", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/registries/chat-session-registry")
  >()),
  useExistingChatSessionHandle: () => ({ store: fallbackSessionHarness.store }),
}));

function renderError(failure: AgentFailure | null) {
  return render(
    <TooltipProvider>
      <TabHostProvider hostId="tab-host-b">
        <ErrorSegment
          turnId={null}
          message="The turn failed."
          code="RUNTIME"
          recoverable
          findUnitId={null}
          harnessId="claude"
          failure={failure}
          settledNotice={null}
          settledNoticeFindUnitId={null}
        />
      </TabHostProvider>
    </TooltipProvider>,
  );
}

describe("ErrorSegment failed-turn card", () => {
  afterEach(() => {
    cleanup();
  });

  // The "Model routing" text link was retired from the card (no text-link
  // actions): the settings entry is the routing card's gear. The signed-out row
  // used to be the one place it appeared, and must not have moved to another.
  it("renders no Model routing link for any failure, the signed-out one included", () => {
    for (const failure of [
      { reason: "auth" },
      null,
      { reason: "rate_limit" },
    ] as const) {
      const { unmount } = renderError(failure);
      expect(
        screen.queryByRole("button", { name: "Model routing" }),
      ).toBeNull();
      expect(screen.queryByRole("link", { name: "Model routing" })).toBeNull();
      expect(screen.queryByText("Model routing")).toBeNull();
      unmount();
    }
  });

  it("renders a turnId-null error row with no host runtime provider and does not throw", () => {
    expect(() => {
      render(
        <TooltipProvider>
          <ErrorSegment
            turnId={null}
            message="The turn failed."
            code="RUNTIME"
            recoverable
            findUnitId={null}
            harnessId="claude"
            failure={{ reason: "rate_limit" }}
            settledNotice={null}
            settledNoticeFindUnitId={null}
          />
        </TooltipProvider>,
      );
    }).not.toThrow();
    expect(screen.getByText("The turn failed.")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  // The two-tone split: a provider refusal (`rate_limit`) reads as
  // "interrupted" - a warning-toned row with the reason's own sentence-case
  // headline and no uppercase ERROR overline or raw code chip - while a turn
  // that genuinely died (`request_rejected`) and a legacy row with no typed
  // reason (`failure === null`) both keep the old destructive rendering. See
  // `agent-failure-presentation.ts` for the classification these three cases
  // pin.
  it("renders the interrupted (warning) tone for a provider refusal, with the reason as its headline and no ERROR overline or code chip", () => {
    render(
      <TooltipProvider>
        <TabHostProvider hostId="tab-host-b">
          <ErrorSegment
            turnId={null}
            message="Hit a rate limit."
            code="rate_limit"
            recoverable
            findUnitId={null}
            harnessId="claude"
            failure={{ reason: "rate_limit" }}
            settledNotice={null}
            settledNoticeFindUnitId={null}
          />
        </TabHostProvider>
      </TooltipProvider>,
    );
    const root = screen
      .getByText("Hit a rate limit.")
      .closest("[data-failure-presentation]");
    expect(root?.getAttribute("data-failure-presentation")).toBe("interrupted");
    expect(root?.className).toContain("border-warning/30");
    expect(root?.className).toContain("bg-warning/10");
    // Falsification: delete the `agentFailureHeadline` call at the row's
    // heading - this literal goes red and only the generic overline remains.
    expect(screen.getByText("Rate limit reached")).toBeDefined();
    expect(screen.queryByText("Error")).toBeNull();
    // The raw code chip is banned on an interrupted row - see
    // `ErrorSegmentHeading`'s doc for why a raw reason code in red monospace
    // is exactly what this classification exists to remove.
    expect(screen.queryByText("rate_limit")).toBeNull();
  });

  it("keeps the destructive (error) tone, the ERROR overline and the code chip for a turn that genuinely died", () => {
    render(
      <TooltipProvider>
        <TabHostProvider hostId="tab-host-b">
          <ErrorSegment
            turnId={null}
            message="The request was rejected."
            code="REQUEST_REJECTED"
            recoverable
            findUnitId={null}
            harnessId="claude"
            failure={{ reason: "request_rejected" }}
            settledNotice={null}
            settledNoticeFindUnitId={null}
          />
        </TabHostProvider>
      </TooltipProvider>,
    );
    const root = screen
      .getByText("The request was rejected.")
      .closest("[data-failure-presentation]");
    expect(root?.getAttribute("data-failure-presentation")).toBe("error");
    expect(root?.className).toContain("border-destructive/30");
    expect(screen.getByText("Error")).toBeDefined();
    expect(screen.getByText("REQUEST_REJECTED")).toBeDefined();
    // No sentence-case headline on this row - "request_rejected" never
    // appears as prose, only inside the raw code chip above.
    expect(screen.queryByText("Request rejected")).toBeNull();
  });

  it("keeps the destructive (error) tone for a legacy row with no typed failure reason", () => {
    render(
      <TooltipProvider>
        <TabHostProvider hostId="tab-host-b">
          <ErrorSegment
            turnId={null}
            message="Something went wrong."
            code="LEGACY"
            recoverable
            findUnitId={null}
            harnessId="claude"
            failure={null}
            settledNotice={null}
            settledNoticeFindUnitId={null}
          />
        </TabHostProvider>
      </TooltipProvider>,
    );
    const root = screen
      .getByText("Something went wrong.")
      .closest("[data-failure-presentation]");
    // Falsification: change `agentFailurePresentation`'s `reason === null`
    // branch from "error" to "interrupted" - a row from before the failure
    // payload existed is nothing anyone can vouch for, and this must stay red.
    expect(root?.getAttribute("data-failure-presentation")).toBe("error");
    expect(screen.getByText("Error")).toBeDefined();
    expect(screen.getByText("LEGACY")).toBeDefined();
  });

  it("renders a turnId-bearing error row with no transcript and no host provider and does not throw", () => {
    expect(() => {
      render(
        <TooltipProvider>
          <ErrorSegment
            turnId="turn-a"
            message="The turn failed."
            code="RUNTIME"
            recoverable
            findUnitId={null}
            harnessId="claude"
            failure={{ reason: "rate_limit" }}
            settledNotice={null}
            settledNoticeFindUnitId={null}
          />
        </TooltipProvider>,
      );
    }).not.toThrow();
    // Falsification: move the host hooks from ManualRungActions up into FallbackManualRungActions above the identity gate — this assertion must go red with the "Host runtime hooks must be used inside a <HostRuntimeProvider>" error.
    expect(screen.getByText("The turn failed.")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});

const FALLBACK_LIVE_GATE_CHAT_ID = "chat-fallback-live-gate";
const FALLBACK_LIVE_GATE_HOST_ID = "host-fallback-live-gate";
const FALLBACK_LIVE_GATE_TURN_ID = "turn-fallback-live-gate";

interface ErrorRowShape {
  readonly code: string;
  readonly failure: AgentFailure | null;
}

const RATE_LIMIT_ROW: ErrorRowShape = {
  code: "rate_limit",
  failure: { reason: "rate_limit" },
};

function renderErrorRowWithFallbackAttempt(row: ErrorRowShape) {
  return render(
    <TooltipProvider>
      <TabHostProvider hostId={FALLBACK_LIVE_GATE_HOST_ID}>
        <ChatTranscriptProvider
          value={{
            chatId: FALLBACK_LIVE_GATE_CHAT_ID,
            hostId: FALLBACK_LIVE_GATE_HOST_ID,
          }}
        >
          <ErrorSegment
            turnId={FALLBACK_LIVE_GATE_TURN_ID}
            message="Hit a rate limit."
            code={row.code}
            recoverable
            findUnitId={null}
            harnessId="claude"
            failure={row.failure}
            settledNotice={null}
            settledNoticeFindUnitId={null}
          />
        </ChatTranscriptProvider>
      </TabHostProvider>
    </TooltipProvider>,
  );
}

/**
 * The transcript error row reads `lastFailedAttempt` off the same session
 * field the countdown card does - the host defines it during a `hold` too,
 * for the card's own manual rungs (`use-last-failed-attempt.ts`'s module
 * doc). So a row and a live grace card can both have something to render for
 * the identical attempt, and `useChatFallbackTraversalIsLive` is the row's own
 * gate against rendering a SECOND, leaseless copy of the card's controls
 * while the card owns the routing conversation - see `ManualRungActions`'s
 * `if (traversalIsLive) return null;` and its own comment for why the two
 * copies would not simply be redundant (the row's menu is built
 * `preparing={false}` and cannot take the grace-hold lease the card's own
 * menu takes).
 */
describe("ErrorSegment's manual rungs stand down while a fallback traversal is live", () => {
  afterEach(() => {
    fallbackSessionHarness.reset();
    cleanup();
  });

  it("renders the row's own rungs when pendingFallback is undefined", () => {
    fallbackSessionHarness.store.setState({
      lastFailedAttempt: lastFailedAttempt({
        userMessageId: "user-msg-fallback-live-gate",
        turnId: FALLBACK_LIVE_GATE_TURN_ID,
        failure: { reason: "rate_limit" },
        eligibleRungs: ["retry"],
        waitDisposition: "no_verified_reset",
        switchDisposition: "unknown",
        failedTuple: FAILED_CLAUDE_TUPLE,
      }),
      pendingFallback: undefined,
    });

    renderErrorRowWithFallbackAttempt(RATE_LIMIT_ROW);

    expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
  });

  it("does NOT render the row's own rungs while a traversal is live (pendingFallback defined) - ablate the gate and this goes red", () => {
    fallbackSessionHarness.store.setState({
      lastFailedAttempt: lastFailedAttempt({
        userMessageId: "user-msg-fallback-live-gate",
        turnId: FALLBACK_LIVE_GATE_TURN_ID,
        failure: { reason: "rate_limit" },
        eligibleRungs: ["retry"],
        waitDisposition: "no_verified_reset",
        switchDisposition: "unknown",
        failedTuple: FAILED_CLAUDE_TUPLE,
      }),
      pendingFallback: pendingFallback({
        state: "hold",
        reason: "rate_limit",
        failedTuple: FAILED_CLAUDE_TUPLE,
        // A named destination: the countdown has a plan, so the composer draws
        // its routing card and that card owns the conversation.
        targetTuple: TARGET_CODEX_TUPLE,
        impendingAction: null,
        deadline: Date.now() + 60_000,
        attempt: 1,
        maxAttempts: 3,
        queuedItemsMoving: 0,
        siblingSwitching: 0,
        traversalId: "fallback:live-gate",
        revision: 1,
      }),
    });

    renderErrorRowWithFallbackAttempt(RATE_LIMIT_ROW);

    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  // Spec Flow 1: a countdown with nothing to try draws no routing card and "the
  // failed-turn card shows instead". The row must then keep its actions, or the
  // error would sit on screen with no controls anywhere.
  it("keeps the row's own actions for a countdown with nothing to try, which the composer draws no card for", () => {
    fallbackSessionHarness.store.setState({
      lastFailedAttempt: lastFailedAttempt({
        userMessageId: "user-msg-fallback-live-gate",
        turnId: FALLBACK_LIVE_GATE_TURN_ID,
        failure: { reason: "rate_limit" },
        eligibleRungs: ["retry"],
        waitDisposition: "no_verified_reset",
        switchDisposition: "unknown",
        failedTuple: FAILED_CLAUDE_TUPLE,
      }),
      pendingFallback: pendingFallback({
        state: "hold",
        reason: "rate_limit",
        failedTuple: FAILED_CLAUDE_TUPLE,
        targetTuple: null,
        impendingAction: null,
        deadline: Date.now() + 60_000,
        attempt: 1,
        maxAttempts: 3,
        queuedItemsMoving: 0,
        siblingSwitching: 0,
        traversalId: "fallback:live-gate",
        revision: 1,
      }),
    });

    renderErrorRowWithFallbackAttempt(RATE_LIMIT_ROW);

    expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
  });
});

function seedRetryableAttempt(): void {
  fallbackSessionHarness.store.setState({
    lastFailedAttempt: lastFailedAttempt({
      userMessageId: "user-msg-fallback-live-gate",
      turnId: FALLBACK_LIVE_GATE_TURN_ID,
      failure: { reason: "model_unavailable" },
      eligibleRungs: ["retry"],
      waitDisposition: "no_verified_reset",
      switchDisposition: "unknown",
      failedTuple: FAILED_CLAUDE_TUPLE,
    }),
    pendingFallback: undefined,
  });
}

/**
 * The failed-turn card end to end through the transcript row: what a reader
 * sees for each standing, and how a refusal is answered.
 */
describe("ErrorSegment failed-turn card, through the transcript row", () => {
  afterEach(() => {
    fallbackSessionHarness.reset();
    rungAnswer.response = null;
    rungAnswer.toast.mockReset();
    cleanup();
  });

  it("draws exactly one filled button, the lead", () => {
    seedRetryableAttempt();
    renderErrorRowWithFallbackAttempt(RATE_LIMIT_ROW);
    const filled = screen
      .getAllByRole("button")
      .filter((b) => b.getAttribute("data-variant") === "default");
    expect(filled.map((b) => b.textContent)).toEqual(["Retry"]);
  });

  it("answers a refused Retry on the card, never with a toast", () => {
    seedRetryableAttempt();
    rungAnswer.response = { outcome: "rung_unavailable", detail: null };
    renderErrorRowWithFallbackAttempt(RATE_LIMIT_ROW);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(rungAnswer.toast).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe(
      "Couldn't retry just now.",
    );
    // Retry stays enabled: the neutral sentence claims no cause.
    const retry = screen.getByRole("button", { name: "Retry" });
    if (!(retry instanceof HTMLButtonElement)) throw new Error("no Retry");
    expect(retry.disabled).toBe(false);
  });

  it("says the chat moved on and draws no buttons for attempt_not_latest", () => {
    seedRetryableAttempt();
    rungAnswer.response = { outcome: "attempt_not_latest", detail: null };
    renderErrorRowWithFallbackAttempt(RATE_LIMIT_ROW);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByRole("status").textContent).toBe(
      "This chat has moved on since that message. Send a new message to continue.",
    );
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(rungAnswer.toast).not.toHaveBeenCalled();
  });

  it("draws no actions for a viewer of the chat", () => {
    seedRetryableAttempt();
    fallbackSessionHarness.store.setState({ access: { canAct: false } });
    renderErrorRowWithFallbackAttempt(RATE_LIMIT_ROW);
    expect(screen.getByText("Hit a rate limit.")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByText("Reconnecting…")).toBeNull();
  });

  it("shows the actions disabled with Reconnecting… while the stream is not open", () => {
    seedRetryableAttempt();
    fallbackSessionHarness.store.setState({ connectionStatus: "reconnecting" });
    renderErrorRowWithFallbackAttempt(RATE_LIMIT_ROW);
    const retry = screen.getByRole("button", { name: "Retry" });
    if (!(retry instanceof HTMLButtonElement)) throw new Error("no Retry");
    expect(retry.disabled).toBe(true);
    expect(screen.getByText("Reconnecting…")).toBeDefined();
  });

  it("shows the actions disabled with Reconnecting… before the host has said who this reader is", () => {
    seedRetryableAttempt();
    fallbackSessionHarness.store.setState({ access: null });
    renderErrorRowWithFallbackAttempt(RATE_LIMIT_ROW);
    const retry = screen.getByRole("button", { name: "Retry" });
    if (!(retry instanceof HTMLButtonElement)) throw new Error("no Retry");
    expect(retry.disabled).toBe(true);
    expect(screen.getByText("Reconnecting…")).toBeDefined();
  });

  // Spec Flow 4: a sign-out is not gated. The host's eligible actions draw
  // with the ordinary cause ordering - Retry leads and is the only filled
  // button; Switch leads only for rate_limit / billing.
  it("draws the host's eligible actions for a signed-out failure, Retry leading and the only filled button", () => {
    fallbackSessionHarness.store.setState({
      lastFailedAttempt: lastFailedAttempt({
        userMessageId: "user-msg-fallback-live-gate",
        turnId: FALLBACK_LIVE_GATE_TURN_ID,
        failure: {
          reason: "auth",
          resetsAt: new Date(2026, 5, 15, 15, 0, 0).getTime(),
          resetsAtSource: "provider",
        },
        eligibleRungs: ["retry", "switch", "wait_once"],
        waitDisposition: "eligible",
        switchDisposition: "eligible",
        failedTuple: FAILED_CLAUDE_TUPLE,
      }),
    });
    renderErrorRowWithFallbackAttempt({
      code: "auth",
      failure: { reason: "auth" },
    });
    const retry = screen.getByRole("button", { name: "Retry" });
    const wait = screen.getByRole("button", { name: /^Wait until / });
    const switchTo = screen.getByRole("button", { name: "Switch to…" });
    expect(retry.getAttribute("data-variant")).toBe("default");
    expect(wait.getAttribute("data-variant")).toBe("outline");
    expect(switchTo.getAttribute("data-variant")).toBe("outline");
    const filled = screen
      .getAllByRole("button")
      .filter((b) => b.getAttribute("data-variant") === "default");
    expect(filled.map((b) => b.textContent)).toEqual(["Retry"]);
    expect(screen.queryByRole("button", { name: "Model routing" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Model routing" })).toBeNull();
    expect(screen.queryByText("Model routing")).toBeNull();
  });

  // The queue-pause notice is an error block by type only, and the Message
  // Queue panel's paused pill already says it. Even with a live attempt on the
  // same turn - the row every other error block would decorate with actions -
  // it draws nothing at all.
  it("renders nothing for a QUEUE_PAUSED_AFTER_ERROR block, even beside a live failed attempt", () => {
    seedRetryableAttempt();
    const { container } = renderErrorRowWithFallbackAttempt({
      code: QUEUE_PAUSED_AFTER_ERROR_CODE,
      failure: null,
    });
    expect(container.textContent).toBe("");
    expect(screen.queryByText("Hit a rate limit.")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector("[data-failure-presentation]")).toBeNull();
  });

  it("renders a CLAUDE_RUNTIME_DISPOSED block with no typed failure as an interruption headlined Session ended", () => {
    renderErrorRowWithFallbackAttempt({
      code: "CLAUDE_RUNTIME_DISPOSED",
      failure: null,
    });
    const root = screen
      .getByText("Hit a rate limit.")
      .closest("[data-failure-presentation]");
    expect(root?.getAttribute("data-failure-presentation")).toBe("interrupted");
    expect(screen.getByText("Session ended")).toBeDefined();
    // Not the red row: no ERROR overline and no raw code chip.
    expect(screen.queryByText("Error")).toBeNull();
    expect(screen.queryByText("CLAUDE_RUNTIME_DISPOSED")).toBeNull();
    expect(root?.className).toContain("border-warning/30");
  });

  it("keeps the red row for a code the client cannot vouch for", () => {
    renderErrorRowWithFallbackAttempt({
      code: "SOME_OTHER_HOST_CODE",
      failure: null,
    });
    const root = screen
      .getByText("Hit a rate limit.")
      .closest("[data-failure-presentation]");
    expect(root?.getAttribute("data-failure-presentation")).toBe("error");
    expect(screen.queryByText("Session ended")).toBeNull();
  });

  it("lets a typed reason win over the untyped code table", () => {
    renderErrorRowWithFallbackAttempt({
      code: "CLAUDE_RUNTIME_DISPOSED",
      failure: { reason: "request_rejected" },
    });
    const root = screen
      .getByText("Hit a rate limit.")
      .closest("[data-failure-presentation]");
    expect(root?.getAttribute("data-failure-presentation")).toBe("error");
    expect(screen.queryByText("Session ended")).toBeNull();
  });
});
