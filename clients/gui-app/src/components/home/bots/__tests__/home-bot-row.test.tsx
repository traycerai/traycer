/**
 * A Home bot row (Tracy Bots): says working, idle or paused and never which
 * machine the bot runs on, and opens its tab through the host this window
 * reads (the effective host), moving an existing tab off a host this client
 * can no longer dial.
 */
import { StrictMode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotRecord } from "@traycer/protocol/host/bot/schemas";
import type { BotSubscriptionSnapshot } from "@/hooks/bots/use-bot-subscription";

interface MockState {
  effectiveHostId: string | null;
  snapshot: BotSubscriptionSnapshot | null;
  working: boolean;
}

const mocks = vi.hoisted(() => {
  const state: MockState = {
    effectiveHostId: "host-effective",
    snapshot: null,
    working: false,
  };
  return { state, navigate: vi.fn(), navigateToTabIntent: vi.fn() };
});

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
  useEpicAgentActivity: () => ({
    working: new Set<string>(mocks.state.working ? ["agent-1"] : []),
  }),
}));
vi.mock("@/lib/tab-navigation", () => ({
  navigateToTabIntent: mocks.navigateToTabIntent,
}));

import {
  HomeBotRow,
  type HomeBotHostReach,
} from "@/components/home/bots/home-bot-row";
import { lookupBotTab, useBotTabsStore } from "@/stores/bots/bot-tabs-store";

const BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OWN = "host-own";
const EFFECTIVE = "host-effective";
const TEAMMATE = "host-teammate";
const SANDBOX = "host-sandbox";

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
  boundHostId: OWN,
  hostEpoch: 1,
  createdAt: 1_000,
  archivedAt: null,
};

interface Mount {
  readonly bot: BotRecord;
  /** The reader's own hosts. */
  readonly directory: ReadonlyArray<string>;
  /** Of those, the ones this client can dial. */
  readonly connectable: ReadonlyArray<string>;
  /** Whether the directory has answered; false makes `connectable` unknown. */
  readonly connectableResolved: boolean;
  readonly environmentHostIds: ReadonlySet<string> | null;
  /** The bot's environment's owner kind. */
  readonly environmentOwnerKind: "user" | "organization" | null;
  /** The reader's own hosts the registry calls personal; `null` while the
   * registry has not answered. */
  readonly personal: ReadonlyArray<string> | null;
  /** The row's "Created by …" line; null for none. */
  readonly createdBy: string | null;
}

function reach(input: Mount): HomeBotHostReach {
  return {
    directoryHostIds: new Set(input.directory),
    connectableHostIds: new Set(input.connectable),
    connectableResolved: input.connectableResolved,
    personalHostIds: input.personal === null ? null : new Set(input.personal),
  };
}

const OWN_AND_DIALABLE: Mount = {
  bot: BOT,
  directory: [OWN, EFFECTIVE],
  connectable: [OWN, EFFECTIVE],
  connectableResolved: true,
  environmentHostIds: new Set(),
  environmentOwnerKind: "organization",
  personal: [],
  createdBy: null,
};

function mountRow(input: Mount): void {
  render(
    <StrictMode>
      <HomeBotRow
        bot={input.bot}
        hostReach={reach(input)}
        environmentHostIds={input.environmentHostIds}
        environmentOwnerKind={input.environmentOwnerKind}
        createdBy={input.createdBy}
      />
    </StrictMode>,
  );
}

function stateBadge(): { text: string; state: string | null } {
  const badge = screen.getByTestId("home-bot-state");
  return { text: badge.textContent, state: badge.getAttribute("data-state") };
}

function tabHostId(): string | null {
  const record = lookupBotTab(useBotTabsStore.getState().tabs, BOT_ID);
  return record === null ? null : record.hostId;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.effectiveHostId = EFFECTIVE;
  mocks.state.snapshot = null;
  mocks.state.working = false;
  useBotTabsStore.setState({ tabs: {} });
});

