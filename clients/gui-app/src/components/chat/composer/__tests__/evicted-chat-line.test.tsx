import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TileOpenIntent } from "@/lib/canvas/tile-open/intent";

const openTile = vi.hoisted(() => vi.fn<(intent: TileOpenIntent) => null>());
vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => ({ openTile }),
}));
vi.mock("@/hooks/epic/use-epic-session-host-id", () => ({
  useEpicSessionHostId: () => "host-reading",
}));
vi.mock("@/lib/epic-selectors", () => ({
  useEpicLiveArtifactTitle: () => "Fix the login bug",
}));

import { EvictedChatLine } from "@/components/chat/composer/evicted-chat-line";
import type { EvictedChatLineKind } from "@/hooks/chats/use-evicted-chat-send";

function line(kind: EvictedChatLineKind | null, ownerUserId: string | null) {
  return render(
    <EvictedChatLine
      line={kind}
      epicId="epic-1"
      chatId="chat-1"
      ownerHostId="host-owner"
      ownerUserId={ownerUserId}
      tabId="tab-1"
    />,
  );
}

afterEach(() => {
  cleanup();
  openTile.mockReset();
});

describe("the line above an evicted chat's composer", () => {
  it("says nothing without a line", () => {
    const { container } = line(null, "owner-1");
    expect(container.textContent).toBe("");
  });

  it("says the chat is coming back while it hydrates", () => {
    line("hydrating", "owner-1");
    expect(
      screen.getByText("Bringing this chat back to this computer…"),
    ).toBeTruthy();
  });

  it("asks the person to reconnect in the warning recipe when the cloud is unreachable", () => {
    line("unreachable", "owner-1");
    const status = screen.getByRole("status");
    expect(status.textContent).toBe(
      "This chat is stored in the cloud. Reconnect to continue it.",
    );
    expect([...status.classList]).toEqual(
      expect.arrayContaining([
        "border-warning/30",
        "bg-warning/10",
        "text-warning-foreground",
      ]),
    );
  });

  it("opens the published copy of the chat from the head-moved line", async () => {
    line("head-moved", "owner-1");
    expect(screen.getByRole("status").textContent).toBe(
      "This chat was continued elsewhere.Open the latest copy.",
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Open the latest copy." }),
    );

    expect(openTile).toHaveBeenCalledTimes(1);
    const intent = openTile.mock.calls[0]?.[0];
    expect(intent.node).toMatchObject({
      type: "published-chat",
      taskId: "epic-1",
      chatId: "chat-1",
      ownerUserId: "owner-1",
      ownerHostId: "host-owner",
      hostId: "host-reading",
      name: "Fix the login bug",
    });
    expect(intent.target).toEqual({ tabId: "tab-1" });
  });

  it("cannot open a copy until the chat's owner is known", () => {
    line("head-moved", null);
    expect(
      screen
        .getByRole("button", { name: "Open the latest copy." })
        .hasAttribute("disabled"),
    ).toBe(true);
  });
});
