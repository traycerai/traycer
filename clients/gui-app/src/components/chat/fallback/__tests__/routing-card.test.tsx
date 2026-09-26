import type { ComponentProps } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChatRunSettings,
  FallbackImpendingAction,
  PendingFallback,
  PendingReturn,
} from "@traycer/protocol/host/agent/gui/subscribe";
import {
  RoutingCard,
  type RoutingCardState,
} from "@/components/chat/fallback/routing-card";
import type { RoutingDestinationPicker } from "@/components/chat/fallback/routing-destination-picker";
import { useDismissedRoutingCardsStore } from "@/components/chat/fallback/use-dismissed-routing-cards";
import { TooltipProvider } from "@/components/ui/tooltip";
import { FALLBACK_SETTINGS_SECTION_ID } from "@/lib/settings-sections";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";
import {
  BANNED_VOCABULARY,
  FAILED_CLAUDE_TUPLE,
  PREFERRED_CLAUDE_TUPLE,
  TARGET_CODEX_TUPLE,
  fallbackImpendingAction,
  pendingFallback,
  pendingReturn,
} from "./fallback-fixtures";

// `RoutingCard` is in `REACT_COMPILER_REGRESSION_FILES` (vitest.config.ts), so
// every case here runs the COMPILED component - the mode in which a render-time
// clock read freezes. The drain-bar pins below are the reason that entry exists.

const mocks = vi.hoisted(() => ({
  /** Every mutation the card sends: the host method and its variables. */
  calls: [] as Array<{ readonly method: string; readonly variables: unknown }>,
  openSettings: vi.fn(),
  /** What the host answers each mutation with. */
  outcome: "applied",
  /** Whether the host negotiated `chat.fallback.proceed`. */
  proceedSupported: true,
}));

vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersListForClient: () => ({ data: undefined }),
}));

// `useFallbackModelLabels` alone, as a slug passthrough - the degradation the
// resolver falls back to with no catalogue, so every model string below is the
// fixture's own. The resolver's rules have their own suite.
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

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: () => mocks.proceedSupported,
}));

// The mutation double answers the MUTATION-LEVEL `onSuccess` with the host's
// `outcome`, the way TanStack does: "Sign in instead" is armed on the click and
// run by that callback, so a double that answers nothing cannot express it.
vi.mock("@/hooks/host/use-host-scoped-mutation", () => ({
  useHostScopedMutationForClient: (
    _client: unknown,
    options: {
      readonly method: string;
      readonly onSuccess:
        | ((data: { readonly outcome: string }, variables: unknown) => void)
        | undefined;
    },
  ) => ({
    mutate: (variables: unknown) => {
      mocks.calls.push({ method: options.method, variables });
      options.onSuccess?.({ outcome: mocks.outcome }, variables);
    },
    isPending: false,
  }),
}));

vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ openSettings: mocks.openSettings }),
}));

// The chooser has its own suite. Here it is a button that records what the card
// handed it, carrying the variant it was asked to draw as `data-variant`.
vi.mock("@/components/chat/fallback/routing-destination-picker", () => ({
  RoutingDestinationPicker: (
    props: ComponentProps<typeof RoutingDestinationPicker>,
  ) => (
    <button
      type="button"
      data-testid="picker-trigger"
      data-variant={props.triggerVariant}
      disabled={props.triggerDisabled || !props.canAct}
    >
      {props.triggerLabel}
    </button>
  ),
}));

const TAB_HOST = "tab-host-b";
const APP_HOST = "app-host-a";
const CHAT_ID = "chat-card";
const EPIC_ID = "epic-card";
const TRAVERSAL_ID = "traversal-card";
const REVISION = 7;

function cardPending(input: {
  readonly state: PendingFallback["state"];
  readonly reason: string;
  readonly failedTuple: ChatRunSettings;
  readonly targetTuple: ChatRunSettings | null;
  readonly impendingAction: FallbackImpendingAction | null;
  readonly deadline: number | null;
}): PendingFallback {
  return pendingFallback({
    state: input.state,
    reason: input.reason,
    failedTuple: input.failedTuple,
    targetTuple: input.targetTuple,
    impendingAction: input.impendingAction,
    deadline: input.deadline,
    attempt: 1,
    maxAttempts: 3,
    queuedItemsMoving: 2,
    siblingSwitching: 0,
    traversalId: TRAVERSAL_ID,
    revision: REVISION,
  });
}

