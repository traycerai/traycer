/**
 * Where a Home bot row opens its tab (Tracy Bots): on the host the bot RUNS
 * on when that host can be dialled, and through the host this window reads
 * (the effective host) when it cannot - the offline state, where the
 * conversation list and a queued send go through the effective host.
 */
import { StrictMode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotRecord } from "@traycer/protocol/host/bot/schemas";
import type { BotSubscriptionSnapshot } from "@/hooks/bots/use-bot-subscription";

const mocks = vi.hoisted(() => ({
  state: {
    effectiveHostId: "host-effective",
    snapshot: null as BotSubscriptionSnapshot | null,
  },
  navigate: vi.fn(),
  navigateToTabIntent: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));
vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => mocks.state.effectiveHostId,
}));
vi.mock("@/hooks/bots/use-bot-subscription", () => ({
  useBotSubscription: () => ({
    snapshot: mocks.state.snapshot,
    deleted: false,
    error: null,
    isPending: false,
    resubscribe: vi.fn(),
  }),
}));
vi.mock("@/stores/agent-activity-store", () => ({
  useEpicAgentActivity: () => ({ working: new Set<string>() }),
}));
vi.mock("@/lib/tab-navigation", () => ({
  navigateToTabIntent: mocks.navigateToTabIntent,
}));

import { HomeBotRow } from "@/components/home/bots/home-bot-row";
import { useBotTabsStore } from "@/stores/bots/bot-tabs-store";

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";

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
  boundHostId: "host-bound",
  hostEpoch: 1,
  createdAt: 1_000,
  archivedAt: null,
};

const HOST_LABELS: ReadonlyMap<string, string> = new Map([
  ["host-bound", "Studio Mac"],
  ["host-effective", "Laptop"],
]);

function mountRow(connectable: ReadonlyArray<string>): void {
  render(
    <StrictMode>
      <HomeBotRow
        bot={BOT}
        hostLabels={HOST_LABELS}
        connectableHostIds={new Set(connectable)}
      />
    </StrictMode>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.effectiveHostId = "host-effective";
  mocks.state.snapshot = null;
  useBotTabsStore.setState({ tabs: {} });
});

afterEach(() => {
  cleanup();
});

describe("<HomeBotRow /> open host", () => {
  it("opens the tab on the effective host when the bound host is not connectable", async () => {
    const user = userEvent.setup();
    mountRow(["host-effective"]);

    expect(screen.getByTestId("home-bot-host").textContent).toContain(
      "Studio Mac",
    );
    expect(screen.getByTestId("home-bot-host").textContent).toContain(
      "offline",
    );
    await user.click(screen.getByTestId("home-bot-row"));

    const record = useBotTabsStore.getState().tabs[BOT_ID];
    expect(record.hostId).toBe("host-effective");
    expect(record.title).toBe("Release Bot");
    expect(mocks.navigateToTabIntent).toHaveBeenCalledTimes(1);
  });

  it("opens the tab on the bound host when it is connectable", async () => {
    const user = userEvent.setup();
    mountRow(["host-effective", "host-bound"]);

    expect(screen.getByTestId("home-bot-host").textContent).not.toContain(
      "offline",
    );
    await user.click(screen.getByTestId("home-bot-row"));

    expect(useBotTabsStore.getState().tabs[BOT_ID].hostId).toBe("host-bound");
    expect(mocks.navigateToTabIntent).toHaveBeenCalledTimes(1);
  });

  it("follows the snapshot's fresher host when deciding where to open", async () => {
    const user = userEvent.setup();
    mocks.state.snapshot = {
      bot: { ...BOT, boundHostId: "host-moved", hostEpoch: 2 },
      tasks: [],
      openRequestCount: 0,
      boundHost: { hostId: "host-moved", epoch: 2, isThisHost: false },
    };
    mountRow(["host-effective", "host-moved"]);

    await user.click(screen.getByTestId("home-bot-row"));

    expect(useBotTabsStore.getState().tabs[BOT_ID].hostId).toBe("host-moved");
  });

  it("renders a bot no host runs as offline, labelled No host, and opens through the effective host", async () => {
    const user = userEvent.setup();
    render(
      <StrictMode>
        <HomeBotRow
          bot={{ ...BOT, boundHostId: null }}
          hostLabels={HOST_LABELS}
          connectableHostIds={new Set(["host-effective", "host-bound"])}
        />
      </StrictMode>,
    );

    expect(screen.getByTestId("home-bot-host").textContent).toContain(
      "No host",
    );
    expect(screen.getByTestId("home-bot-host").textContent).toContain(
      "offline",
    );
    await user.click(screen.getByTestId("home-bot-row"));

    expect(useBotTabsStore.getState().tabs[BOT_ID].hostId).toBe(
      "host-effective",
    );
  });
});
