import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChatRunSettings,
  FallbackImpendingAction,
  PendingFallback,
} from "@traycer/protocol/host/agent/gui/subscribe";
import { FallbackGraceCard } from "@/components/chat/fallback/fallback-grace-card";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";
import { formatClockTime, formatResetDateTime } from "@/lib/relative-time";
import {
  BANNED_VOCABULARY,
  FAILED_CLAUDE_TUPLE,
  TARGET_CODEX_TUPLE,
  chatRunSettings,
  fallbackImpendingAction,
  pendingFallback,
} from "./fallback-fixtures";

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  openSettings: vi.fn(),
  /** The `outcome` the mocked mutation answers with. See the mock below. */
  outcome: "applied",
  /**
   * When true, `mutate` CAPTURES the mutation-level `onSuccess` instead of
   * invoking it synchronously. The applied-after-unmount case's whole point
   * is that TanStack - not this component - decides WHEN that callback runs,
   * and a double that always answers inline cannot model a callback that
   * fires after the caller is gone.
   */
  deferOnSuccess: false,
  capturedOnSuccess: null as (() => void) | null,
}));

vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersListForClient: () => ({ data: undefined }),
}));

/**
 * The double delivers the host's answer to the MUTATION-LEVEL `onSuccess`.
 *
 * It used to be a bare `mutate: vi.fn()` that recorded the call and answered
 * nothing, which was sufficient only while "Sign in instead" opened Settings
 * synchronously in its click handler. F8 moved that navigation to the
 * mutation-level `onSuccess`, gated on `outcome === "applied"`, precisely
 * because an applied cancel settles the traversal and unmounts this card - so
 * a per-call handler never runs, and the user was left in a chat that had
 * already switched with Settings never opening.
 *
 * A double that answers nothing therefore cannot express the fixed behaviour:
 * it reports "cancel" and stops, which is indistinguishable from the bug. It
 * models the real signature - `onSuccess(data, variables)` - for the same
 * reason `fallback-manual-rungs.test.tsx` does: a double that under-models a
 * callback is invisible until production reads the argument it omitted, and
 * then it fails as a `TypeError` inside production code.
 */
vi.mock("@/hooks/host/use-host-scoped-mutation", () => ({
  useHostScopedMutationForClient: (
    _client: unknown,
    options: {
      readonly onSuccess:
        | ((data: { readonly outcome: string }, variables: unknown) => void)
        | undefined;
    },
  ) => ({
    mutate: (variables: unknown) => {
      mocks.mutate(variables);
      // `applied` by default: the arm every caller in this file drives. A case
      // needing a refusal sets `mocks.outcome` before clicking.
      if (mocks.deferOnSuccess) {
        mocks.capturedOnSuccess = () => {
          options.onSuccess?.({ outcome: mocks.outcome }, variables);
        };
        return;
      }
      options.onSuccess?.({ outcome: mocks.outcome }, variables);
    },
    isPending: false,
  }),
}));

vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ openSettings: mocks.openSettings }),
}));

const TAB_HOST = "tab-host-b";
const APP_HOST = "app-host-a";

function gracePending(input: {
  readonly state: "hold" | "choosing" | "switching";
  readonly reason: string;
  readonly targetTuple: ChatRunSettings | null;
  readonly deadline: number | null;
  // F9's ambient-branch pin is the one case that needs a `failedTuple` with
  // no `profileId` - every other call site passes `FAILED_CLAUDE_TUPLE`
  // explicitly rather than this helper defaulting it, so the one case that
  // varies it cannot be missed by a reader skimming call sites.
  readonly failedTuple: ChatRunSettings;
}) {
  return pendingFallback({
    state: input.state,
    reason: input.reason,
    failedTuple: input.failedTuple,
    targetTuple: input.targetTuple,
    // F5 (the headline-from-`impendingAction` rewrite) rewrites this fixture
    // with a per-case plan; every existing case in this file predates that
    // work and asserts nothing about it, so it is fixed here rather than
    // threaded through ten call sites that do not vary it.
    impendingAction: null,
    deadline: input.deadline,
    attempt: 1,
    maxAttempts: 3,
    queuedItemsMoving: 2,
    siblingSwitching: 0,
    traversalId: "traversal-grace",
    revision: 9,
  });
}

function renderCard(input: { readonly pending: PendingFallback }) {
  return render(
    <FallbackGraceCard
      pending={input.pending}
      client={null}
      chatId="chat-grace"
      epicId="epic-grace"
      hostId={TAB_HOST}
      canAct
      menu={null}
    />,
  );
}

