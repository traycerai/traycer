import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChatRunSettings,
  FallbackImpendingAction,
  PendingFallback,
} from "@traycer/protocol/host/agent/gui/subscribe";
import { FallbackGraceCard } from "@/components/chat/fallback/fallback-grace-card";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";
import { formatClockTime } from "@/lib/relative-time";
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
});