/** A hold that will switch to the codex target: the countdown's "switch" plan. */
function switchHold(deadlineInMs: number): PendingFallback {
  return cardPending({
    state: "hold",
    reason: "rate_limit",
    failedTuple: FAILED_CLAUDE_TUPLE,
    targetTuple: TARGET_CODEX_TUPLE,
    impendingAction: null,
    deadline: Date.now() + deadlineInMs,
  });
}

/** A hold whose plan is to park until the limit resets: the "wait" plan. */
function waitHold(deadlineInMs: number): PendingFallback {
  return cardPending({
    state: "hold",
    reason: "rate_limit",
    failedTuple: FAILED_CLAUDE_TUPLE,
    targetTuple: null,
    impendingAction: fallbackImpendingAction({
      planId: "plan-wait",
      rung: "wait",
      target: null,
      targetModelFamily: null,
      resumesAt: Date.now() + 3_600_000,
      pending: null,
    }),
    deadline: Date.now() + deadlineInMs,
  });
}

/** A hold whose plan the host has not resolved yet: the "deciding" plan. */
function decidingHold(): PendingFallback {
  return cardPending({
    state: "hold",
    reason: "rate_limit",
    failedTuple: FAILED_CLAUDE_TUPLE,
    targetTuple: null,
    impendingAction: fallbackImpendingAction({
      planId: "plan-deciding",
      rung: "profile",
      target: null,
      targetModelFamily: null,
      resumesAt: null,
      pending: "resolving",
    }),
    deadline: Date.now() + 12_000,
  });
}

function authHold(): PendingFallback {
  return cardPending({
    state: "hold",
    reason: "auth",
    failedTuple: FAILED_CLAUDE_TUPLE,
    targetTuple: TARGET_CODEX_TUPLE,
    impendingAction: null,
    deadline: Date.now() + 12_000,
  });
}

function switchingPending(deadline: number | null): PendingFallback {
  return cardPending({
    state: "switching",
    reason: "rate_limit",
    failedTuple: FAILED_CLAUDE_TUPLE,
    targetTuple: TARGET_CODEX_TUPLE,
    impendingAction: null,
    deadline,
  });
}

function waitingPending(): PendingFallback {
  return cardPending({
    state: "waiting",
    reason: "rate_limit",
    failedTuple: FAILED_CLAUDE_TUPLE,
    targetTuple: null,
    impendingAction: null,
    deadline: Date.now() + 3_600_000,
  });
}

function returnOffer(): PendingReturn {
  return pendingReturn({
    preferredTuple: PREFERRED_CLAUDE_TUPLE,
    fallbackTuple: TARGET_CODEX_TUPLE,
    queuedItemsMoving: 2,
    traversalId: TRAVERSAL_ID,
    revision: REVISION,
  });
}

function renderCard(input: {
  readonly state: RoutingCardState;
  readonly canAct: boolean;
}) {
  return render(
    <TooltipProvider delayDuration={0}>
      <RoutingCard
        state={input.state}
        client={null}
        chatId={CHAT_ID}
        epicId={EPIC_ID}
        hostId={TAB_HOST}
        canAct={input.canAct}
      />
    </TooltipProvider>,
  );
}

function renderCountdown(pending: PendingFallback, canAct: boolean) {
  return renderCard({ state: { kind: "countdown", pending }, canAct });
}

function renderWaiting(pending: PendingFallback, canAct: boolean) {
  return renderCard({ state: { kind: "waiting", pending }, canAct });
}

function renderReturn(canAct: boolean) {
  return renderCard({
    state: { kind: "return", offer: returnOffer(), lowUsage: null },
    canAct,
  });
}

/** The card's action row - the two (or three) buttons, never the route line. */
function actionRow(): HTMLElement {
  return screen.getByTestId("routing-action-row");
}