describe("FallbackGraceCard", () => {
  beforeEach(() => {
    mocks.mutate.mockReset();
    mocks.openSettings.mockReset();
    // Reset with the spies: `outcome` is shared mutable state on a hoisted
    // object, so a case that sets a refusal would otherwise leak it into every
    // later case in file order.
    mocks.outcome = "applied";
    mocks.deferOnSuccess = false;
    mocks.capturedOnSuccess = null;
    useSettingsHostScopeStore.getState().setScopedHostId(APP_HOST);
  });

  afterEach(() => {
    cleanup();
    useSettingsHostScopeStore.getState().setScopedHostId(null);
    // A cell that fails mid-test (an ablation, a regression) can exit before
    // its own `vi.useRealTimers()` runs, and fake timers leak into every
    // later cell in the file - a red for a reason that has nothing to do
    // with the one under test. Restored here unconditionally instead.
    vi.useRealTimers();
  });

  it("leads with the failed profile, not the destination", () => {
    renderCard({
      pending: gracePending({
        state: "hold",
        reason: "rate_limit",
        targetTuple: TARGET_CODEX_TUPLE,
        deadline: Date.now() + 12_000,
        failedTuple: FAILED_CLAUDE_TUPLE,
      }),
    });
    const card = screen.getByTestId("fallback-grace-card");
    expect(card.textContent).toMatch(/Claude Code · failed01/);
    expect(card.textContent).not.toMatch(/Codex · target01/);
    expect(card.textContent).not.toMatch(BANNED_VOCABULARY);
  });

  it("renders Switching to the target plus a countdown on hold, and This turn failed when there is no target", () => {
    const { unmount } = renderCard({
      pending: gracePending({
        state: "hold",
        reason: "rate_limit",
        targetTuple: TARGET_CODEX_TUPLE,
        deadline: Date.now() + 12_000,
        failedTuple: FAILED_CLAUDE_TUPLE,
      }),
    });
    // The RESOLVED destination, not the bare profile label. F7 made this
    // sentence name provider and model as well, so asserting only "target01"
    // would keep passing if the resolver regressed to the profile-only form.
    expect(screen.getByTestId("fallback-grace-card").textContent).toMatch(
      /Switching to Codex · gpt-5 on target01/,
    );
    expect(screen.getByTestId("fallback-grace-card").textContent).toMatch(
      /\d+s|\d+m/,
    );
    unmount();

    renderCard({
      pending: gracePending({
        state: "hold",
        reason: "rate_limit",
        targetTuple: null,
        deadline: Date.now() + 12_000,
        failedTuple: FAILED_CLAUDE_TUPLE,
      }),
    });
    const noTarget = screen.getByTestId("fallback-grace-card").textContent;
    expect(noTarget).toMatch(/This turn failed\./);
    expect(noTarget).not.toMatch(/Switching to/);
  });

  // The fresh-session line is only true of a plan that MOVES the chat to a
  // named destination: a wait resumes the session it failed on
  // (`routing=resume`, live), so a hold with no destination yet, and the
  // resume itself, are not that plan even once a destination is named.
  it("states the fresh-session consequence only once a real destination is resolved, and never on a resume", () => {
    const { unmount: unmountNoTarget } = renderCard({
      pending: gracePending({
        state: "hold",
        reason: "rate_limit",
        targetTuple: null,
        deadline: Date.now() + 12_000,
        failedTuple: FAILED_CLAUDE_TUPLE,
      }),
    });
    expect(screen.getByTestId("fallback-grace-card").textContent).not.toMatch(
      /Starts a fresh session/,
    );
    unmountNoTarget();

    const { unmount: unmountWithTarget } = renderCard({
      pending: gracePending({
        state: "hold",
        reason: "rate_limit",
        targetTuple: TARGET_CODEX_TUPLE,
        deadline: Date.now() + 12_000,
        failedTuple: FAILED_CLAUDE_TUPLE,
      }),
    });
    expect(screen.getByTestId("fallback-grace-card").textContent).toMatch(
      /Starts a fresh session/,
    );
    unmountWithTarget();

    // Falsification: revert the helper's gate to `targetLabel !== null` alone
    // - this reads the line even though the destination is the tuple that
    // failed, and there is no fresh session at all.
    renderCard({
      pending: gracePending({
        state: "switching",
        reason: "rate_limit",
        targetTuple: FAILED_CLAUDE_TUPLE,
        deadline: null,
        failedTuple: FAILED_CLAUDE_TUPLE,
      }),
    });
    expect(screen.getByTestId("fallback-grace-card").textContent).not.toMatch(
      /Starts a fresh session/,
    );
  });

  // F5: `impendingHeadline`/`impendingCountdownClause` - the host's PLAN for
  // when the window ends, named on a hold with no resolved `targetTuple` yet.
  // A separate local builder rather than widening `gracePending` again: this
  // is the one field the other 11 call sites in this file never vary, and
  // `impendingAction` needs the two-tuple (headline text, deadline-driven
  // countdown clause) that no other case here exercises.
  function pendingWithImpendingAction(
    impendingAction: FallbackImpendingAction | null,
  ): PendingFallback {
    return pendingFallback({
      state: "hold",
      reason: "rate_limit",
      failedTuple: FAILED_CLAUDE_TUPLE,
      targetTuple: null,
      impendingAction,
      deadline: Date.now() + 12_000,
      attempt: 1,
      maxAttempts: 3,
      queuedItemsMoving: 0,
      siblingSwitching: 0,
      traversalId: "traversal-grace",
      revision: 9,
    });
  }

  it("names the impending plan per disposition, before a destination is resolved", () => {
    const resumesAt = Date.now() + 3_600_000;
    const cases: ReadonlyArray<{
      readonly impendingAction: FallbackImpendingAction | null;
      readonly headline: string;
    }> = [
      {
        impendingAction: fallbackImpendingAction({
          planId: "plan-pending",
          rung: "wait",
          target: null,
          targetModelFamily: null,
          resumesAt: null,
          pending: "resolving",
        }),
        // Falsification: drop the `action.pending !== null` check ahead of
        // the `rung` switch - this reads the `wait` sentence below instead,
        // which promises a decision the host has not made yet.
        headline: "This turn failed.",
      },
      {
        impendingAction: fallbackImpendingAction({
          planId: "plan-wait-unresolved",
          rung: "wait",
          target: null,
          targetModelFamily: null,
          resumesAt: null,
          pending: null,
        }),
        headline:
          "This turn failed. This chat will wait for the limit to reset.",
      },
      {
        impendingAction: fallbackImpendingAction({
          planId: "plan-wait-resolved",
          rung: "wait",
          target: null,
          targetModelFamily: null,
          resumesAt,
          pending: null,
        }),
        // Falsification: swap the `resumesAt === null` branches - this reads
        // "wait for the limit to reset" despite the host naming a time.
        headline: `This turn failed. This chat will wait until ${formatClockTime(resumesAt)}.`,
      },
      {
        impendingAction: fallbackImpendingAction({
          planId: "plan-retry",
          rung: "retry",
          target: null,
          targetModelFamily: null,
          resumesAt: null,
          pending: null,
        }),
        headline: "This turn failed. Trying the same account again.",
      },
      {
        impendingAction: fallbackImpendingAction({
          planId: "plan-profile",
          rung: "profile",
          target: null,
          targetModelFamily: null,
          resumesAt: null,
          pending: null,
        }),
        // Both destination rungs (`profile`/`tier`) share this sentence -
        // they reach here only with no resolved target, so there is nothing
        // more specific to name yet.
        headline: "This turn failed. Switching to another account.",
      },
      {
        impendingAction: null,
        headline: "This turn failed. Nothing else to try.",
      },
    ];
    for (const testCase of cases) {
      const { unmount } = renderCard({
        pending: pendingWithImpendingAction(testCase.impendingAction),
      });
      expect(screen.getByTestId("fallback-grace-card").textContent).toContain(
        testCase.headline,
      );
      unmount();
    }
  });

  function switchingPending(input: {
    readonly targetTuple: ChatRunSettings | null;
    readonly impendingAction: FallbackImpendingAction | null;
  }): PendingFallback {
    return pendingFallback({
      state: "switching",
      reason: "rate_limit",
      failedTuple: FAILED_CLAUDE_TUPLE,
      targetTuple: input.targetTuple,
      impendingAction: input.impendingAction,
      deadline: null,
      attempt: 1,
      maxAttempts: 3,
      queuedItemsMoving: 0,
      siblingSwitching: 0,
      traversalId: "traversal-grace",
      revision: 9,
    });
  }

  // The wait rung's resume commits the FAILED tuple as `switching`'s target -
  // there is nowhere to switch TO, and "Switching to Claude Code ·
  // failed01…" told the user a move had happened when the chat had never
  // left.
  it("reads Resuming now… on a switching frame that resumes the failed tuple, never Switching to", () => {
    renderCard({
      pending: switchingPending({
        targetTuple: FAILED_CLAUDE_TUPLE,
        impendingAction: null,
      }),
    });
    const text = screen.getByTestId("fallback-grace-card").textContent;
    expect(text).toMatch(/Resuming now/);
    expect(text).not.toMatch(/Switching to/);
  });

  it("still reads Switching to … for a real destination that differs from the failed tuple", () => {
    renderCard({
      pending: switchingPending({
        targetTuple: TARGET_CODEX_TUPLE,
        impendingAction: null,
      }),
    });
    const text = screen.getByTestId("fallback-grace-card").textContent;
    expect(text).toMatch(/Switching to Codex · gpt-5 on target01/);
    expect(text).not.toMatch(/Resuming now/);
  });

  // A destination-less `switching` frame is NEVER a resolved wait/retry/
  // notify plan in production - `enterSwitchRung` re-points `impending` at
  // the rung being ENTERED, `{rung, target: null, pending: "resolving"}`,
  // whatever the hold had predicted. `planIsNotAMove` used to key the
  // headline off that stale plan (defending against a frame the host never
  // publishes); it is gone, and the card now reads the destination alone:
  // `targetLabel === null` is "Deciding what to do…", full stop, whatever
  // `impendingAction` says.
  //
  // Table-driven, ROW BY ROW, so a single wrong term reddens exactly the row
  // it governs:
  //  - (a)/(b) are THE LIVE SHAPE `enterSwitchRung` actually publishes: 34 ms
  //    of "Switching now…" between "This chat will wait until 12:29 am" and
  //    the waiting card, live;
  //  - (c) is defensive - no frame may claim a switch it cannot name, even
  //    one whose impending plan is a fully resolved wait;
  //  - (d) is the no-plan-at-all floor.
  const resumesAt = Date.now() + 3_600_000;
  const switchingCases: ReadonlyArray<{
    readonly label: string;
    readonly action: FallbackImpendingAction | null;
  }> = [
    {
      label: "(a) the live shape - a profile rung re-entered, still resolving",
      action: fallbackImpendingAction({
        planId: "plan-profile-resolving",
        rung: "profile",
        target: null,
        targetModelFamily: null,
        resumesAt: null,
        pending: "resolving",
      }),
    },
    {
      label: "(b) the live shape - a tier rung re-entered, still resolving",
      action: fallbackImpendingAction({
        planId: "plan-tier-resolving",
        rung: "tier",
        target: null,
        targetModelFamily: null,
        resumesAt: null,
        pending: "resolving",
      }),
    },
    {
      label: "(c) defensive - a fully resolved wait plan, still no target",
      action: fallbackImpendingAction({
        planId: "plan-wait-resolved",
        rung: "wait",
        target: null,
        targetModelFamily: null,
        resumesAt,
        pending: null,
      }),
    },
    {
      label: "(d) no plan at all",
      action: null,
    },
  ];
  for (const testCase of switchingCases) {
    it(`switching, no destination, ${testCase.label}: reads Deciding what to do…, never Switching now…`, () => {
      const { unmount } = renderCard({
        pending: switchingPending({
          targetTuple: null,
          impendingAction: testCase.action,
        }),
      });
      const text = screen.getByTestId("fallback-grace-card").textContent;
      // Falsification: revert the null-destination headline to the
      // unconditional "Switching now…" - every row above goes red.
      expect(text).toMatch(/Deciding what to do…/);
      expect(text).not.toMatch(/Switching now/);
      unmount();
    });
  }

  // The wait plan's resume time goes through `formatWaitTime`, not the bare
  // clock time, once it is far enough out: the policy's wait cap reaches
  // seven days (`FALLBACK_POLICY_LIMITS.maxWaitMinutes`), so "Wait until
  // 10:34 AM" for a reset days away would name the wrong day.
  it("states the wait plan's resume time with its weekday once it is a day or more away", () => {
    vi.useFakeTimers();
    // A fixed, far-future base so this cell cannot inherit a leaked sample
    // from an earlier test in this file: advancing a full minute-clock
    // interval past it forces an unconditional re-sample (no `subscribe`
    // guard involved), landing `now` at exactly `base + MINUTE_MS` regardless
    // of what the shared clock read before.
    const base = Date.parse("2030-01-01T00:00:00.000Z");
    vi.setSystemTime(base);
    const { rerender } = renderCard({
      pending: pendingWithImpendingAction(
        fallbackImpendingAction({
          planId: "plan-wait-far",
          rung: "wait",
          target: null,
          targetModelFamily: null,
          resumesAt: base, // placeholder, replaced by the rerender below
          pending: null,
        }),
      ),
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    const now = base + 60_000;
    const resumesAt = now + 4 * 24 * 60 * 60_000;
    rerender(
      <FallbackGraceCard
        pending={pendingWithImpendingAction(
          fallbackImpendingAction({
            planId: "plan-wait-far",
            rung: "wait",
            target: null,
            targetModelFamily: null,
            resumesAt,
            pending: null,
          }),
        )}
        client={null}
        chatId="chat-grace"
        epicId="epic-grace"
        hostId={TAB_HOST}
        canAct
        menu={null}
      />,
    );
    // Falsification: `formatWaitTime` always returning `formatClockTime` -
    // this reads the bare clock time instead of the weekday-qualified form.
    const resumesAtLabel = formatResetDateTime(resumesAt);
    expect(screen.getByTestId("fallback-grace-card").textContent).toContain(
      `This turn failed. This chat will wait until ${resumesAtLabel}.`,
    );
    vi.useRealTimers();
  });

  it("says the countdown is paused on choosing and shows no ticking number", () => {
    renderCard({
      pending: gracePending({
        state: "choosing",
        reason: "rate_limit",
        targetTuple: TARGET_CODEX_TUPLE,
        deadline: Date.now() + 45_000,
        failedTuple: FAILED_CLAUDE_TUPLE,
      }),
    });
    const text = screen.getByTestId("fallback-grace-card").textContent;
    expect(text).toMatch(/countdown paused/i);
    expect(text).not.toMatch(/\d+s/);
    expect(text).not.toMatch(/\d+m \d+s/);
  });

  it("renders no countdown at all while switching", () => {
    renderCard({
      pending: gracePending({
        state: "switching",
        reason: "rate_limit",
        targetTuple: TARGET_CODEX_TUPLE,
        deadline: Date.now() + 45_000,
        failedTuple: FAILED_CLAUDE_TUPLE,
      }),
    });
    const text = screen.getByTestId("fallback-grace-card").textContent;
    expect(text).toMatch(/Switching to Codex · gpt-5 on target01/);
    expect(text).not.toMatch(/\d+s/);
    expect(text).not.toMatch(/countdown paused/i);
    expect(text).not.toMatch(/any moment now/);
  });

  it("sends chat.fallback.cancel with the DTO ref on Don't switch", () => {
    renderCard({
      pending: gracePending({
        state: "hold",
        reason: "rate_limit",
        targetTuple: TARGET_CODEX_TUPLE,
        deadline: Date.now() + 12_000,
        failedTuple: FAILED_CLAUDE_TUPLE,
      }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Don't switch" }));
    expect(mocks.mutate).toHaveBeenCalledWith({
      epicId: "epic-grace",
      chatId: "chat-grace",
      traversalId: "traversal-grace",
      revision: 9,
    });
  });

  it("shows Sign in instead only for auth, cancels first, then opens Settings", () => {
    const { unmount } = renderCard({
      pending: gracePending({
        state: "hold",
        reason: "rate_limit",
        targetTuple: TARGET_CODEX_TUPLE,
        deadline: Date.now() + 12_000,
        failedTuple: FAILED_CLAUDE_TUPLE,
      }),
    });
    expect(
      screen.queryByRole("button", { name: "Sign in instead" }),
    ).toBeNull();
    unmount();

    renderCard({
      pending: gracePending({
        state: "hold",
        reason: "auth",
        targetTuple: TARGET_CODEX_TUPLE,
        deadline: Date.now() + 12_000,
        failedTuple: FAILED_CLAUDE_TUPLE,
      }),
    });
    const order: string[] = [];
    mocks.mutate.mockImplementation(() => {
      order.push("cancel");
    });
    mocks.openSettings.mockImplementation(() => {
      order.push("settings");
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in instead" }));
    // Falsification, TWO ways, and the second is the one F8 exists for:
    // (a) run the navigation body inline instead of parking it in
    //     `pendingSignInRef` - i.e. call it directly before the
    //     `cancel.mutate({…})` that ends `onSignInInstead` - and the ORDER
    //     inverts to ["settings", "cancel"]: Settings opens with the cancel
    //     not yet sent, let alone applied. (Deleting the `mutate` call
    //     instead is NOT this falsifier: nothing would arm the outcome
    //     callback, so `order` comes back empty and the test reds on both
    //     entries rather than on their sequence.)
    // (b) move the navigation from the mutation-level `onSuccess` back to a
    //     per-call `mutate(vars, { onSuccess })` handler and "settings" never
    //     arrives at all. That is not a hypothetical: an applied cancel settles
    //     the traversal, the settled frame clears `pendingFallback`, the card
    //     unmounts, and TanStack does not run a per-call handler after the
    //     observer is gone. The one outcome that matters is exactly the one
    //     that guarantees the unmount.
    expect(order).toEqual(["cancel", "settings"]);
  });

  // Cold-review re-review, F8 witness 1: every case above drives `mocks.outcome
  // === "applied"` (the `beforeEach` default), so none of them can tell
  // `onCancelOutcome`'s `outcome !== "applied"` guard (`fallback-grace-card.tsx:94`)
  // apart from no guard at all - removing that term would still satisfy every
  // fixture in this file before this case existed. This is the one that reddens
  // under that removal.
  it("does not open Settings for a refused/deferred cancel - the user stays in the chat", () => {
    mocks.outcome = "traversal_advanced";
    renderCard({
      pending: gracePending({
        state: "hold",
        reason: "auth",
        targetTuple: TARGET_CODEX_TUPLE,
        deadline: Date.now() + 12_000,
        failedTuple: FAILED_CLAUDE_TUPLE,
      }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in instead" }));
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    // Falsification: delete the `outcome !== "applied"` term from
    // `onCancelOutcome` - this goes red (Settings opens on a refusal that
    // established nothing about the account being fixed).
    expect(mocks.openSettings).not.toHaveBeenCalled();
  });

  // Cold-review re-review, F8 witness 2: the real hazard F8 exists for. The
  // double above answers synchronously, so it cannot express "the caller is
  // gone by the time the host answers" - the exact TanStack behaviour
  // `pendingSignInRef` is a ref (not component state) FOR. This case defers
  // the mutation-level `onSuccess`, unmounts the card, and only then invokes
  // it - proving the ref-held closure, not the component, is what runs.
  it("navigates exactly once when the cancel applies AFTER the card has unmounted", () => {
    mocks.deferOnSuccess = true;
    const { unmount } = renderCard({
      pending: gracePending({
        state: "hold",
        reason: "auth",
        targetTuple: TARGET_CODEX_TUPLE,
        deadline: Date.now() + 12_000,
        failedTuple: FAILED_CLAUDE_TUPLE,
      }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in instead" }));
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    // Not yet - the answer has not arrived, and unmounting must not discard
    // the closure `pendingSignInRef` is holding.
    expect(mocks.openSettings).not.toHaveBeenCalled();

    unmount();
    const applyDeferred = mocks.capturedOnSuccess;
    if (applyDeferred === null)
      throw new Error("expected a captured onSuccess");
    applyDeferred();

    // Falsification: move the navigation back to a per-call
    // `mutate(vars, { onSuccess })` handler - the settled frame's own
    // unmount would have already torn down that handler, so this callback
    // would never fire and `openSettings` stays at 0 calls forever.
    expect(mocks.openSettings).toHaveBeenCalledTimes(1);
  });

  // F9: `carryViewedHostIntoSettingsScope(hostId)` runs unconditionally, BEFORE
  // the managed-profile/ambient split - but `setFocusHarnessId` (the ambient
  // branch, taken when the failed tuple carries no `profileId`) clears the
  // host halves `setProfileFocus` sets explicitly, so the carry call above it
  // is the ONLY thing that puts the chat's own host into Settings scope on
  // this branch. Nothing pinned that the ambient branch keeps it.
  it("carries the chat's own host into Settings scope on the AMBIENT sign-in branch (no profileId)", () => {
    const ambientFailedTuple = chatRunSettings({
      harnessId: "claude",
      model: "claude-sonnet-4",
      profileId: null,
    });
    renderCard({
      pending: gracePending({
        state: "hold",
        reason: "auth",
        targetTuple: TARGET_CODEX_TUPLE,
        deadline: Date.now() + 12_000,
        failedTuple: ambientFailedTuple,
      }),
    });
    expect(useSettingsHostScopeStore.getState().scopedHostId).toBe(APP_HOST);
    fireEvent.click(screen.getByRole("button", { name: "Sign in instead" }));
    // Falsification: move `carryViewedHostIntoSettingsScope(hostId)` inside
    // the `if (profileId !== null) { ... } else { ... }` split so only the
    // managed-profile arm keeps it (reasoning that `setProfileFocus` already
    // carries a `hostId` field) - this goes red on the ambient branch, which
    // has no such field, while the managed-profile pin above stays green.
    expect(useSettingsHostScopeStore.getState().scopedHostId).toBe(TAB_HOST);
  });

  // The gate every case above rides past because `claude` HAS a provider CLI.
  // `traycer` is the one harness that does not
  // (`HARNESS_IDS_WITHOUT_PROVIDER_CLI`), so `fallbackTupleIdentity` answers
  // `providerId: null` for it and there is no sign-in surface to open.
  it("offers no Sign in instead for an auth failure whose harness has no provider-CLI account", () => {
    renderCard({
      pending: gracePending({
        state: "hold",
        reason: "auth",
        targetTuple: TARGET_CODEX_TUPLE,
        deadline: Date.now() + 12_000,
        failedTuple: chatRunSettings({
          harnessId: "traycer",
          model: "traycer-default",
          profileId: null,
        }),
      }),
    });
    // Falsification: revert `signedOut` to `pending.reason === "auth"` alone,
    // leaving the `providerId === null` check inside the armed closure. The
    // button comes back, and pressing it CANCELS the traversal and then
    // returns without opening anything - the user trades the switch for
    // nothing. Every other case in this file stays green under that revert,
    // which is why this one exists.
    expect(
      screen.queryByRole("button", { name: "Sign in instead" }),
    ).toBeNull();
    // The card is still usable, and its helper line says what the button it
    // DOES have will do - the sign-in wording would promise a control that is
    // not on screen.
    expect(screen.getByRole("button", { name: "Don't switch" })).not.toBeNull();
    expect(
      screen.getByText(
        "Don't switch keeps the error — you can retry from the message.",
      ),
    ).not.toBeNull();
  });

  it("omits Choose differently… when the handler is null", () => {
    renderCard({
      pending: gracePending({
        state: "hold",
        reason: "rate_limit",
        targetTuple: TARGET_CODEX_TUPLE,
        deadline: Date.now() + 12_000,
        failedTuple: FAILED_CLAUDE_TUPLE,
      }),
    });
    expect(
      screen.queryByRole("button", { name: "Choose differently…" }),
    ).toBeNull();
  });

  it("shows no reason chip and no raw code for an unrecognised reason", () => {
    renderCard({
      pending: gracePending({
        state: "hold",
        reason: "something_this_build_has_never_heard_of",
        targetTuple: TARGET_CODEX_TUPLE,
        deadline: Date.now() + 12_000,
        failedTuple: FAILED_CLAUDE_TUPLE,
      }),
    });
    const text = screen.getByTestId("fallback-grace-card").textContent;
    expect(text).not.toContain("something_this_build_has_never_heard_of");
  });

  // Live regression: the countdown mounted reading "in 3m 27s" for a 15s
  // window and never moved until the host switched. `useGraceCountdown` used
  // to read `secondClock.sampledNow()` at render time, and the compiler
  // (which runs here because `fallback-grace-card`/`relative-time` are in
  // `REACT_COMPILER_REGRESSION_FILES`) memoized that read on `deadline`
  // alone, so every tick re-rendered the leaf and returned the FIRST
  // render's string. It now renders from `useSyncExternalStore`'s return
  // value instead. These pins mount the card through `render`, not
  // `renderHook`, so they exercise the actual compiled leaf the user
  // watches.
  describe("the countdown itself ticks (compiled mode)", () => {
    afterEach(() => {
      cleanup();
      vi.useRealTimers();
    });

    it("decrements the visible countdown one second after mount", () => {
      vi.useFakeTimers();
      renderCard({
        pending: gracePending({
          state: "hold",
          reason: "rate_limit",
          targetTuple: TARGET_CODEX_TUPLE,
          deadline: Date.now() + 12_000,
          failedTuple: FAILED_CLAUDE_TUPLE,
        }),
      });
      const before = screen.getByTestId("fallback-grace-card").textContent;
      const beforeMatch = before.match(/(\d+)s/);
      if (beforeMatch === null) {
        throw new Error("expected a seconds countdown in the initial render");
      }
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      const after = screen.getByTestId("fallback-grace-card").textContent;
      const afterMatch = after.match(/(\d+)s/);
      if (afterMatch === null) {
        throw new Error("expected a seconds countdown after the tick");
      }
      // Falsification: the compiled leaf's memoized render never changes, so
      // `afterMatch` reads the same number as `beforeMatch`.
      expect(Number(afterMatch[1])).toBeLessThan(Number(beforeMatch[1]));
    });

    // The exact live reproduction: a first card leaves the shared second
    // clock's sample behind whenever it sat mounted, the clock then goes
    // idle and stops re-sampling the instant the last subscriber leaves, and
    // a NEW card mounting minutes later inherits that stale first render
    // through the compiler's memoization - a 15s window that reads "3m 15s".
    it("never renders a stale multi-minute countdown for a freshly mounted card with a short deadline", () => {
      vi.useFakeTimers();
      const { unmount: unmountFirst } = renderCard({
        pending: gracePending({
          state: "hold",
          reason: "rate_limit",
          targetTuple: TARGET_CODEX_TUPLE,
          deadline: Date.now() + 30_000,
          failedTuple: FAILED_CLAUDE_TUPLE,
        }),
      });
      unmountFirst();

      // No card mounted while roughly 3 minutes of real time pass - nothing
      // subscribed to the second clock re-samples it during this window.
      act(() => {
        vi.advanceTimersByTime(3 * 60_000);
      });

      renderCard({
        pending: gracePending({
          state: "hold",
          reason: "rate_limit",
          targetTuple: TARGET_CODEX_TUPLE,
          deadline: Date.now() + 15_000,
          failedTuple: FAILED_CLAUDE_TUPLE,
        }),
      });
      const text = screen.getByTestId("fallback-grace-card").textContent;
      // Falsification: the compiled leaf returns the stale "in 3m 15s"-shaped
      // string it read on its own first render instead of the fresh sample
      // subscribing should have corrected.
      //
      // Anchored on the clause (`in <n>s`), not a bare `\b1[45]s\b`: the
      // card's text nodes run flush into each other ("15s" is immediately
      // followed by "Starts", no space), so a trailing `\b` after the digits
      // never fires - `s` and `S` are both word characters, no boundary
      // between them - and that pin would never fail regardless of what
      // followed. And a bare `1[45]s` with no anchor on "in" also matches
      // inside the STALE "in 3m 15s" (the "15s" half of it), so it would
      // pass on the exact string this pin exists to reject.
      expect(text).toMatch(/\bin 1[45]s/);
      expect(text).not.toMatch(/\bin \d+m/);

      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      const afterTick = screen.getByTestId("fallback-grace-card").textContent;
      expect(afterTick).not.toBe(text);
    });

    // A hold resumed from the destination menu mid-tick handed a
    // new deadline to an ALREADY-MOUNTED card. `useGraceCountdown` used to
    // render against the last interval fire's sample - up to a second old -
    // until the next fire, so a resume with 14.57s left painted "in 16s"
    // before counting down. `SharedClock.resample()`, called from a
    // `useLayoutEffect` keyed on `[deadline]`, re-takes the sample and wakes
    // this subscriber before paint, so the first frame of the new deadline is
    // counted from now.
    it("re-samples a mounted card's countdown when its deadline changes mid-tick", () => {
      vi.useFakeTimers();
      const { rerender } = renderCard({
        pending: gracePending({
          state: "hold",
          reason: "rate_limit",
          targetTuple: TARGET_CODEX_TUPLE,
          deadline: Date.now() + 30_000,
          failedTuple: FAILED_CLAUDE_TUPLE,
        }),
      });

      // Under the second clock's 1s interval, not at a fire boundary - the
      // stale-sample bug needs a deadline change that lands BETWEEN ticks.
      act(() => {
        vi.advanceTimersByTime(900);
      });

      rerender(
        <FallbackGraceCard
          pending={gracePending({
            state: "hold",
            reason: "rate_limit",
            targetTuple: TARGET_CODEX_TUPLE,
            deadline: Date.now() + 14_570,
            failedTuple: FAILED_CLAUDE_TUPLE,
          })}
          client={null}
          chatId="chat-grace"
          epicId="epic-grace"
          hostId={TAB_HOST}
          canAct
          menu={null}
        />,
      );

      const text = screen.getByTestId("fallback-grace-card").textContent;
      // Falsification: without the resample, the render reads the sample
      // from 900ms ago - already short of the new deadline by that much -
      // and rounds up to "in 16s" instead of "in 15s". Anchored on the
      // clause for the same reason as the sibling pin above: the card's text
      // nodes run flush into each other, so a trailing `\b` after the digits
      // never fires, and a bare `1[56]s` with no anchor on "in" would also
      // match inside neighbouring text.
      expect(text).toMatch(/\bin 15s/);
      expect(text).not.toMatch(/\bin 16s/);
    });
  });

  // Second defect, same production file: past the deadline
  // `formatGraceCountdown` returns `GRACE_COUNTDOWN_IMMINENT` ("any moment
  // now"), but every clause template in `impendingCountdownClause` and the
  // named-target headline was `… in ${countdown}` - so the card rendered
  // "Deciding what to do in any moment now." and "Switching to X in any
  // moment now" instead of dropping the "in". These pins state the fixed
  // wording and fail against the old `… in ${countdown}` templates.
  describe("countdown clauses past the deadline read 'any moment now', never 'in any moment now'", () => {
    it("a still-resolving plan (no target yet) reads 'Deciding what to do any moment now.'", () => {
      renderCard({
        pending: pendingFallback({
          state: "hold",
          reason: "rate_limit",
          failedTuple: FAILED_CLAUDE_TUPLE,
          targetTuple: null,
          impendingAction: fallbackImpendingAction({
            planId: "plan-imminent-pending",
            rung: "wait",
            target: null,
            targetModelFamily: null,
            resumesAt: null,
            pending: "resolving",
          }),
          deadline: Date.now() - 5_000,
          attempt: 1,
          maxAttempts: 3,
          queuedItemsMoving: 0,
          siblingSwitching: 0,
          traversalId: "traversal-grace",
          revision: 9,
        }),
      });
      const text = screen.getByTestId("fallback-grace-card").textContent;
      expect(text).toContain("Deciding what to do any moment now.");
      expect(text).not.toMatch(/in any moment now/);
    });

    it("a resolved plan naming a target reads 'Switching to <target> any moment now'", () => {
      renderCard({
        pending: pendingFallback({
          state: "hold",
          reason: "rate_limit",
          failedTuple: FAILED_CLAUDE_TUPLE,
          targetTuple: TARGET_CODEX_TUPLE,
          impendingAction: null,
          deadline: Date.now() - 5_000,
          attempt: 1,
          maxAttempts: 3,
          queuedItemsMoving: 0,
          siblingSwitching: 0,
          traversalId: "traversal-grace",
          revision: 9,
        }),
      });
      const text = screen.getByTestId("fallback-grace-card").textContent;
      expect(text).toMatch(
        /Switching to Codex · gpt-5 on target01 any moment now/,
      );
      expect(text).not.toMatch(/in any moment now/);
    });

    it("a notify plan (no destination) reads 'Stopping any moment now.'", () => {
      renderCard({
        pending: pendingFallback({
          state: "hold",
          reason: "rate_limit",
          failedTuple: FAILED_CLAUDE_TUPLE,
          targetTuple: null,
          impendingAction: fallbackImpendingAction({
            planId: "plan-imminent-notify",
            rung: "notify",
            target: null,
            targetModelFamily: null,
            resumesAt: null,
            pending: null,
          }),
          deadline: Date.now() - 5_000,
          attempt: 1,
          maxAttempts: 3,
          queuedItemsMoving: 0,
          siblingSwitching: 0,
          traversalId: "traversal-grace",
          revision: 9,
        }),
      });
      const text = screen.getByTestId("fallback-grace-card").textContent;
      expect(text).toContain("Stopping any moment now.");
      expect(text).not.toMatch(/in any moment now/);
    });
  });
});