afterEach(() => {
  cleanup();
});

describe("<HomeBotRow /> state", () => {
  it("says Idle for a bot on one of the reader's own hosts that can be dialled", () => {
    mountRow(OWN_AND_DIALABLE);

    expect(stateBadge()).toEqual({ text: "Idle", state: "idle" });
  });

  it("says Working while the bot's agents run", () => {
    mocks.state.working = true;
    mountRow(OWN_AND_DIALABLE);

    expect(stateBadge()).toEqual({ text: "Working", state: "working" });
  });

  it("says Paused for a bot on one of the reader's own hosts that cannot be dialled", () => {
    mountRow({ ...OWN_AND_DIALABLE, connectable: [EFFECTIVE] });

    expect(stateBadge()).toEqual({ text: "Paused", state: "paused" });
  });

  it("says Idle, not Paused, for a bot on the reader's own host while the host directory has not answered", () => {
    mountRow({
      ...OWN_AND_DIALABLE,
      directory: [],
      connectable: [],
      connectableResolved: false,
    });

    expect(stateBadge()).toEqual({ text: "Idle", state: "idle" });
  });

  it("says Paused for a bot no host runs", () => {
    mountRow({ ...OWN_AND_DIALABLE, bot: { ...BOT, boundHostId: null } });

    expect(stateBadge()).toEqual({ text: "Paused", state: "paused" });
  });

  it("says Paused for a team bot bound to one of the reader's personal hosts, though it can be dialled", () => {
    mountRow({ ...OWN_AND_DIALABLE, personal: [OWN] });

    expect(stateBadge()).toEqual({ text: "Paused", state: "paused" });
  });

  it("says Idle, not Working, for a team bot while the registry has not answered which hosts are personal", () => {
    mocks.state.working = true;
    mountRow({ ...OWN_AND_DIALABLE, personal: null });

    expect(stateBadge()).toEqual({ text: "Idle", state: "idle" });
  });

  it("says Idle for a personal environment's bot on the same dialable personal host", () => {
    mountRow({
      ...OWN_AND_DIALABLE,
      environmentOwnerKind: "user",
      personal: [OWN],
    });

    expect(stateBadge()).toEqual({ text: "Idle", state: "idle" });
  });

  it("says Paused for a personal bot bound to a machine outside the reader's directory", () => {
    mountRow({
      ...OWN_AND_DIALABLE,
      bot: { ...BOT, boundHostId: TEAMMATE },
      environmentHostIds: new Set(),
    });

    expect(stateBadge().state).toBe("paused");
  });

  it("says Idle for a team bot on the team's sandbox, which the team's list carries", () => {
    mountRow({
      ...OWN_AND_DIALABLE,
      bot: { ...BOT, boundHostId: SANDBOX },
      environmentHostIds: new Set([SANDBOX]),
    });

    expect(stateBadge().state).toBe("idle");
  });

  it("says Idle for a team bot while the team's machine list has not answered", () => {
    mountRow({
      ...OWN_AND_DIALABLE,
      bot: { ...BOT, boundHostId: TEAMMATE },
      environmentHostIds: null,
    });

    expect(stateBadge().state).toBe("idle");
  });

  it("says Paused for a team bot on another member's laptop the team's list does not carry", () => {
    mountRow({
      ...OWN_AND_DIALABLE,
      bot: { ...BOT, boundHostId: TEAMMATE },
      environmentHostIds: new Set([SANDBOX]),
    });

    expect(stateBadge().state).toBe("paused");
  });

  it("follows the snapshot's fresher bound host", () => {
    mocks.state.snapshot = {
      bot: { ...BOT, boundHostId: null, hostEpoch: 2 },
      tasks: [],
      openRequestCount: 0,
      boundHost: { hostId: null, epoch: 2, isThisHost: false },
    };
    mountRow(OWN_AND_DIALABLE);

    expect(stateBadge().state).toBe("paused");
  });

  it("names no machine, offline state or working dot, whatever the state", () => {
    for (const input of [
      OWN_AND_DIALABLE,
      { ...OWN_AND_DIALABLE, connectable: [EFFECTIVE] },
      { ...OWN_AND_DIALABLE, bot: { ...BOT, boundHostId: null } },
    ]) {
      mountRow(input);
      const row = screen.getByTestId("home-bot-row");
      expect(row.textContent).toContain("Release Bot");
      expect(row.textContent).not.toMatch(
        /host-|Studio Mac|Laptop|offline|No host/i,
      );
      expect(screen.queryByTestId("home-bot-host")).toBeNull();
      expect(screen.queryByTestId("home-bot-working")).toBeNull();
      cleanup();
    }
  });
});

