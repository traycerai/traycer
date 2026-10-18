/**
 * The bot tab's surface (Tracy Bots): the stream's states, the bound-elsewhere
 * banner in its reachable and offline forms, the re-subscribe when the pane
 * comes back into view, and the tab closing when the bot is gone from
 * `bot.list`. The three views are replaced by stubs that expose their props,
 * so what the surface PASSES them is what is asserted.
 */
import { StrictMode, type ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotRecord } from "@traycer/protocol/host/bot/schemas";
import type { BotSubscriptionSnapshot } from "@/hooks/bots/use-bot-subscription";

const mocks = vi.hoisted(() => ({
  hostClient: { stub: "tab-host-client" },
  resubscribe: vi.fn<() => void>(),
  claim: vi.fn<(variables: { botId: string }) => void>(),
  state: {
    snapshot: null as BotSubscriptionSnapshot | null,
    deleted: false,
    error: null as string | null,
    paneVisible: true,
    connectable: { hostIds: [] as string[], resolved: true },
    directory: [] as Array<{ hostId: string; label: string }>,
    listedBotIds: undefined as string[] | undefined,
    claimPending: false,
    support: null as boolean | null,
  },
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => mocks.state.support,
}));

vi.mock("@/components/epic-canvas/tab-host-provider", () => ({
  TabHostProvider: (props: { hostId: string; children: ReactNode }) => (
    <>{props.children}</>
  ),
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => mocks.hostClient,
}));
vi.mock("@/components/epic-tabs/pane-visibility-context", () => ({
  usePaneVisible: () => mocks.state.paneVisible,
}));
vi.mock("@/hooks/bots/use-bot-subscription", () => ({
  useBotSubscriptionForHost: () => ({
    snapshot: mocks.state.snapshot,
    deleted: mocks.state.deleted,
    error: mocks.state.error,
    isPending: mocks.state.snapshot === null,
    resubscribe: mocks.resubscribe,
  }),
}));
vi.mock("@/hooks/host/use-connectable-host-ids", () => ({
  useConnectableHostIds: () => mocks.state.connectable,
}));
vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({ data: mocks.state.directory }),
}));
vi.mock("@/hooks/bots/use-bot-list-query", () => ({
  useBotListQuery: () => ({
    data:
      mocks.state.listedBotIds === undefined
        ? undefined
        : { bots: mocks.state.listedBotIds.map((botId) => ({ botId })) },
  }),
}));
vi.mock("@/hooks/bots/use-environment-list-query", () => ({
  useEnvironmentListQuery: () => ({
    data: {
      environments: [{ environmentId: "env-personal", label: "Personal" }],
    },
  }),
}));
vi.mock("@/hooks/bots/use-bot-mutations", () => ({
  useBotClaimAuthorityMutation: () => ({
    isPending: mocks.state.claimPending,
    mutate: (
      variables: { botId: string },
      options: { onSuccess: () => void },
    ) => {
      mocks.claim(variables);
      options.onSuccess();
    },
  }),
}));
vi.mock("@/components/bots/bot-conversation-view", () => ({
  BotConversationView: (props: {
    botId: string;
    hostId: string;
    botTitle: string;
    offlineHostLabel: string | null;
  }) => (
    <div
      data-testid="stub-conversation"
      data-host-id={props.hostId}
      data-bot-title={props.botTitle}
      data-offline-host-label={props.offlineHostLabel ?? "none"}
    />
  ),
}));
vi.mock("@/components/bots/bot-under-the-hood-panel", () => ({
  BotUnderTheHoodPanel: (props: { offlineHostLabel: string | null }) => (
    <div
      data-testid="stub-under-the-hood"
      data-offline-host-label={props.offlineHostLabel ?? "none"}
    />
  ),
}));
vi.mock("@/components/bots/bot-settings-panel", () => ({
  BotSettingsPanel: (props: { canEdit: boolean }) => (
    <div data-testid="stub-settings" data-can-edit={String(props.canEdit)} />
  ),
}));

import { BotTabSurface } from "@/components/bots/bot-tab-surface";
import { lookupBotTab, useBotTabsStore } from "@/stores/bots/bot-tabs-store";

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER_BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const TAB_HOST = "host-tab";
const BOUND_HOST = "host-bound";

const BOT: BotRecord = {
  botId: BOT_ID,
  environmentId: "env-personal",
  createdByUserId: "user-1",
  title: "Release Bot",
  harness: "claude",
  model: "opus",
  effort: null,
  profile: null,
  trunkChatId: "trunk-1",
  boundHostId: BOUND_HOST,
  hostEpoch: 1,
  createdAt: 1_000,
  archivedAt: null,
};

