import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessagePeer } from "@traycer/protocol/host/agent/message-peer";
import { TabHostContext } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useOpenA2AMessagePeer } from "@/hooks/agent/use-open-a2a-message-peer";
import { botTabIntent } from "@/lib/tab-navigation/intents";
import { useBotTabLandingStore } from "@/stores/bots/bot-tab-landing-store";
import { useBotTabsStore } from "@/stores/bots/bot-tabs-store";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  openTile: vi.fn(),
  activateTabIntent:
    vi.fn<(navigate: unknown, intent: unknown, extra: unknown) => void>(),
  navigateToTabIntent:
    vi.fn<(navigate: unknown, intent: unknown, options: unknown) => void>(),
}));

vi.mock("@/hooks/host/use-connectable-host-ids", () => ({
  useConnectableHostIds: () => ({ hostIds: [], resolved: false }),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));

vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => ({ openTile: mocks.openTile }),
}));

vi.mock("@/lib/epic-selectors", () => ({
  useOpenEpicId: () => "epic-current",
}));

vi.mock("@/lib/tab-navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tab-navigation")>();
  return {
    ...actual,
    activateTabIntent: mocks.activateTabIntent,
    navigateToTabIntent: mocks.navigateToTabIntent,
  };
});

function TabHost({ children }: { readonly children: ReactNode }) {
  return <TabHostContext value="host-tab">{children}</TabHostContext>;
}

function renderOpenPeer() {
  return renderHook(() => useOpenA2AMessagePeer(), { wrapper: TabHost });
}

function peer(overrides: Partial<AgentMessagePeer>): AgentMessagePeer {
  return {
    epicId: "epic-current",
    agentId: "agent-1",
    hostId: "host-1",
    title: "Agent One",
    surface: "gui",
    bot: null,
    ...overrides,
  };
}

describe("useOpenA2AMessagePeer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useBotTabsStore.setState({ tabs: {}, fixedBotId: null });
    useBotTabLandingStore.setState({ byBotId: {} });
  });

  it("opens a same-task peer through the current task's tile navigation only", () => {
    const { result } = renderOpenPeer();

    result.current(peer({}), "Agent One");

    expect(mocks.openTile).toHaveBeenCalledTimes(1);
    expect(mocks.openTile).toHaveBeenCalledWith(
      expect.objectContaining({ target: { epicId: "epic-current" } }),
    );
    expect(mocks.activateTabIntent).not.toHaveBeenCalled();
  });

  it("activates the OTHER task at the top level with the tile prepared, and does not also open a tile here", () => {
    const { result } = renderOpenPeer();

    result.current(
      peer({ epicId: "epic-2", hostId: "host-2", agentId: "agent-2" }),
      "Cross Name",
    );

    expect(mocks.openTile).not.toHaveBeenCalled();
    expect(mocks.activateTabIntent).toHaveBeenCalledTimes(1);
    const call = mocks.activateTabIntent.mock.calls.at(0);
    if (call === undefined) throw new Error("activateTabIntent was not called");
    const [navigate, intent, extra] = call;
    expect(navigate).toBe(mocks.navigate);
    expect(extra).toBeUndefined();
    expect(intent).toMatchObject({
      kind: "open-epic",
      epicId: "epic-2",
      includeNestedFocus: true,
      preparation: {
        kind: "open-tile",
        gesture: "explicit",
        node: {
          id: "agent-2",
          type: "chat",
          name: "Cross Name",
          hostId: "host-2",
        },
      },
    });
  });

  it("prepares a terminal-agent tile for a cross-task TUI peer", () => {
    const { result } = renderOpenPeer();

    result.current(
      peer({ epicId: "epic-2", hostId: "host-2", surface: "tui" }),
      "Cross Terminal",
    );

    const call = mocks.activateTabIntent.mock.calls.at(0);
    if (call === undefined) throw new Error("activateTabIntent was not called");
    expect(call[1]).toMatchObject({
      preparation: { node: { type: "terminal-agent", hostId: "host-2" } },
    });
    expect(mocks.openTile).not.toHaveBeenCalled();
  });

  it("opens a bot peer's channel on the tab host with the sending session as the landing, and opens no tile or task tab", () => {
    const { result } = renderOpenPeer();

    result.current(
      peer({
        epicId: "bot-1",
        agentId: "session-chat-1",
        bot: { botId: "bot-1", title: "Release bot" },
      }),
      "Release bot",
    );

    expect(useBotTabsStore.getState().tabs["bot-1"]).toMatchObject({
      botId: "bot-1",
      hostId: "host-tab",
      title: "Release bot",
    });
    expect(mocks.navigateToTabIntent).toHaveBeenCalledTimes(1);
    expect(mocks.navigateToTabIntent).toHaveBeenCalledWith(
      mocks.navigate,
      botTabIntent("bot-1"),
      undefined,
    );
    expect(useBotTabLandingStore.getState().byBotId["bot-1"]).toEqual({
      kind: "sender",
      chatId: "session-chat-1",
    });
    expect(mocks.openTile).not.toHaveBeenCalled();
    expect(mocks.activateTabIntent).not.toHaveBeenCalled();
  });
});
