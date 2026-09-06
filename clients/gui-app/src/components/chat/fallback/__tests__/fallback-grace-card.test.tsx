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
}));

vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersListForClient: () => ({ data: undefined }),
}));

vi.mock("@/hooks/host/use-host-scoped-mutation", () => ({
  useHostScopedMutationForClient: () => ({
    mutate: mocks.mutate,
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
    expect(screen.getByTestId("fallback-grace-card").textContent).toMatch(
      /Switching to target01/,
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
    expect(text).toMatch(/Switching to target01/);
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
    // Falsification: remove the onCancel() call at the top of onSignInInstead and THIS assertion must go red.
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