function snapshotBoundTo(
  hostId: string | null,
  isThisHost: boolean,
): BotSubscriptionSnapshot {
  return {
    bot: { ...BOT, boundHostId: hostId },
    tasks: [],
    openRequestCount: 0,
    boundHost: { hostId, epoch: 1, isThisHost },
  };
}

function surface(): ReactNode {
  return (
    <StrictMode>
      <BotTabSurface botId={BOT_ID} hostId={TAB_HOST} />
    </StrictMode>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.snapshot = snapshotBoundTo(TAB_HOST, true);
  mocks.state.deleted = false;
  mocks.state.error = null;
  mocks.state.paneVisible = true;
  mocks.state.connectable = { hostIds: [TAB_HOST, BOUND_HOST], resolved: true };
  mocks.state.directory = [
    { hostId: TAB_HOST, label: "Laptop" },
    { hostId: BOUND_HOST, label: "Studio Mac" },
  ];
  mocks.state.listedBotIds = undefined;
  mocks.state.claimPending = false;
  mocks.state.support = true;
  useBotTabsStore.setState({ tabs: {} });
  useBotTabsStore
    .getState()
    .openBotTab({ botId: BOT_ID, hostId: TAB_HOST, title: "Release Bot" });
});

afterEach(() => {
  cleanup();
});

describe("<BotTabSurface /> on a host without bots", () => {
  it("shows the update notice naming the host and none of the tab's controls when the host lacks bot.list", () => {
    mocks.state.support = false;
    mocks.state.snapshot = snapshotBoundTo(BOUND_HOST, false);
    render(surface());

    expect(screen.getByTestId("bot-tab-unavailable").textContent).toContain(
      "Bots aren't available on Laptop yet",
    );
    expect(screen.queryByTestId("bot-tab-bound-elsewhere")).toBeNull();
    expect(screen.queryByTestId("bot-tab-move-here")).toBeNull();
    expect(screen.queryByTestId("stub-conversation")).toBeNull();
    expect(screen.queryByTestId("stub-settings")).toBeNull();
  });

  it("draws nothing until the handshake has answered either way", () => {
    mocks.state.support = null;
    const { container } = render(surface());

    expect(container.textContent).toBe("");
    expect(screen.queryByTestId("stub-conversation")).toBeNull();
  });
});

describe("<BotTabSurface /> bound elsewhere", () => {
  it("offers View and Move it here, with no offline wording, while the bound host is dialable", () => {
    mocks.state.snapshot = snapshotBoundTo(BOUND_HOST, false);
    render(surface());

    const banner = screen.getByTestId("bot-tab-bound-elsewhere");
    expect(banner.getAttribute("data-offline")).toBe("false");
    expect(
      screen.getByRole("button", { name: "View on Studio Mac" }),
    ).toBeTruthy();
    expect(screen.getByTestId("bot-tab-move-here")).toBeTruthy();
    expect(
      screen
        .getByTestId("stub-conversation")
        .getAttribute("data-offline-host-label"),
    ).toBe("none");
  });

  it("shows the offline banner without a View button and tells the views which host is away", async () => {
    const user = userEvent.setup();
    mocks.state.snapshot = snapshotBoundTo(BOUND_HOST, false);
    mocks.state.connectable = { hostIds: [TAB_HOST], resolved: true };
    render(surface());

    const banner = screen.getByTestId("bot-tab-bound-elsewhere");
    expect(banner.getAttribute("data-offline")).toBe("true");
    expect(banner.textContent).toContain("Studio Mac");
    expect(banner.textContent).toContain("offline");
    expect(screen.queryByRole("button", { name: /^View on/ })).toBeNull();
    expect(screen.getByTestId("bot-tab-move-here")).toBeTruthy();

    const conversation = screen.getByTestId("stub-conversation");
    expect(conversation.getAttribute("data-offline-host-label")).toBe(
      "Studio Mac",
    );
    expect(conversation.getAttribute("data-host-id")).toBe(TAB_HOST);

    await user.click(screen.getByTestId("bot-tab-view-under-the-hood"));
    expect(
      screen
        .getByTestId("stub-under-the-hood")
        .getAttribute("data-offline-host-label"),
    ).toBe("Studio Mac");
  });

  it("says no host runs the bot and offers only Move it here when its bound host is null", () => {
    mocks.state.snapshot = snapshotBoundTo(null, false);
    // Even before the directory answers: a bot no host runs is never dialable.
    mocks.state.connectable = { hostIds: [], resolved: false };
    render(surface());

    const banner = screen.getByTestId("bot-tab-bound-elsewhere");
    expect(banner.getAttribute("data-offline")).toBe("true");
    expect(banner.textContent).toContain("No host runs this bot");
    expect(banner.textContent).not.toContain("delivered when it is back");
    expect(screen.queryByRole("button", { name: /^View on/ })).toBeNull();
    expect(screen.getByTestId("bot-tab-move-here")).toBeTruthy();
    expect(
      screen
        .getByTestId("stub-conversation")
        .getAttribute("data-offline-host-label"),
    ).toBe("No host");
  });

  it("does not call the host offline before the directory has answered", () => {
    mocks.state.snapshot = snapshotBoundTo(BOUND_HOST, false);
    mocks.state.connectable = { hostIds: [], resolved: false };
    render(surface());

    expect(
      screen
        .getByTestId("bot-tab-bound-elsewhere")
        .getAttribute("data-offline"),
    ).toBe("false");
    expect(
      screen
        .getByTestId("stub-conversation")
        .getAttribute("data-offline-host-label"),
    ).toBe("none");
  });

  it("claims the bot and re-reads the stream when Move it here succeeds", async () => {
    const user = userEvent.setup();
    mocks.state.snapshot = snapshotBoundTo(BOUND_HOST, false);
    mocks.state.connectable = { hostIds: [TAB_HOST], resolved: true };
    render(surface());
    expect(mocks.resubscribe).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("bot-tab-move-here"));

    expect(mocks.claim).toHaveBeenCalledTimes(1);
    expect(mocks.claim).toHaveBeenCalledWith({ botId: BOT_ID });
    expect(mocks.resubscribe).toHaveBeenCalledTimes(1);
  });

  it("shows no banner when the bot is bound to this host", () => {
    render(surface());

    expect(screen.queryByTestId("bot-tab-bound-elsewhere")).toBeNull();
    expect(
      screen
        .getByTestId("stub-conversation")
        .getAttribute("data-offline-host-label"),
    ).toBe("none");
  });
});

