import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FallbackWaitingCard } from "@/components/chat/fallback/fallback-waiting-card";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";
import {
  BANNED_VOCABULARY,
  FAILED_CLAUDE_TUPLE,
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

function waitingPending(deadline: number | null) {
  return pendingFallback({
    state: "waiting",
    reason: "rate_limit",
    failedTuple: FAILED_CLAUDE_TUPLE,
    targetTuple: null,
    deadline,
    attempt: 1,
    maxAttempts: 1,
    queuedItemsMoving: 1,
    siblingSwitching: 0,
    traversalId: "traversal-wait",
    revision: 5,
  });
}

function renderCard(input: { readonly deadline: number | null }) {
  return render(
    <FallbackWaitingCard
      pending={waitingPending(input.deadline)}
      client={null}
      chatId="chat-wait"
      epicId="epic-wait"
      hostId="tab-host-b"
      canAct
      menu={null}
    />,
  );
}

describe("FallbackWaitingCard", () => {
  beforeEach(() => {
    mocks.mutate.mockReset();
    mocks.openSettings.mockReset();
    useSettingsHostScopeStore.getState().setScopedHostId("app-host-a");
  });

  afterEach(() => {
    cleanup();
    useSettingsHostScopeStore.getState().setScopedHostId(null);
  });

  it("announces a 12-hour resume time in a status live region", () => {
    renderCard({
      deadline: Date.now() + 2 * 60 * 60 * 1000,
    });
    const headline = screen.getByRole("status");
    expect(headline.textContent).toMatch(
      /^Resuming at \d{1,2}:\d{2}\s?[AP]M \(in about /i,
    );
    expect(screen.getByTestId("fallback-waiting-card").textContent).not.toMatch(
      BANNED_VOCABULARY,
    );
  });

  it("reads Resuming shortly past the deadline and for a null deadline, never 0s", () => {
    const { unmount } = renderCard({
      deadline: Date.now() - 5_000,
    });
    expect(screen.getByRole("status").textContent).toBe("Resuming shortly…");
    expect(screen.getByRole("status").textContent).not.toMatch(/0s/);
    expect(screen.getByRole("status").textContent).not.toMatch(/-/);
    unmount();

    renderCard({ deadline: null });
    // Falsification: drop the deadline <= now branch in FallbackWaitHeadline and THIS assertion must go red.
    expect(screen.getByRole("status").textContent).toBe("Resuming shortly…");
    expect(screen.getByRole("status").textContent).not.toMatch(/0s/);
  });

  it("sends cancel with the DTO ref on Stop waiting", () => {
    renderCard({
      deadline: Date.now() + 60_000,
    });
    fireEvent.click(screen.getByRole("button", { name: "Stop waiting" }));
    expect(mocks.mutate).toHaveBeenCalledWith({
      epicId: "epic-wait",
      chatId: "chat-wait",
      traversalId: "traversal-wait",
      revision: 5,
    });
  });

  it("omits Switch instead… when the handler is null", () => {
    renderCard({
      deadline: Date.now() + 60_000,
    });
    expect(
      screen.queryByRole("button", { name: "Switch instead…" }),
    ).toBeNull();
  });
});
