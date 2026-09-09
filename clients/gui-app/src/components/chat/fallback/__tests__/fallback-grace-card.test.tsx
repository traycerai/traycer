import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChatRunSettings,
  PendingFallback,
} from "@traycer/protocol/host/agent/gui/subscribe";
import { FallbackGraceCard } from "@/components/chat/fallback/fallback-grace-card";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";
import {
  BANNED_VOCABULARY,
  FAILED_CLAUDE_TUPLE,
  TARGET_CODEX_TUPLE,
  pendingFallback,
} from "./fallback-fixtures";

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  openSettings: vi.fn(),
  /** The `outcome` the mocked mutation answers with. See the mock below. */
  outcome: "applied",
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
}) {
  return pendingFallback({
    state: input.state,
    reason: input.reason,
    failedTuple: FAILED_CLAUDE_TUPLE,
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
      }),
    });
    const noTarget = screen.getByTestId("fallback-grace-card").textContent;
    expect(noTarget).toMatch(/This turn failed\./);
    expect(noTarget).not.toMatch(/Switching to/);
  });

  it("says the countdown is paused on choosing and shows no ticking number", () => {
    renderCard({
      pending: gracePending({
        state: "choosing",
        reason: "rate_limit",
        targetTuple: TARGET_CODEX_TUPLE,
        deadline: Date.now() + 45_000,
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
    // (a) remove the `onCancel()` call at the top of `onSignInInstead` and the
    //     ORDER breaks - Settings opens without the cancel having been sent.
    // (b) move the navigation from the mutation-level `onSuccess` back to a
    //     per-call `mutate(vars, { onSuccess })` handler and "settings" never
    //     arrives at all. That is not a hypothetical: an applied cancel settles
    //     the traversal, the settled frame clears `pendingFallback`, the card
    //     unmounts, and TanStack does not run a per-call handler after the
    //     observer is gone. The one outcome that matters is exactly the one
    //     that guarantees the unmount.
    expect(order).toEqual(["cancel", "settings"]);
  });

  it("omits Choose differently… when the handler is null", () => {
    renderCard({
      pending: gracePending({
        state: "hold",
        reason: "rate_limit",
        targetTuple: TARGET_CODEX_TUPLE,
        deadline: Date.now() + 12_000,
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
      }),
    });
    const text = screen.getByTestId("fallback-grace-card").textContent;
    expect(text).not.toContain("something_this_build_has_never_heard_of");
  });
});
