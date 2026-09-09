import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PendingFallback,
  PendingReturn,
} from "@traycer/protocol/host/agent/gui/subscribe";
import { ChatComposerBannerPortalProvider } from "@/components/chat/composer/chat-composer-banner-portal";
import { ChatComposerFallbackBanners } from "@/components/chat/fallback/chat-composer-fallback-banners";
import {
  FAILED_CLAUDE_TUPLE,
  PREFERRED_CLAUDE_TUPLE,
  TARGET_CODEX_TUPLE,
  pendingFallback,
  pendingReturn,
} from "./fallback-fixtures";

// The banners fill both cards' `menu` slots, so the real destination menu
// mounts here even while closed - and its list query reaches for a QueryClient
// this suite has no reason to stand up. Faked at the same seam the menu and
// manual-rung suites use. Nothing moves: what THIS suite pins is which CARD
// renders for a given state, and the menu's own behaviour has its own file.
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

vi.mock("@/hooks/host/use-host-scoped-mutation", () => ({
  useHostScopedMutationForClient: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}));

vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ openSettings: vi.fn() }),
}));

function pendingAt(
  state: "retrying" | "hold" | "choosing" | "switching" | "waiting",
) {
  return pendingFallback({
    state,
    reason: "rate_limit",
    failedTuple: FAILED_CLAUDE_TUPLE,
    targetTuple: TARGET_CODEX_TUPLE,
    impendingAction: null,
    deadline: Date.now() + 30_000,
    attempt: 1,
    maxAttempts: 3,
    queuedItemsMoving: 0,
    siblingSwitching: 0,
    traversalId: "traversal-composer",
    revision: 1,
  });
}

function renderBanners(input: {
  readonly topBannerKind: "fallback" | "fallback-return" | "none";
  readonly pending: PendingFallback | undefined;
  readonly pendingReturn: PendingReturn | undefined;
}) {
  return render(
    <ChatComposerBannerPortalProvider>
      <ChatComposerFallbackBanners
        topBannerKind={input.topBannerKind}
        fallback={{
          pending: input.pending,
          pendingReturn: input.pendingReturn,
        }}
        client={null}
        chatId="chat-composer"
        epicId="epic-composer"
        hostId="tab-host-b"
        canAct
      />
    </ChatComposerBannerPortalProvider>,
  );
}

describe("ChatComposerFallbackBanners", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the grace card for hold and the waiting card for waiting", () => {
    const { unmount } = renderBanners({
      topBannerKind: "fallback",
      pending: pendingAt("hold"),
      pendingReturn: undefined,
    });
    expect(screen.getByTestId("fallback-grace-card")).toBeDefined();
    expect(screen.queryByTestId("fallback-waiting-card")).toBeNull();
    unmount();

    renderBanners({
      topBannerKind: "fallback",
      pending: pendingAt("waiting"),
      pendingReturn: undefined,
    });
    expect(screen.getByTestId("fallback-waiting-card")).toBeDefined();
    expect(screen.queryByTestId("fallback-grace-card")).toBeNull();
  });

  it("renders neither card for retrying even when the fallback slot is claimed", () => {
    renderBanners({
      topBannerKind: "fallback",
      pending: pendingAt("retrying"),
      pendingReturn: undefined,
    });
    // Falsification: replace the two independent checks with a ternary else-branch and THIS assertion must go red.
    expect(screen.queryByTestId("fallback-grace-card")).toBeNull();
    expect(screen.queryByTestId("fallback-waiting-card")).toBeNull();
  });

  it("renders the return banner only in the fallback-return slot", () => {
    const offer = pendingReturn({
      preferredTuple: PREFERRED_CLAUDE_TUPLE,
      fallbackTuple: TARGET_CODEX_TUPLE,
      queuedItemsMoving: 0,
      traversalId: "traversal-return",
      revision: 1,
    });
    const { unmount } = renderBanners({
      topBannerKind: "fallback-return",
      pending: undefined,
      pendingReturn: offer,
    });
    expect(screen.getByTestId("fallback-return-banner")).toBeDefined();
    unmount();

    renderBanners({
      topBannerKind: "none",
      pending: undefined,
      pendingReturn: offer,
    });
    expect(screen.queryByTestId("fallback-return-banner")).toBeNull();
  });
});