function actionButton(name: string | RegExp): HTMLButtonElement {
  const button = within(actionRow()).getByRole("button", { name });
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("expected the action to be a <button>");
  }
  return button;
}

function actionLabels(): ReadonlyArray<string> {
  return within(actionRow())
    .getAllByRole("button")
    .map((button) => button.textContent);
}

function variantOf(element: HTMLElement): string | null {
  return element.getAttribute("data-variant");
}

function fillWidthPercent(): number {
  const width = screen.getByTestId("routing-drain-fill").style.width;
  const match = width.match(/^(\d+(?:\.\d+)?)%$/);
  if (match === null) {
    throw new Error(
      `expected a percent width on the drain fill, got "${width}"`,
    );
  }
  return Number(match[1]);
}

function sentCalls(method: string): ReadonlyArray<unknown> {
  return mocks.calls
    .filter((call) => call.method === method)
    .map((call) => call.variables);
}

const FRAME_VARIABLES = {
  epicId: EPIC_ID,
  chatId: CHAT_ID,
  traversalId: TRAVERSAL_ID,
  revision: REVISION,
};

describe("RoutingCard", () => {
  beforeEach(() => {
    mocks.calls = [];
    mocks.openSettings.mockReset();
    mocks.outcome = "applied";
    mocks.proceedSupported = true;
    useDismissedRoutingCardsStore.setState({ dismissed: new Set() });
    useSettingsHostScopeStore.getState().setScopedHostId(APP_HOST);
  });

  afterEach(() => {
    cleanup();
    useSettingsHostScopeStore.getState().setScopedHostId(null);
    // A case that fails mid-test can exit before its own `useRealTimers`, and
    // fake timers would leak into every later case.
    vi.useRealTimers();
  });

  describe("the two buttons per state", () => {
    it("countdown switch: Switch now (default) and Don't switch (outline)", () => {
      renderCountdown(switchHold(12_000), true);
      expect(actionLabels()).toEqual(["Switch now", "Don't switch"]);
      expect(variantOf(actionButton("Switch now"))).toBe("default");
      expect(variantOf(actionButton("Don't switch"))).toBe("outline");
      expect(screen.getByTestId("routing-card").textContent).not.toMatch(
        BANNED_VOCABULARY,
      );
    });

    it("countdown wait: Wait now (default) and Don't wait (outline)", () => {
      renderCountdown(waitHold(12_000), true);
      expect(actionLabels()).toEqual(["Wait now", "Don't wait"]);
      expect(variantOf(actionButton("Wait now"))).toBe("default");
      expect(variantOf(actionButton("Don't wait"))).toBe("outline");
    });

    it("waiting: Choose another model… (the picker trigger, default) and Stop waiting (outline)", () => {
      renderWaiting(waitingPending(), true);
      expect(actionLabels()).toEqual(["Choose another model…", "Stop waiting"]);
      const chooser = actionButton("Choose another model…");
      // The card hands its picker the filled variant; this is the one card
      // whose picker has a button rather than a chip.
      expect(chooser.getAttribute("data-testid")).toBe("picker-trigger");
      expect(variantOf(chooser)).toBe("default");
      expect(variantOf(actionButton("Stop waiting"))).toBe("outline");
    });

    it("return: Switch back (default), Stay on X and Don't ask for this chat (both outline)", () => {
      renderReturn(true);
      expect(actionLabels()).toEqual([
        "Switch back",
        "Stay on Codex · gpt-5",
        "Don't ask for this chat",
      ]);
      expect(variantOf(actionButton("Switch back"))).toBe("default");
      expect(variantOf(actionButton(/^Stay on /))).toBe("outline");
      expect(variantOf(actionButton("Don't ask for this chat"))).toBe(
        "outline",
      );
    });
  });

  describe("the actions", () => {
    it("Switch now sends chat.fallback.proceed with the frame's traversal and revision", () => {
      renderCountdown(switchHold(12_000), true);
      fireEvent.click(actionButton("Switch now"));
      expect(mocks.calls).toEqual([
        { method: "chat.fallback.proceed", variables: FRAME_VARIABLES },
      ]);
    });

    it("Wait now sends chat.fallback.proceed with the frame's traversal and revision", () => {
      renderCountdown(waitHold(12_000), true);
      fireEvent.click(actionButton("Wait now"));
      expect(mocks.calls).toEqual([
        { method: "chat.fallback.proceed", variables: FRAME_VARIABLES },
      ]);
    });

    it("Don't switch, Don't wait and Stop waiting each send chat.fallback.cancel, never proceed", () => {
      const first = renderCountdown(switchHold(12_000), true);
      fireEvent.click(actionButton("Don't switch"));
      first.unmount();
      const second = renderCountdown(waitHold(12_000), true);
      fireEvent.click(actionButton("Don't wait"));
      second.unmount();
      renderWaiting(waitingPending(), true);
      fireEvent.click(actionButton("Stop waiting"));
      expect(sentCalls("chat.fallback.cancel")).toEqual([
        FRAME_VARIABLES,
        FRAME_VARIABLES,
        FRAME_VARIABLES,
      ]);
      expect(sentCalls("chat.fallback.proceed")).toEqual([]);
    });

    it("the return buttons send returnToPreferred with switch_back, stay and dismiss_for_chat", () => {
      renderReturn(true);
      fireEvent.click(actionButton("Switch back"));
      fireEvent.click(actionButton(/^Stay on /));
      fireEvent.click(actionButton("Don't ask for this chat"));
      expect(sentCalls("chat.fallback.returnToPreferred")).toEqual([
        { ...FRAME_VARIABLES, action: "switch_back" },
        { ...FRAME_VARIABLES, action: "stay" },
        { ...FRAME_VARIABLES, action: "dismiss_for_chat" },
      ]);
    });

    it("draws no primary when chat.fallback.proceed is unsupported, and keeps the refusal", () => {
      mocks.proceedSupported = false;
      const first = renderCountdown(switchHold(12_000), true);
      // Falsification: drop the `proceedSupported` gate in the countdown card
      // and this row grows a "Switch now" that calls a method the host lacks.
      expect(actionLabels()).toEqual(["Don't switch"]);
      expect(variantOf(actionButton("Don't switch"))).toBe("outline");
      first.unmount();

      renderCountdown(waitHold(12_000), true);
      expect(actionLabels()).toEqual(["Don't wait"]);
    });

    it("an auth cause draws Sign in instead as the refusal, and no Don't switch", () => {
      renderCountdown(authHold(), true);
      expect(actionLabels()).toEqual(["Switch now", "Sign in instead"]);
      expect(variantOf(actionButton("Switch now"))).toBe("default");
      expect(variantOf(actionButton("Sign in instead"))).toBe("outline");
      expect(screen.queryByRole("button", { name: "Don't switch" })).toBeNull();
    });

    it("Sign in instead cancels first, then opens Providers only once the host applied it", () => {
      renderCountdown(authHold(), true);
      mocks.outcome = "stale";
      fireEvent.click(actionButton("Sign in instead"));
      expect(sentCalls("chat.fallback.cancel")).toEqual([FRAME_VARIABLES]);
      expect(mocks.openSettings).not.toHaveBeenCalled();

      mocks.outcome = "applied";
      fireEvent.click(actionButton("Sign in instead"));
      expect(mocks.openSettings).toHaveBeenCalledTimes(1);
      expect(mocks.openSettings).toHaveBeenCalledWith(
        expect.objectContaining({ section: "providers" }),
      );
      expect(useSettingsHostScopeStore.getState().scopedHostId).toBe(TAB_HOST);
    });
  });

  describe("the drain bar", () => {
    it("follows the clock snapshot: the fill narrows tick by tick under the compiler", () => {
      vi.useFakeTimers();
      renderCountdown(switchHold(12_000), true);
      expect(screen.getByTestId("routing-drain-bar")).toBeDefined();
      const start = fillWidthPercent();
      // A card mounted at the start of its window drains from full (the shared
      // clock's sample can trail the wall clock by a few ms).
      expect(start).toBeGreaterThan(99);

      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      const afterOne = fillWidthPercent();
      // Falsification: read the clock at render time (not through the
      // `useSyncExternalStore` snapshot) and the compiled component memoizes
      // the first width, so this stays at 100.
      expect(afterOne).toBeLessThan(start);

      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      const afterSix = fillWidthPercent();
      expect(afterSix).toBeLessThan(afterOne);
      // remaining / total: 6s of a 12s window is half.
      expect(afterSix).toBeCloseTo(50, 0);
    });

    it("moves with the headline's own countdown, not apart from it", () => {
      vi.useFakeTimers();
      renderCountdown(switchHold(12_000), true);
      expect(screen.getByTestId("routing-card-headline").textContent).toBe(
        "Switching in 12s",
      );
      act(() => {
        vi.advanceTimersByTime(4_000);
      });
      expect(screen.getByTestId("routing-card-headline").textContent).toBe(
        "Switching in 8s",
      );
      expect(fillWidthPercent()).toBeCloseTo((8 / 12) * 100, 0);
    });

    it("draws no bar once the traversal has committed to switching", () => {
      renderCountdown(switchingPending(Date.now() + 12_000), true);
      expect(screen.queryByTestId("routing-drain-bar")).toBeNull();
    });
  });

  describe("when the card cannot act", () => {
    it("says Reconnecting… and disables every action, but not the hide control", () => {
      renderCountdown(switchHold(12_000), false);
      expect(screen.getByTestId("routing-action-note").textContent).toBe(
        "Reconnecting…",
      );
      expect(actionButton("Switch now").disabled).toBe(true);
      expect(actionButton("Don't switch").disabled).toBe(true);
      expect(screen.getByRole("button", { name: "Hide" })).toHaveProperty(
        "disabled",
        false,
      );
      fireEvent.click(actionButton("Switch now"));
      expect(mocks.calls).toEqual([]);
    });

    it("waiting and return say Reconnecting… and disable their buttons too", () => {
      const first = renderWaiting(waitingPending(), false);
      expect(screen.getByTestId("routing-action-note").textContent).toBe(
        "Reconnecting…",
      );
      expect(actionButton("Choose another model…").disabled).toBe(true);
      expect(actionButton("Stop waiting").disabled).toBe(true);
      first.unmount();

      renderReturn(false);
      expect(screen.getByTestId("routing-action-note").textContent).toBe(
        "Reconnecting…",
      );
      for (const button of within(actionRow()).getAllByRole("button")) {
        expect(button).toHaveProperty("disabled", true);
      }
    });

    it("draws no note while it can act", () => {
      renderCountdown(switchHold(12_000), true);
      expect(screen.queryByTestId("routing-action-note")).toBeNull();
    });
  });

  describe("a plan the host has not resolved", () => {
    it("says Deciding what to do…, offers no primary, and disables the row with a Deciding… note", () => {
      renderCountdown(decidingHold(), true);
      expect(screen.getByTestId("routing-card-headline").textContent).toBe(
        "Deciding what to do…",
      );
      expect(actionLabels()).toEqual(["Don't switch"]);
      expect(actionButton("Don't switch").disabled).toBe(true);
      expect(screen.getByTestId("routing-action-note").textContent).toBe(
        "Deciding…",
      );
    });

    it("shows one tuple and nothing to click on the route line", () => {
      renderCountdown(decidingHold(), true);
      const line = screen.getByTestId("route-line");
      expect(within(line).getByTestId("route-chip-single")).toBeDefined();
      expect(within(line).queryByRole("button")).toBeNull();
    });
  });

  describe("once the traversal has committed", () => {
    it("says Switching… and disables the row, with no Reconnecting… note", () => {
      renderCountdown(switchingPending(null), true);
      expect(screen.getByTestId("routing-card-headline").textContent).toBe(
        "Switching…",
      );
      expect(actionButton("Switch now").disabled).toBe(true);
      expect(actionButton("Don't switch").disabled).toBe(true);
      expect(screen.queryByTestId("routing-action-note")).toBeNull();
    });
  });

  describe("the route line", () => {
    it("countdown switch: a from chip, and the picker as the to end", () => {
      renderCountdown(switchHold(12_000), true);
      const line = screen.getByTestId("route-line");
      expect(within(line).getByTestId("route-chip-from")).toBeDefined();
      // The destination is the picker's trigger, not a static chip.
      expect(within(line).queryByTestId("route-chip-to")).toBeNull();
      const trigger = within(line).getByTestId("picker-trigger");
      expect(trigger.getAttribute("data-variant")).toBe("route-chip");
      expect(trigger.textContent).toContain("gpt-5");
    });

    it("countdown wait: one chip, and a Choose another model… chip beside it", () => {
      renderCountdown(waitHold(12_000), true);
      const line = screen.getByTestId("route-line");
      expect(within(line).getByTestId("route-chip-single")).toBeDefined();
      const chooser = within(line).getByRole("button", {
        name: "Choose another model…",
      });
      expect(variantOf(chooser)).toBe("route-chip");
    });

    it("waiting: one chip carrying the same-session pill", () => {
      renderWaiting(waitingPending(), true);
      const line = screen.getByTestId("route-line");
      expect(within(line).getByTestId("route-chip-single")).toBeDefined();
      expect(line.textContent).toContain("same settings, same session");
    });

    it("return: from the current account back to the preferred one, both static chips", () => {
      renderReturn(true);
      const line = screen.getByTestId("route-line");
      const from = within(line).getByTestId("route-chip-from");
      const to = within(line).getByTestId("route-chip-to");
      // The route runs the other way: where the chat is now, then where it
      // started.
      expect(from.textContent).toContain("gpt-5");
      expect(to.textContent).toContain("claude-sonnet-4");
      expect(
        from.compareDocumentPosition(to) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });
  });

  describe("the status line", () => {
    it("the gear opens routing settings on the chat's own host", () => {
      renderCountdown(switchHold(12_000), true);
      fireEvent.click(
        screen.getByRole("button", { name: "Model routing settings" }),
      );
      expect(useSettingsHostScopeStore.getState().scopedHostId).toBe(TAB_HOST);
      expect(mocks.openSettings).toHaveBeenCalledWith({
        section: FALLBACK_SETTINGS_SECTION_ID,
        resetToGeneral: false,
        tab: null,
        draft: null,
        hostId: null,
      });
    });

    it("names the failed account, and the return card carries neither gear nor hide", () => {
      const first = renderCountdown(switchHold(12_000), true);
      expect(screen.getByTestId("routing-status-line").textContent).toContain(
        "Claude Code · failed01",
      );
      first.unmount();

      renderReturn(true);
      expect(
        screen.queryByRole("button", { name: "Model routing settings" }),
      ).toBeNull();
      expect(screen.queryByRole("button", { name: "Hide" })).toBeNull();
    });

    it("Hide carries the tooltip 'Hide. Routing continues.' and hides without cancelling", async () => {
      renderCountdown(switchHold(12_000), true);
      const hide = screen.getByRole("button", { name: "Hide" });
      fireEvent.focus(hide);
      const tooltip = await screen.findByRole("tooltip");
      expect(tooltip.textContent).toBe("Hide. Routing continues.");

      fireEvent.click(hide);
      // Recorded under the frame's own traversal, card and plan...
      expect(useDismissedRoutingCardsStore.getState().dismissed).toEqual(
        new Set([`${CHAT_ID}:${TRAVERSAL_ID}:countdown:none`]),
      );
      // ...and it is not an answer to the card's question.
      expect(mocks.calls).toEqual([]);
    });

    it("the waiting card hides under its own card kind", () => {
      renderWaiting(waitingPending(), true);
      fireEvent.click(screen.getByRole("button", { name: "Hide" }));
      expect(useDismissedRoutingCardsStore.getState().dismissed).toEqual(
        new Set([`${CHAT_ID}:${TRAVERSAL_ID}:waiting:none`]),
      );
      expect(mocks.calls).toEqual([]);
    });
  });
});