describe("<HomeBotRow /> open", () => {
  it("opens a new tab through the effective host, never the bound host", async () => {
    const user = userEvent.setup();
    mountRow(OWN_AND_DIALABLE);

    await user.click(screen.getByTestId("home-bot-row"));

    expect(tabHostId()).toBe(EFFECTIVE);
    expect(useBotTabsStore.getState().tabs[BOT_ID].title).toBe("Release Bot");
    expect(mocks.navigateToTabIntent).toHaveBeenCalledTimes(1);
  });

  it("opens through the effective host for a paused bot too", async () => {
    const user = userEvent.setup();
    mountRow({ ...OWN_AND_DIALABLE, bot: { ...BOT, boundHostId: null } });

    await user.click(screen.getByTestId("home-bot-row"));

    expect(tabHostId()).toBe(EFFECTIVE);
    expect(mocks.navigateToTabIntent).toHaveBeenCalledTimes(1);
  });

  it("keeps an open tab on a host this client can still dial", async () => {
    const user = userEvent.setup();
    useBotTabsStore
      .getState()
      .openBotTab({ botId: BOT_ID, hostId: OWN, title: "Release Bot" });
    mountRow(OWN_AND_DIALABLE);

    await user.click(screen.getByTestId("home-bot-row"));

    expect(tabHostId()).toBe(OWN);
    expect(mocks.navigateToTabIntent).toHaveBeenCalledTimes(1);
  });

  it("moves an open tab off a host this client can no longer dial onto the effective host", async () => {
    const user = userEvent.setup();
    useBotTabsStore
      .getState()
      .openBotTab({ botId: BOT_ID, hostId: TEAMMATE, title: "Release Bot" });
    mountRow(OWN_AND_DIALABLE);

    await user.click(screen.getByTestId("home-bot-row"));

    expect(tabHostId()).toBe(EFFECTIVE);
    expect(mocks.navigateToTabIntent).toHaveBeenCalledTimes(1);
  });

  it("keeps an open tab where it is while the directory has not answered, whatever host it is on", async () => {
    const user = userEvent.setup();
    useBotTabsStore
      .getState()
      .openBotTab({ botId: BOT_ID, hostId: TEAMMATE, title: "Release Bot" });
    mountRow({
      ...OWN_AND_DIALABLE,
      connectable: [],
      connectableResolved: false,
    });

    await user.click(screen.getByTestId("home-bot-row"));

    expect(tabHostId()).toBe(TEAMMATE);
    expect(mocks.navigateToTabIntent).toHaveBeenCalledTimes(1);
  });

  it("opens nothing, and disables the row, while there is no effective host", async () => {
    const user = userEvent.setup();
    mocks.state.effectiveHostId = null;
    mountRow(OWN_AND_DIALABLE);

    const row = screen.getByTestId("home-bot-row");
    expect(row).toHaveProperty("disabled", true);
    await user.click(row);

    expect(tabHostId()).toBeNull();
    expect(mocks.navigateToTabIntent).not.toHaveBeenCalled();
  });
});
