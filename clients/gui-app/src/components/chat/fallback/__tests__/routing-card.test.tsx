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
import { TooltipProvider } from "@/components/ui/tooltip";
import { formatWaitTime } from "@/lib/relative-time";
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

/**
 * A hold whose plan is to park until the limit resets: the "wait" plan, with
 * the reset the host predicted (or `null` when it has none).
 */
function waitHoldResuming(
  deadlineInMs: number,
  resumesAt: number | null,
): PendingFallback {
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
      resumesAt,
      pending: null,
    }),
    deadline: Date.now() + deadlineInMs,
  });
}

/** The "wait" plan with a reset an hour out. */
function waitHold(deadlineInMs: number): PendingFallback {
  return waitHoldResuming(deadlineInMs, Date.now() + 3_600_000);
}

/** A hold whose destination IS the tuple that failed: the "resume" plan. */
function resumeHold(): PendingFallback {
  return cardPending({
    state: "hold",
    reason: "rate_limit",
    failedTuple: FAILED_CLAUDE_TUPLE,
    targetTuple: FAILED_CLAUDE_TUPLE,
    impendingAction: null,
    deadline: Date.now() + 12_000,
  });
}

/** A hold with no destination and no planned step: the "nothing" plan. */
function nothingHold(): PendingFallback {
  return cardPending({
    state: "hold",
    reason: "rate_limit",
    failedTuple: FAILED_CLAUDE_TUPLE,
    targetTuple: null,
    impendingAction: null,
    deadline: Date.now() + 12_000,
  });
}

