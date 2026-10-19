/**
 * The bot tab's surface (Tracy Bots): the tab asks `bot.open` through its own
 * host and follows the answer - serving here, moving to a host this client can
 * dial, or paused with a reason - and never names the machine a bot runs on.
 * Also: the stream's states, the re-subscribe and re-open when the pane comes
 * back into view, and the tab closing when the bot is gone from `bot.list`.
 * The three views are replaced by stubs that expose their props, so what the
 * surface PASSES them is what is asserted.
 */
import { StrictMode, type ReactNode } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BotOpenPausedReason,
  BotOpenResponse,
  BotRecord,
} from "@traycer/protocol/host/bot/schemas";
import type { BotSubscriptionSnapshot } from "@/hooks/bots/use-bot-subscription";

type OpenResult =
  | { readonly kind: "answer"; readonly response: BotOpenResponse }
  | { readonly kind: "error"; readonly message: string };

const mocks = vi.hoisted(() => ({
  hostClient: { stub: "tab-host-client" },
  resubscribe: vi.fn<() => void>(),
  open: vi.fn<(variables: { botId: string }) => void>(),
  openMutation: {
    mutate: (
      variables: { botId: string },
      options: {
        onSuccess: (response: BotOpenResponse) => void;
        onError: (error: { message: string }) => void;
      },
    ): void => {
      mocks.open(variables);
      const result = mocks.state.openResult;
      if (result === null) return;
      if (result.kind === "answer") options.onSuccess(result.response);
      else options.onError({ message: result.message });
    },
  },
  supportQueries: [] as Array<{ hostId: string | null; method: string }>,
  useBotListChangedSubscriptionForHost:
    vi.fn<(hostId: string, enabled: boolean) => void>(),
  state: {
    snapshot: null as BotSubscriptionSnapshot | null,
    deleted: false,
    error: null as string | null,
    paneVisible: true,
    connectable: { hostIds: [] as string[], resolved: true },
    listedBotIds: undefined as string[] | undefined,
    support: null as boolean | null,
    openResult: null as OpenResult | null,
  },
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: (hostId: string | null, method: string) => {
    mocks.supportQueries.push({ hostId, method });
    return mocks.state.support;
  },
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
// The directory still holds host labels: if the tab ever read it to say where
// the bot runs, a label would reach the screen and the no-machine checks below
// would catch it.
vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({
    data: [
      { hostId: "host-tab", label: "Laptop" },
      { hostId: "host-bound", label: "Studio Mac" },
    ],
  }),
}));
vi.mock("@/hooks/bots/use-bot-list-query", () => ({
  useBotListQuery: () => ({
    data:
      mocks.state.listedBotIds === undefined
        ? undefined
        : { bots: mocks.state.listedBotIds.map((botId) => ({ botId })) },
  }),
}));
vi.mock("@/hooks/bots/use-bot-list-changed-subscription", () => ({
  useBotListChangedSubscriptionForHost: (hostId: string, enabled: boolean) =>
    mocks.useBotListChangedSubscriptionForHost(hostId, enabled),
}));
vi.mock("@/hooks/bots/use-environment-list-query", () => ({
  useEnvironmentListQuery: () => ({
    data: {
      environments: [{ environmentId: "env-team", label: "Acme" }],
    },
  }),
}));
// One stable mutation object, like TanStack's `mutate`: the surface re-opens
// from an effect keyed on it.
vi.mock("@/hooks/bots/use-bot-mutations", () => ({
  useBotOpenMutation: () => mocks.openMutation,
}));
vi.mock("@/components/bots/bot-conversation-view", () => ({
  BotConversationView: (props: {
    botId: string;
    hostId: string;
    botTitle: string;
    paused: boolean;
  }) => (
    <div
      data-testid="stub-conversation"
      data-host-id={props.hostId}
      data-bot-title={props.botTitle}
      data-paused={String(props.paused)}
    />
  ),
}));
vi.mock("@/components/bots/bot-under-the-hood-panel", () => ({
  BotUnderTheHoodPanel: (props: { paused: boolean }) => (
    <div data-testid="stub-under-the-hood" data-paused={String(props.paused)} />
  ),
}));
// The panel takes the bot and nothing else: no prop says which host serves the
// tab, so no control can be gated on it. The stub lists the props it was given.
vi.mock("@/components/bots/bot-settings-panel", () => ({
  BotSettingsPanel: (props: object) => (
    <div
      data-testid="stub-settings"
      data-prop-names={Object.keys(props).join(",")}
    />
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
  environmentId: "env-team",
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

function snapshot(): BotSubscriptionSnapshot {
  return {
    bot: BOT,
    tasks: [],
    openRequestCount: 0,
    boundHost: { hostId: BOUND_HOST, epoch: 1, isThisHost: false },
  };
}

function answer(outcome: BotOpenResponse["outcome"]): OpenResult {
  return { kind: "answer", response: { bot: BOT, outcome } };
}

function surface(): ReactNode {
  return (
    <StrictMode>
      <BotTabSurface botId={BOT_ID} hostId={TAB_HOST} />
    </StrictMode>
  );
}

/** Nothing on a tab says where a bot runs or offers to move it. */
function expectNoMachineWording(container: HTMLElement): void {
  expect(container.textContent).not.toMatch(
    /View on|Move it here|Studio Mac|Laptop|host-bound|host-tab|offline/i,
  );
  expect(screen.queryByTestId("bot-tab-bound-elsewhere")).toBeNull();
  expect(screen.queryByTestId("bot-tab-move-here")).toBeNull();
}

function tabHostIdInStore(): string | null {
  const record = lookupBotTab(useBotTabsStore.getState().tabs, BOT_ID);
  return record === null ? null : record.hostId;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.supportQueries.length = 0;
  mocks.state.snapshot = snapshot();
  mocks.state.deleted = false;
  mocks.state.error = null;
  mocks.state.paneVisible = true;
  mocks.state.connectable = { hostIds: [TAB_HOST, BOUND_HOST], resolved: true };
  mocks.state.listedBotIds = undefined;
  mocks.state.support = true;
  mocks.state.openResult = answer({ kind: "serve-here", claimed: null });
  useBotTabsStore.setState({ tabs: {} });
  useBotTabsStore
    .getState()
    .openBotTab({ botId: BOT_ID, hostId: TAB_HOST, title: "Release Bot" });
});

afterEach(() => {
  cleanup();
});

describe("<BotTabSurface /> on a host without bot.open", () => {
  it("asks about bot.open on the tab's own host", () => {
    render(surface());

    expect(mocks.supportQueries).toContainEqual({
      hostId: TAB_HOST,
      method: "bot.open",
    });
    expect(mocks.supportQueries.every((q) => q.method === "bot.open")).toBe(
      true,
    );
  });

  it("shows the update notice, without naming a host, and none of the tab's controls", () => {
    mocks.state.support = false;
    render(surface());

    expect(screen.getByTestId("bot-tab-unavailable").textContent).toContain(
      "Bots aren't available on this host yet",
    );
    expect(screen.queryByTestId("stub-conversation")).toBeNull();
    expect(screen.queryByTestId("stub-settings")).toBeNull();
    expect(screen.queryByTestId("bot-tab-paused")).toBeNull();
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("draws nothing, and opens nothing, until the handshake has answered either way", () => {
    mocks.state.support = null;
    const { container } = render(surface());

    expect(container.textContent).toBe("");
    expect(screen.queryByTestId("stub-conversation")).toBeNull();
    expect(mocks.open).not.toHaveBeenCalled();
  });
});

describe("<BotTabSurface /> bot.open", () => {
  it("opens the bot once on mount, for this bot", () => {
    render(<BotTabSurface botId={BOT_ID} hostId={TAB_HOST} />);

    expect(mocks.open).toHaveBeenCalledTimes(1);
    expect(mocks.open).toHaveBeenCalledWith({ botId: BOT_ID });
  });

  it("shows the connecting state until bot.open answers", () => {
    mocks.state.openResult = null;
    render(surface());

    expect(screen.getByTestId("bot-tab-connecting")).toBeTruthy();
    expect(screen.queryByTestId("stub-conversation")).toBeNull();
    expect(screen.queryByTestId("bot-tab-paused")).toBeNull();
  });

  it("shows the full tab, unpaused and with no banner, when this host serves the bot", () => {
    const { container } = render(surface());

    expect(screen.getByTestId("bot-tab-title").textContent).toBe("Release Bot");
    expect(
      screen.getByTestId("stub-conversation").getAttribute("data-paused"),
    ).toBe("false");
    expect(screen.queryByTestId("bot-tab-paused")).toBeNull();
    expect(screen.queryByTestId("bot-tab-error")).toBeNull();
    expect(screen.queryByTestId("bot-tab-connecting")).toBeNull();
    expectNoMachineWording(container);
  });

  it("is also the full tab when this host claimed the bot", () => {
    mocks.state.openResult = answer({
      kind: "serve-here",
      claimed: "bound-host-unreachable",
    });
    render(surface());

    expect(screen.getByTestId("stub-conversation")).toBeTruthy();
    expect(screen.queryByTestId("bot-tab-paused")).toBeNull();
  });

  it("labels the tab with the environment and nothing about a machine", () => {
    const { container } = render(surface());

    expect(screen.getByRole("banner").textContent).toContain("Acme");
    expectNoMachineWording(container);
  });
});

describe("<BotTabSurface /> another host serves the bot", () => {
  const SERVED_ELSEWHERE = answer({
    kind: "serve-on-bound-host",
    hostId: BOUND_HOST,
    why: "reachable",
  });

  it("moves the tab to that host silently when this client can dial it", () => {
    mocks.state.openResult = SERVED_ELSEWHERE;
    const { container } = render(surface());

    expect(tabHostIdInStore()).toBe(BOUND_HOST);
    // Until the surface remounts on the new host: a spinner, no banner.
    expect(screen.getByTestId("bot-tab-connecting")).toBeTruthy();
    expect(screen.queryByTestId("bot-tab-paused")).toBeNull();
    expect(screen.queryByTestId("stub-conversation")).toBeNull();
    expectNoMachineWording(container);
  });

  it("moves it as well when another host claimed the bot while this one was deciding", () => {
    mocks.state.openResult = answer({
      kind: "serve-on-bound-host",
      hostId: BOUND_HOST,
      why: "claimed-concurrently",
    });
    render(surface());

    expect(tabHostIdInStore()).toBe(BOUND_HOST);
  });

  it("pauses on the opening host, with no move, when this client cannot dial that host", () => {
    mocks.state.openResult = SERVED_ELSEWHERE;
    mocks.state.connectable = { hostIds: [TAB_HOST], resolved: true };
    const { container } = render(surface());

    expect(tabHostIdInStore()).toBe(TAB_HOST);
    const banner = screen.getByTestId("bot-tab-paused");
    expect(banner.getAttribute("data-reason")).toBe("bound-host-not-dialable");
    expect(banner.textContent).toContain("Acme");
    expect(within(banner).queryByRole("button")).toBeNull();
    expect(
      screen.getByTestId("stub-conversation").getAttribute("data-paused"),
    ).toBe("true");
    expect(
      screen.getByTestId("stub-conversation").getAttribute("data-host-id"),
    ).toBe(TAB_HOST);
    expectNoMachineWording(container);
  });

  it("neither calls the host undialable nor moves the tab before the directory has answered", () => {
    mocks.state.openResult = SERVED_ELSEWHERE;
    mocks.state.connectable = { hostIds: [], resolved: false };
    render(surface());

    expect(screen.queryByTestId("bot-tab-paused")).toBeNull();
    expect(screen.getByTestId("bot-tab-connecting")).toBeTruthy();
    // Moving now could strand the tab on a host this client never reaches.
    expect(tabHostIdInStore()).toBe(TAB_HOST);
  });
});

describe("<BotTabSurface /> paused", () => {
  const PAUSED_COPY: ReadonlyArray<{
    reason: BotOpenPausedReason;
    text: string;
    retry: boolean;
  }> = [
    {
      reason: "host-not-in-environment",
      text: "Paused: the machine this bot runs on is away, and this one doesn't run Acme's bots. Messages you send are delivered when it's back.",
      retry: false,
    },
    {
      reason: "bound-to-sandbox",
      text: "This bot's conversation can't be shown here. Messages you send still reach it.",
      retry: false,
    },
    {
      reason: "bound-host-not-observable",
      text: "This bot's conversation can't be shown here. Messages you send still reach it.",
      retry: false,
    },
    {
      reason: "reachability-unknown",
      text: "Couldn't check whether this bot is running.",
      retry: true,
    },
    {
      reason: "trunk-busy",
      text: "Finishing an earlier turn here. Try again in a moment.",
      retry: true,
    },
  ];

  it.each(PAUSED_COPY)(
    "says $reason in its own words, names no machine, and offers Retry: $retry",
    ({ reason, text, retry }) => {
      mocks.state.openResult = answer({ kind: "paused", reason });
      const { container } = render(surface());

      const banner = screen.getByTestId("bot-tab-paused");
      expect(banner.getAttribute("data-reason")).toBe(reason);
      expect(banner.getAttribute("role")).toBe("status");
      expect(banner.textContent).toContain(text);
      expect(within(banner).queryAllByRole("button")).toHaveLength(
        retry ? 1 : 0,
      );
      expectNoMachineWording(container);
    },
  );

  it("hands the conversation view the paused flag, whose placeholder names no machine", () => {
    mocks.state.openResult = answer({
      kind: "paused",
      reason: "host-not-in-environment",
    });
    render(surface());

    expect(
      screen.getByTestId("stub-conversation").getAttribute("data-paused"),
    ).toBe("true");
  });

  it("hands the under-the-hood view the paused flag too", async () => {
    const user = userEvent.setup();
    mocks.state.openResult = answer({
      kind: "paused",
      reason: "bound-to-sandbox",
    });
    render(surface());

    await user.click(screen.getByTestId("bot-tab-view-under-the-hood"));
    expect(
      screen.getByTestId("stub-under-the-hood").getAttribute("data-paused"),
    ).toBe("true");
  });

  it("keeps Settings ungated: the panel is given the bot and no editing flag", async () => {
    const user = userEvent.setup();
    mocks.state.openResult = answer({
      kind: "paused",
      reason: "bound-host-not-observable",
    });
    render(surface());

    await user.click(screen.getByTestId("bot-tab-view-settings"));
    expect(
      screen.getByTestId("stub-settings").getAttribute("data-prop-names"),
    ).toBe("bot");
  });

  it("asks again on Retry and drops the banner when the answer changes", async () => {
    const user = userEvent.setup();
    mocks.state.openResult = answer({
      kind: "paused",
      reason: "reachability-unknown",
    });
    render(<BotTabSurface botId={BOT_ID} hostId={TAB_HOST} />);
    expect(mocks.open).toHaveBeenCalledTimes(1);

    mocks.state.openResult = answer({ kind: "serve-here", claimed: null });
    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(mocks.open).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("bot-tab-paused")).toBeNull();
    expect(
      screen.getByTestId("stub-conversation").getAttribute("data-paused"),
    ).toBe("false");
  });
});

describe("<BotTabSurface /> bot.open fails", () => {
  it("shows the error with a Retry, and no tab, when there is no earlier answer", async () => {
    const user = userEvent.setup();
    mocks.state.openResult = { kind: "error", message: "the host is busy" };
    render(<BotTabSurface botId={BOT_ID} hostId={TAB_HOST} />);

    const alert = screen.getByTestId("bot-tab-error");
    expect(alert.textContent).toContain(
      "Couldn't open this bot: the host is busy",
    );
    expect(screen.queryByTestId("bot-tab-title")).toBeNull();
    expect(screen.queryByTestId("stub-conversation")).toBeNull();

    mocks.state.openResult = answer({ kind: "serve-here", claimed: null });
    await user.click(within(alert).getByRole("button", { name: "Retry" }));

    expect(mocks.open).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("bot-tab-error")).toBeNull();
    expect(screen.getByTestId("stub-conversation")).toBeTruthy();
  });

  it("keeps the tab and shows the error above it when a re-open fails after an answer", async () => {
    const user = userEvent.setup();
    const view = render(surface());
    expect(screen.getByTestId("stub-conversation")).toBeTruthy();

    mocks.state.openResult = { kind: "error", message: "network down" };
    mocks.state.paneVisible = false;
    view.rerender(surface());
    mocks.state.paneVisible = true;
    view.rerender(surface());

    const alert = screen.getByTestId("bot-tab-error");
    expect(alert.textContent).toContain("Couldn't open this bot: network down");
    expect(screen.getByTestId("stub-conversation")).toBeTruthy();
    expect(screen.getByTestId("bot-tab-title")).toBeTruthy();

    mocks.state.openResult = answer({ kind: "serve-here", claimed: null });
    const callsBefore = mocks.open.mock.calls.length;
    await user.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(mocks.open.mock.calls.length).toBe(callsBefore + 1);
    expect(screen.queryByTestId("bot-tab-error")).toBeNull();
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

  it("opens the bot again when the pane comes back, since its host may have come or gone", () => {
    const view = render(surface());
    const callsAfterMount = mocks.open.mock.calls.length;

    mocks.state.paneVisible = false;
    view.rerender(surface());
    expect(mocks.open.mock.calls.length).toBe(callsAfterMount);

    mocks.state.paneVisible = true;
    view.rerender(surface());
    expect(mocks.open.mock.calls.length).toBe(callsAfterMount + 1);
  });

  it("opens the bot again when the window returns to view while this tab is the one showing", () => {
    render(surface());
    const callsAfterMount = mocks.open.mock.calls.length;

    document.dispatchEvent(new Event("visibilitychange"));

    expect(mocks.open.mock.calls.length).toBe(callsAfterMount + 1);
    expect(mocks.resubscribe).toHaveBeenCalledTimes(1);
  });

  it("leaves a hidden tab alone when the window returns, since an open can claim the bot onto this host", () => {
    mocks.state.paneVisible = false;
    render(surface());
    const callsAfterMount = mocks.open.mock.calls.length;

    document.dispatchEvent(new Event("visibilitychange"));

    expect(mocks.open.mock.calls.length).toBe(callsAfterMount);
    expect(mocks.resubscribe).not.toHaveBeenCalled();
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

  it("keeps bot.list current through the change stream on the tab's own host", () => {
    render(surface());

    expect(mocks.useBotListChangedSubscriptionForHost).toHaveBeenLastCalledWith(
      TAB_HOST,
      true,
    );
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
