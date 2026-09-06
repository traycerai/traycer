import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import { FallbackReturnBanner } from "@/components/chat/fallback/fallback-return-banner";
import {
  BANNED_VOCABULARY,
  FAILED_CLAUDE_TUPLE,
  PREFERRED_CLAUDE_TUPLE,
  TARGET_CODEX_TUPLE,
  chatRunSettings,
  pendingReturn,
} from "./fallback-fixtures";

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
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

function renderBanner(input: {
  readonly fallbackTuple: ChatRunSettings;
  readonly preferredTuple: ChatRunSettings;
  readonly queuedItemsMoving: number;
}) {
  return render(
    <FallbackReturnBanner
      offer={pendingReturn({
        preferredTuple: input.preferredTuple,
        fallbackTuple: input.fallbackTuple,
        queuedItemsMoving: input.queuedItemsMoving,
        traversalId: "traversal-return",
        revision: 11,
      })}
      client={null}
      chatId="chat-return"
      epicId="epic-return"
      canAct
    />,
  );
}

describe("FallbackReturnBanner", () => {
  beforeEach(() => {
    mocks.mutate.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("sends switch_back, stay, and dismiss_for_chat with the DTO ref", () => {
    renderBanner({
      fallbackTuple: TARGET_CODEX_TUPLE,
      preferredTuple: PREFERRED_CLAUDE_TUPLE,
      queuedItemsMoving: 2,
    });
    const banner = screen.getByTestId("fallback-return-banner");
    expect(banner.textContent).not.toMatch(BANNED_VOCABULARY);

    fireEvent.click(screen.getByRole("button", { name: "Switch back" }));
    expect(mocks.mutate).toHaveBeenCalledWith({
      epicId: "epic-return",
      chatId: "chat-return",
      traversalId: "traversal-return",
      revision: 11,
      action: "switch_back",
    });

    fireEvent.click(screen.getByRole("button", { name: /Stay on / }));
    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ action: "stay" }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Don't ask for this chat" }),
    );
    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ action: "dismiss_for_chat" }),
    );
  });

  it("states queued messages move and hides the count at zero", () => {
    const { unmount } = renderBanner({
      fallbackTuple: TARGET_CODEX_TUPLE,
      preferredTuple: PREFERRED_CLAUDE_TUPLE,
      queuedItemsMoving: 2,
    });
    expect(screen.getByTestId("fallback-return-banner").textContent).toMatch(
      /moves 2 queued messages back/,
    );
    unmount();

    renderBanner({
      fallbackTuple: TARGET_CODEX_TUPLE,
      preferredTuple: PREFERRED_CLAUDE_TUPLE,
      queuedItemsMoving: 0,
    });
    expect(
      screen.getByTestId("fallback-return-banner").textContent,
    ).not.toMatch(/queued message/);
  });

  it("names a cross-provider fallback as Provider · model and a same-provider one as the profile label", () => {
    const { unmount } = renderBanner({
      fallbackTuple: TARGET_CODEX_TUPLE,
      preferredTuple: PREFERRED_CLAUDE_TUPLE,
      queuedItemsMoving: 0,
    });
    expect(screen.getByTestId("fallback-return-banner").textContent).toMatch(
      /Codex · gpt-5/,
    );
    unmount();

    const sameProvider = chatRunSettings({
      harnessId: "claude",
      model: "claude-opus-4",
      profileId: "workacct-profile",
    });
    renderBanner({
      fallbackTuple: sameProvider,
      preferredTuple: FAILED_CLAUDE_TUPLE,
      queuedItemsMoving: 0,
    });
    const text = screen.getByTestId("fallback-return-banner").textContent;
    expect(text).toMatch(/workacct/);
    expect(text).not.toMatch(/Claude Code · claude-opus-4/);
  });
});