/** The same frame with its two counts set: the only inputs to the cost line. */
function withCounts(
  pending: PendingFallback,
  queuedItemsMoving: number,
  siblingSwitching: number,
): PendingFallback {
  return { ...pending, queuedItemsMoving, siblingSwitching };
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

function returnOfferMoving(queuedItemsMoving: number): PendingReturn {
  return pendingReturn({
    preferredTuple: PREFERRED_CLAUDE_TUPLE,
    fallbackTuple: TARGET_CODEX_TUPLE,
    queuedItemsMoving,
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

function renderReturnMoving(queuedItemsMoving: number, canAct: boolean) {
  return renderCard({
    state: {
      kind: "return",
      offer: returnOfferMoving(queuedItemsMoving),
      lowUsage: null,
    },
    canAct,
  });
}

function renderReturn(canAct: boolean) {
  return renderReturnMoving(2, canAct);
}

/** Every button on the card whose accessible name says "hide". */
function hideButtons(): ReadonlyArray<HTMLElement> {
  return screen.queryAllByRole("button", { name: /hide/i });
}

function cardText(): string {
  return screen.getByTestId("routing-card").textContent;
}

/** Every countdown plan the card can draw, built at the default counts. */
const COUNTDOWN_PLANS: ReadonlyArray<{
  readonly name: string;
  readonly build: () => PendingFallback;
}> = [
  { name: "switch", build: () => switchHold(12_000) },
  { name: "wait", build: () => waitHold(12_000) },
  { name: "resume", build: resumeHold },
  { name: "deciding", build: decidingHold },
  { name: "nothing", build: nothingHold },
];

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

    it("countdown wait: Choose another model… (the picker trigger, default) then Don't wait (outline), and no Wait now", () => {
      renderCountdown(waitHold(12_000), true);
      // Order is the assertion: the filled picker first, the refusal second.
      expect(actionLabels()).toEqual(["Choose another model…", "Don't wait"]);
      const chooser = actionButton("Choose another model…");
      expect(chooser.getAttribute("data-testid")).toBe("picker-trigger");
      expect(variantOf(chooser)).toBe("default");
      expect(variantOf(actionButton("Don't wait"))).toBe("outline");
      // Falsification: bring the "Wait now" button back and both the label
      // list above and this query go red.
      expect(screen.queryByRole("button", { name: /wait now/i })).toBeNull();
    });

    it("a wait resuming onto the failed tuple: no primary, and the refusal is Stop waiting", () => {
      renderCountdown(
        cardPending({
          state: "switching",
          reason: "rate_limit",
          failedTuple: FAILED_CLAUDE_TUPLE,
          targetTuple: FAILED_CLAUDE_TUPLE,
          impendingAction: null,
          deadline: null,
        }),
        true,
      );
      expect(screen.getByTestId("routing-card-headline").textContent).toBe(
        "Resuming now…",
      );
      // Falsification: map the resume plan to "Don't switch" and this names a
      // switch that is not happening (seen live under "Resuming now…").
      expect(actionLabels()).toEqual(["Stop waiting"]);
      expect(variantOf(actionButton("Stop waiting"))).toBe("outline");
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

    it("return: exactly two buttons, Switch back (default) and Stay on X (outline)", () => {
      renderReturn(true);
      expect(actionLabels()).toEqual(["Switch back", "Stay on Codex · gpt-5"]);
      expect(variantOf(actionButton("Switch back"))).toBe("default");
      expect(variantOf(actionButton("Stay on Codex · gpt-5"))).toBe("outline");
      // Falsification: restore the third button and the label list above
      // grows, and this query finds it.
      expect(
        screen.queryByRole("button", { name: /don't ask for this chat/i }),
      ).toBeNull();
      expect(within(actionRow()).getAllByRole("button")).toHaveLength(2);
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

    it("the return buttons send returnToPreferred with switch_back and stay, and nothing ever sends dismiss_for_chat", () => {
      renderReturn(true);
      for (const button of within(actionRow()).getAllByRole("button")) {
        fireEvent.click(button);
      }
      expect(sentCalls("chat.fallback.returnToPreferred")).toEqual([
        { ...FRAME_VARIABLES, action: "switch_back" },
        { ...FRAME_VARIABLES, action: "stay" },
      ]);
      // Falsification: re-add the per-chat button and its click sends the
      // third verb, which this catches on the recorded wire payloads.
      expect(JSON.stringify(mocks.calls)).not.toContain("dismiss_for_chat");
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
      // The wait's filled button is the picker, which does not call
      // `chat.fallback.proceed`, so the gate leaves it drawn.
      expect(actionLabels()).toEqual(["Choose another model…", "Don't wait"]);
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

    it("opens full on the first countdown after the second clock sat idle", () => {
      vi.useFakeTimers();
      // An earlier countdown ran and ended; unmounting stops the clock with
      // its last sample standing.
      renderCountdown(switchHold(12_000), true).unmount();
      // Minutes pass with no countdown mounted, so nothing re-takes it.
      vi.setSystemTime(Date.now() + 6 * 60_000);
      renderCountdown(switchHold(15_000), true);
      // Falsification: render the first frame from the idle sample and the bar
      // latches 6m 15s as the window's length, opening 4% full (seen live).
      expect(fillWidthPercent()).toBeGreaterThan(99);
      expect(screen.getByTestId("routing-card-headline").textContent).toBe(
        "Switching in 15s",
      );
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

  describe("the waiting headline", () => {
    it("keeps its live region across the deadline", () => {
      vi.useFakeTimers();
      renderWaiting(
        cardPending({
          state: "waiting",
          reason: "rate_limit",
          failedTuple: FAILED_CLAUDE_TUPLE,
          targetTuple: null,
          impendingAction: null,
          deadline: Date.now() + 60_000,
        }),
        true,
      );
      const region = within(
        screen.getByTestId("routing-card-headline"),
      ).getByRole("status");
      expect(region.textContent).toMatch(/^Resuming at/);

      act(() => {
        vi.advanceTimersByTime(61_000);
      });

      const after = within(
        screen.getByTestId("routing-card-headline"),
      ).getByRole("status");
      expect(after).toBe(region);
      expect(region.textContent).toBe("Resuming shortly…");
    });
  });

  describe("when the card cannot act", () => {
    it("says Reconnecting… and disables every action", () => {
      renderCountdown(switchHold(12_000), false);
      expect(screen.getByTestId("routing-action-note").textContent).toBe(
        "Reconnecting…",
      );
      expect(actionButton("Switch now").disabled).toBe(true);
      expect(actionButton("Don't switch").disabled).toBe(true);
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

    it("countdown wait: a single chip that is not a picker trigger", () => {
      renderCountdown(waitHold(12_000), true);
      const line = screen.getByTestId("route-line");
      expect(within(line).getByTestId("route-chip-single")).toBeDefined();
      // The wait's picker is the action row's filled button; nothing on the
      // route line is clickable, and no picker trigger sits on it.
      expect(within(line).queryByRole("button")).toBeNull();
      expect(within(line).queryByTestId("picker-trigger")).toBeNull();
      expect(screen.getAllByTestId("picker-trigger")).toHaveLength(1);
    });

    it("waiting: one chip, and never the same-session badge", () => {
      renderWaiting(waitingPending(), true);
      const line = screen.getByTestId("route-line");
      expect(within(line).getByTestId("route-chip-single")).toBeDefined();
      // Falsification: restore the badge and either text check goes red.
      expect(line.textContent).not.toMatch(/same settings, same session/i);
      expect(cardText()).not.toMatch(/same settings|same session/i);
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

    it("names the failed account, and the return card carries no gear", () => {
      const first = renderCountdown(switchHold(12_000), true);
      expect(screen.getByTestId("routing-status-line").textContent).toContain(
        "Claude Code · failed01",
      );
      first.unmount();

      renderReturn(true);
      expect(
        screen.queryByRole("button", { name: "Model routing settings" }),
      ).toBeNull();
    });
  });

  describe("no hide control", () => {
    // Falsification for every case here: restore the Hide icon button and
    // `hideButtons()` finds it.
    for (const plan of COUNTDOWN_PLANS) {
      it(`the countdown card draws no Hide button on the ${plan.name} plan`, () => {
        renderCountdown(plan.build(), true);
        expect(hideButtons()).toEqual([]);
        expect(cardText()).not.toMatch(/hide|routing continues/i);
      });
    }

    it("draws none while choosing or switching either", () => {
      const choosing: PendingFallback = {
        ...switchHold(12_000),
        state: "choosing",
        graceRemainingMs: 5_000,
      };
      const first = renderCountdown(choosing, true);
      expect(screen.getByTestId("routing-card-headline").textContent).toBe(
        "Paused while you choose",
      );
      expect(hideButtons()).toEqual([]);
      first.unmount();

      renderCountdown(switchingPending(null), true);
      expect(screen.getByTestId("routing-card-headline").textContent).toBe(
        "Switching…",
      );
      expect(hideButtons()).toEqual([]);
    });

    it("draws none on the waiting card, and the reader who cannot act sees none either", () => {
      const first = renderWaiting(waitingPending(), true);
      expect(hideButtons()).toEqual([]);
      first.unmount();

      renderWaiting(waitingPending(), false);
      expect(hideButtons()).toEqual([]);
    });

    it("draws none on the return card", () => {
      renderReturn(true);
      expect(hideButtons()).toEqual([]);
    });
  });

  describe("the countdown cost line", () => {
    it("switch: only the count clauses, exactly", () => {
      renderCountdown(withCounts(switchHold(12_000), 2, 1), true);
      expect(screen.getByTestId("routing-cost-line").textContent).toBe(
        "2 queued messages move with it · 1 other chat in this task is also switching",
      );
    });

    it("switch: the singular queued clause, and siblings alone", () => {
      const first = renderCountdown(withCounts(switchHold(12_000), 1, 0), true);
      expect(screen.getByTestId("routing-cost-line").textContent).toBe(
        "1 queued message moves with it",
      );
      first.unmount();

      renderCountdown(withCounts(switchHold(12_000), 0, 3), true);
      expect(screen.getByTestId("routing-cost-line").textContent).toBe(
        "3 other chats in this task are also switching",
      );
    });

    it("wait: queued messages wait with it", () => {
      renderCountdown(withCounts(waitHold(12_000), 3, 0), true);
      expect(screen.getByTestId("routing-cost-line").textContent).toBe(
        "3 queued messages wait with it",
      );
    });

    it("draws no cost-line element at all when every count is zero, on every plan", () => {
      for (const plan of COUNTDOWN_PLANS) {
        const view = renderCountdown(withCounts(plan.build(), 0, 0), true);
        // Falsification: draw the line unconditionally (an empty div, or the
        // old helper sentence) and the element comes back.
        expect(screen.queryByTestId("routing-cost-line")).toBeNull();
        view.unmount();
      }
    });

    it("never carries the helper sentence, whatever the plan and counts", () => {
      for (const plan of COUNTDOWN_PLANS) {
        const view = renderCountdown(withCounts(plan.build(), 2, 1), true);
        expect(cardText()).not.toMatch(/New session from this transcript/i);
        expect(cardText()).not.toMatch(/click the destination/i);
        view.unmount();
      }
    });
  });

  describe("the countdown headline carries the wait's time", () => {
    it("Waiting until <time> starts in 12s, with the time from formatWaitTime", () => {
      vi.useFakeTimers();
      const resumesAt = Date.now() + 3_600_000;
      renderCountdown(waitHoldResuming(12_000, resumesAt), true);
      const expected = `Waiting until ${formatWaitTime(resumesAt, Date.now())} starts in 12s`;
      expect(screen.getByTestId("routing-card-headline").textContent).toBe(
        expected,
      );
      // The time is in the headline and nowhere else: no separate badge.
      // Falsification: bring the clock badge back and "until" appears twice.
      expect(cardText().match(/until/g)).toHaveLength(1);
      expect(
        within(screen.getByTestId("route-line")).queryByText(/until/),
      ).toBeNull();
    });

    it("with no reset time: Waiting starts in 12s, and no 'until' anywhere", () => {
      vi.useFakeTimers();
      renderCountdown(waitHoldResuming(12_000, null), true);
      expect(screen.getByTestId("routing-card-headline").textContent).toBe(
        "Waiting starts in 12s",
      );
      expect(cardText()).not.toMatch(/until/);
    });
  });

  describe("the return card's cost line", () => {
    it("says only that the queued messages move back, when there are some", () => {
      renderReturnMoving(2, true);
      expect(screen.getByTestId("routing-cost-line").textContent).toBe(
        "moves 2 queued messages back",
      );
    });

    it("draws no cost line at zero", () => {
      renderReturnMoving(0, true);
      expect(screen.queryByTestId("routing-cost-line")).toBeNull();
    });

    it("carries neither the next-message sentence nor the new-session sentence", () => {
      for (const count of [0, 2]) {
        const view = renderReturnMoving(count, true);
        // Falsification: restore the old cost line and both go red.
        expect(cardText()).not.toMatch(/Applies to your next message/i);
        expect(cardText()).not.toMatch(/New session from this transcript/i);
        view.unmount();
      }
    });
  });
});
