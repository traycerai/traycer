/**
 * The bot tab kind (Tracy Bots): the kind module's projection, the bot-tabs
 * source store behind it, and the seams that join them to the strip -
 * `tabSourceRefs`, `isSourceBackedTabKind`, the route parser and the real
 * `getHeaderTabs()` projection against the actual stores.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { botPathname, botRoute, readBotIdFromPath } from "@/lib/routes";
import { botTabIntent } from "@/lib/tab-navigation/intents";
import {
  botTabRecords,
  lookupBotTab,
  useBotTabsStore,
  type BotTabRecord,
} from "@/stores/bots/bot-tabs-store";
import { useBotOpenThreadStore } from "@/stores/bots/bot-open-thread-store";
import { botTabModule, isOpenBotTab } from "@/stores/tabs/kinds/bot";
import {
  TAB_KINDS,
  tabEpicId,
  tabMatchesPath,
  tabRequestClose,
  tabResolveIntent,
  tabRouteOptions,
} from "@/stores/tabs/registry";
import {
  isSourceBackedTabKind,
  tabSourceRefs,
} from "@/stores/tabs/source-refs";
import { useTabsStore } from "@/stores/tabs/store";
import type { TabRef } from "@/stores/tabs/types";
import { getHeaderTabs } from "@/stores/tabs/use-header-tabs";

const BOT_A = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const BOT_B = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAW";

function record(botId: string, hostId: string, title: string): BotTabRecord {
  return { botId, hostId, title, openedAt: 1_000 };
}

function resetStores(): void {
  useBotTabsStore.setState({ tabs: {} });
  useBotOpenThreadStore.setState({ byBotId: {} });
  useTabsStore.setState(useTabsStore.getInitialState(), true);
}

describe("bot tab kind - build and descriptor", () => {
  it("projects a record into a non-duplicable, single-window bot header tab", () => {
    const tab = TAB_KINDS.bot.build(record(BOT_A, "host-1", "Release Bot"));
    expect(tab).toMatchObject({
      kind: "bot",
      id: BOT_A,
      hostId: "host-1",
      route: `/bot/${encodeURIComponent(BOT_A)}`,
      name: "Release Bot",
      canDuplicate: false,
      canOpenInNewWindow: false,
    });
    expect(TAB_KINDS.bot).toBe(botTabModule);
  });

  it("matches only its own exact route", () => {
    const tab = TAB_KINDS.bot.build(record(BOT_A, "host-1", "Release Bot"));
    expect(tabMatchesPath(tab, botPathname(BOT_A))).toBe(true);
    expect(tabMatchesPath(tab, `${botPathname(BOT_A)}/extra`)).toBe(false);
    expect(tabMatchesPath(tab, botPathname(BOT_B))).toBe(false);
    expect(tabMatchesPath(tab, "/")).toBe(false);
  });

  it("owns no epic, resolves to a bot intent and routes to /bot/$botId", () => {
    const tab = TAB_KINDS.bot.build(record(BOT_A, "host-1", "Release Bot"));
    expect(tabEpicId(tab)).toBeNull();
    expect(tabResolveIntent(tab)).toEqual(botTabIntent(BOT_A));
    expect(tabRouteOptions(botTabIntent(BOT_A))).toEqual(botRoute(BOT_A));
  });

  it("closes through its own ref", () => {
    const tab = TAB_KINDS.bot.build(record(BOT_A, "host-1", "Release Bot"));
    const closed: TabRef[] = [];
    tabRequestClose(tab, (ref) => {
      closed.push(ref);
    });
    expect(closed).toEqual([{ kind: "bot", id: BOT_A }]);
  });
});

describe("bot-tabs store", () => {
  beforeEach(resetStores);
  afterEach(resetStores);

  it("keeps one record when the same bot is opened twice: the host wins, the title refreshes", () => {
    const { openBotTab } = useBotTabsStore.getState();
    openBotTab({ botId: BOT_A, hostId: "host-1", title: "Old" });
    openBotTab({ botId: BOT_A, hostId: "host-2", title: "New" });

    const tabs = useBotTabsStore.getState().tabs;
    expect(Object.keys(tabs)).toEqual([BOT_A]);
    expect(lookupBotTab(tabs, BOT_A)).toMatchObject({
      hostId: "host-1",
      title: "New",
    });
    expect(isOpenBotTab(BOT_A)).toBe(true);
  });

  it("closeBotTab removes the record", () => {
    const { openBotTab, closeBotTab } = useBotTabsStore.getState();
    openBotTab({ botId: BOT_A, hostId: "host-1", title: "A" });
    openBotTab({ botId: BOT_B, hostId: "host-1", title: "B" });
    closeBotTab(BOT_A);

    const tabs = useBotTabsStore.getState().tabs;
    expect(lookupBotTab(tabs, BOT_A)).toBeNull();
    expect(lookupBotTab(tabs, BOT_B)).not.toBeNull();
    expect(isOpenBotTab(BOT_A)).toBe(false);
  });

  it("reopens a closed bot's tab with no thread open, and leaves another bot's thread open", () => {
    const { openBotTab, closeBotTab } = useBotTabsStore.getState();
    const { setRail } = useBotOpenThreadStore.getState();
    openBotTab({ botId: BOT_A, hostId: "host-1", title: "A" });
    openBotTab({ botId: BOT_B, hostId: "host-1", title: "B" });
    setRail(BOT_A, {
      kind: "thread",
      anchorMessageId: "post-a",
      announcement: false,
      answer: false,
      sent: null,
    });
    setRail(BOT_B, {
      kind: "thread",
      anchorMessageId: "post-b",
      announcement: false,
      answer: false,
      sent: null,
    });

    closeBotTab(BOT_A);
    openBotTab({ botId: BOT_A, hostId: "host-1", title: "A" });

    expect(useBotOpenThreadStore.getState().byBotId).toEqual({
      [BOT_B]: {
        kind: "thread",
        anchorMessageId: "post-b",
        announcement: false,
        answer: false,
        sent: null,
      },
    });
  });

  it("setBotTabTitle and rebindBotTab change only their own field", () => {
    const { openBotTab, setBotTabTitle, rebindBotTab } =
      useBotTabsStore.getState();
    openBotTab({ botId: BOT_A, hostId: "host-1", title: "A" });
    setBotTabTitle(BOT_A, "Renamed");
    rebindBotTab(BOT_A, "host-9");

    expect(lookupBotTab(useBotTabsStore.getState().tabs, BOT_A)).toMatchObject({
      hostId: "host-9",
      title: "Renamed",
    });
  });

  it("rebinding or renaming a missing bot opens nothing", () => {
    const { setBotTabTitle, rebindBotTab } = useBotTabsStore.getState();
    setBotTabTitle(BOT_A, "Ghost");
    rebindBotTab(BOT_A, "host-9");
    expect(useBotTabsStore.getState().tabs).toEqual({});
  });

  it("lookupBotTab returns null for a missing id and for prototype keys", () => {
    useBotTabsStore
      .getState()
      .openBotTab({ botId: BOT_A, hostId: "host-1", title: "A" });
    const tabs = useBotTabsStore.getState().tabs;
    expect(lookupBotTab(tabs, BOT_B)).toBeNull();
    expect(lookupBotTab(tabs, "constructor")).toBeNull();
    expect(lookupBotTab(tabs, "__proto__")).toBeNull();
    expect(lookupBotTab(tabs, "toString")).toBeNull();
  });

  it("botTabRecords lists records oldest first", () => {
    useBotTabsStore.setState({
      tabs: {
        [BOT_A]: { ...record(BOT_A, "host-1", "A"), openedAt: 30 },
        [BOT_B]: { ...record(BOT_B, "host-1", "B"), openedAt: 10 },
      },
    });
    expect(
      botTabRecords(useBotTabsStore.getState().tabs).map((r) => r.botId),
    ).toEqual([BOT_B, BOT_A]);
  });
});

describe("bot tab source refs", () => {
  beforeEach(resetStores);
  afterEach(resetStores);

  it("tabSourceRefs includes an open bot ref and drops it once closed", () => {
    expect(tabSourceRefs()).not.toContainEqual({ kind: "bot", id: BOT_A });
    useBotTabsStore
      .getState()
      .openBotTab({ botId: BOT_A, hostId: "host-1", title: "A" });
    expect(tabSourceRefs()).toContainEqual({ kind: "bot", id: BOT_A });
    useBotTabsStore.getState().closeBotTab(BOT_A);
    expect(tabSourceRefs()).not.toContainEqual({ kind: "bot", id: BOT_A });
  });

  it("treats bot as a source-backed kind and the system kinds as not", () => {
    expect(isSourceBackedTabKind("bot")).toBe(true);
    expect(isSourceBackedTabKind("epic")).toBe(true);
    expect(isSourceBackedTabKind("settings")).toBe(false);
    expect(isSourceBackedTabKind("home")).toBe(false);
  });
});

describe("bot route parsing", () => {
  it("decodes the bot id from a /bot/:id path", () => {
    expect(readBotIdFromPath("/bot/abc%20d")).toBe("abc d");
    expect(readBotIdFromPath(`/bot/${BOT_A}`)).toBe(BOT_A);
    expect(readBotIdFromPath(`/bot/${BOT_A}/`)).toBe(BOT_A);
  });

  it("rejects other shapes and malformed escapes", () => {
    expect(readBotIdFromPath("/bot/a/b")).toBeNull();
    expect(readBotIdFromPath("/bot/")).toBeNull();
    expect(readBotIdFromPath("/epic/abc")).toBeNull();
    expect(readBotIdFromPath("/bot/%E0%A4%A")).toBeNull();
  });
});

describe("bot tab in the header strip", () => {
  beforeEach(resetStores);
  afterEach(resetStores);

  it("getHeaderTabs projects a bot header tab for an open bot ref in the strip", () => {
    useBotTabsStore
      .getState()
      .openBotTab({ botId: BOT_A, hostId: "host-1", title: "Release Bot" });
    useTabsStore.setState({ stripOrder: [{ kind: "bot", id: BOT_A }] });

    const tabs = getHeaderTabs();
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({
      kind: "bot",
      id: BOT_A,
      hostId: "host-1",
      name: "Release Bot",
      canDuplicate: false,
      canOpenInNewWindow: false,
    });
  });

  it("getHeaderTabs omits a bot ref whose record is gone", () => {
    useTabsStore.setState({ stripOrder: [{ kind: "bot", id: BOT_A }] });
    expect(getHeaderTabs()).toEqual([]);
  });

  it("reflects a title refresh and a rebind on the next projection", () => {
    const store = useBotTabsStore.getState();
    store.openBotTab({ botId: BOT_A, hostId: "host-1", title: "Old" });
    useTabsStore.setState({ stripOrder: [{ kind: "bot", id: BOT_A }] });
    store.setBotTabTitle(BOT_A, "New");
    store.rebindBotTab(BOT_A, "host-2");

    expect(getHeaderTabs()[0]).toMatchObject({
      name: "New",
      hostId: "host-2",
    });
  });
});