describe("<BotTabSurface /> re-subscribe on return", () => {
  it("asks for the stream again when the pane goes from hidden to visible, and only then", () => {
    const view = render(surface());
    expect(mocks.resubscribe).not.toHaveBeenCalled();

    mocks.state.paneVisible = false;
    view.rerender(surface());
    expect(mocks.resubscribe).not.toHaveBeenCalled();

    mocks.state.paneVisible = true;
    view.rerender(surface());
    expect(mocks.resubscribe).toHaveBeenCalledTimes(1);

    view.rerender(surface());
    expect(mocks.resubscribe).toHaveBeenCalledTimes(1);
  });
});

describe("<BotTabSurface /> tab lifetime", () => {
  it("closes the tab when bot.list no longer carries the bot", () => {
    mocks.state.listedBotIds = [OTHER_BOT_ID];
    render(surface());

    expect(lookupBotTab(useBotTabsStore.getState().tabs, BOT_ID)).toBeNull();
  });

  it("keeps the tab while bot.list carries the bot or has not answered", () => {
    mocks.state.listedBotIds = [BOT_ID, OTHER_BOT_ID];
    const view = render(surface());
    expect(
      lookupBotTab(useBotTabsStore.getState().tabs, BOT_ID),
    ).not.toBeNull();

    view.unmount();
    mocks.state.listedBotIds = undefined;
    render(surface());
    expect(
      lookupBotTab(useBotTabsStore.getState().tabs, BOT_ID),
    ).not.toBeNull();
  });

  it("closes the tab on the stream's deleted frame", () => {
    mocks.state.deleted = true;
    render(surface());

    expect(lookupBotTab(useBotTabsStore.getState().tabs, BOT_ID)).toBeNull();
  });
});

describe("<BotTabSurface /> stream error", () => {
  it("keeps the retained snapshot on screen and puts a retry on top of it", async () => {
    const user = userEvent.setup();
    mocks.state.error = "the stream closed";
    render(surface());

    expect(screen.getByTestId("bot-tab-title").textContent).toBe("Release Bot");
    const alert = screen.getByTestId("bot-tab-error");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toContain("the stream closed");
    expect(screen.getByTestId("stub-conversation")).toBeTruthy();

    expect(mocks.resubscribe).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(mocks.resubscribe).toHaveBeenCalledTimes(1);
  });

  it("shows only the error and its retry when no snapshot ever arrived", async () => {
    const user = userEvent.setup();
    mocks.state.snapshot = null;
    mocks.state.error = "the stream closed";
    render(surface());

    expect(screen.getByTestId("bot-tab-error")).toBeTruthy();
    expect(screen.queryByTestId("bot-tab-title")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(mocks.resubscribe).toHaveBeenCalledTimes(1);
  });

  it("shows no error and no connecting state for a healthy stream", () => {
    render(surface());

    expect(screen.queryByTestId("bot-tab-error")).toBeNull();
    expect(screen.queryByTestId("bot-tab-connecting")).toBeNull();
  });

  it("shows the connecting state before the first snapshot", () => {
    mocks.state.snapshot = null;
    render(surface());

    expect(screen.getByTestId("bot-tab-connecting")).toBeTruthy();
  });
});
