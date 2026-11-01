import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { persistKey, STORE_KEYS } from "@/lib/persist";
import type {
  DesktopJsonValue,
  DesktopPerWindowSnapshot,
} from "@/lib/windows/types";
import { useBotOpenThreadStore } from "@/stores/bots/bot-open-thread-store";
import { isTracyEntryRef } from "@/stores/bots/tracy-entry";
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { hydrateDesktopTabs } from "@/stores/tabs/desktop-tabs-persistence";
import { emptyTabStripLayout } from "@/stores/tabs/layout";
import { TRACY_TAB_REF } from "@/stores/tabs/kinds/tracy";
import { readTabStripLayout, useTabsStore } from "@/stores/tabs/store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import { isTabCloseLocked } from "@/stores/tabs/tab-structural-lock";

/**
 * The Tracy surface's migration from the per-bot tab model, driven through the
 * stores' real rehydration of the payloads an older build persisted: the bot
 * tabs store (version 1, one record per bot) and the tabs layout (one `bot`
 * ref per bot tab).
 */

const SURFACE_KEY = persistKey(STORE_KEYS.botTabs);

function tabsKey(): string {
  const name = useTabsStore.persist.getOptions().name;
  if (name === undefined) throw new Error("tabs persistence key missing");
  return name;
}

interface LegacyBotRecord {
  readonly botId: string;
  readonly hostId: string;
  readonly openedAt: number;
}

function legacyBotTabsPayload(
  records: ReadonlyArray<LegacyBotRecord>,
  fixedBotId: string | null,
): string {
  return JSON.stringify({
    state: {
      tabs: Object.fromEntries(
        records.map((record) => [
          record.botId,
          { ...record, title: `Bot ${record.botId}` },
        ]),
      ),
      fixedBotId,
    },
    version: 1,
  });
}

function botTab(botId: string): DesktopJsonValue {
  return {
    kind: "tab",
    id: `tab:bot:${botId}`,
    ref: { kind: "bot", id: botId },
  };
}

function epicTab(tabId: string): DesktopJsonValue {
  return {
    kind: "tab",
    id: `tab:epic:${tabId}`,
    ref: { kind: "epic", id: tabId },
  };
}

interface LegacyRef {
  readonly kind: "bot" | "epic";
  readonly id: string;
}

function split(
  id: string,
  left: LegacyRef,
  right: LegacyRef,
  focusedSide: "left" | "right",
): DesktopJsonValue {
  return {
    kind: "split",
    id,
    left: { kind: "tab", ref: { kind: left.kind, id: left.id } },
    right: { kind: "tab", ref: { kind: right.kind, id: right.id } },
    focusedSide,
    routeBackingSide: focusedSide,
    leftRatio: 0.5,
  };
}

const CUSTOMIZATION_BLUE = { color: "#8ab4f8", icon: null, groupId: null };
const CUSTOMIZATION_RED = { color: "#f28b82", icon: null, groupId: null };
const SYSTEM_TABS = { history: null, settings: null };

async function rehydrate(
  botTabsPayload: string,
  tabsLayout: DesktopJsonValue,
): Promise<void> {
  window.localStorage.setItem(SURFACE_KEY, botTabsPayload);
  window.localStorage.setItem(
    tabsKey(),
    JSON.stringify({ state: tabsLayout, version: 2 }),
  );
  // The surface store hydrates first at boot: the tabs layout's migration
  // reads what the surface's own migration found.
  await useTracySurfaceStore.persist.rehydrate();
  await useTabsStore.persist.rehydrate();
}

function resetStores(): void {
  window.localStorage.clear();
  useTracySurfaceStore.setState({
    open: false,
    hostId: null,
    botId: null,
    visitedBotIds: [],
  });
  useBotOpenThreadStore.setState(useBotOpenThreadStore.getInitialState(), true);
  useTabsStore.setState({ ...emptyTabStripLayout(), stripOrder: [] });
  useSettingsStore.setState({ showTracy: true });
  tabCommandCoordinator.resetReconciliationForTesting();
}

describe("Tracy surface migration from per-bot tabs", () => {
  beforeEach(resetStores);
  afterEach(resetStores);

  it("turns the active ordinary bot tab into the one active surface tab on that bot's host and channel", async () => {
    await rehydrate(
      legacyBotTabsPayload(
        [
          { botId: "bot-a", hostId: "host-a", openedAt: 1 },
          { botId: "bot-b", hostId: "host-b", openedAt: 2 },
        ],
        null,
      ),
      {
        version: 2,
        items: [epicTab("tab-1"), botTab("bot-a"), botTab("bot-b")],
        activeItemId: "tab:bot:bot-b",
        systemTabs: SYSTEM_TABS,
        activationHistory: [
          { kind: "bot", id: "bot-b" },
          { kind: "epic", id: "tab-1" },
          { kind: "bot", id: "bot-a" },
        ],
      },
    );

    const layout = readTabStripLayout();
    expect({
      refs: layout.items.map((item) => (item.kind === "tab" ? item.ref : null)),
      activeIsTracy: layout.activeItemId === layout.items[1].id,
      history: layout.activationHistory,
    }).toEqual({
      refs: [{ kind: "epic", id: "tab-1" }, TRACY_TAB_REF],
      activeIsTracy: true,
      history: [TRACY_TAB_REF, { kind: "epic", id: "tab-1" }],
    });
    const surface = useTracySurfaceStore.getState();
    expect({
      open: surface.open,
      hostId: surface.hostId,
      botId: surface.botId,
    }).toEqual({ open: true, hostId: "host-b", botId: "bot-b" });
  });

  it("keeps one surface ref across two bots in a split and the active bot tab elsewhere, with the active bot's customization", async () => {
    await rehydrate(
      legacyBotTabsPayload(
        [
          { botId: "bot-a", hostId: "host-a", openedAt: 1 },
          { botId: "bot-b", hostId: "host-a", openedAt: 2 },
          { botId: "bot-c", hostId: "host-a", openedAt: 3 },
        ],
        null,
      ),
      {
        version: 2,
        items: [
          split(
            "split-bots",
            { kind: "bot", id: "bot-a" },
            { kind: "bot", id: "bot-b" },
            "left",
          ),
          split(
            "split-mixed",
            { kind: "epic", id: "tab-1" },
            { kind: "bot", id: "bot-c" },
            "right",
          ),
        ],
        activeItemId: "split-mixed",
        systemTabs: SYSTEM_TABS,
        activationHistory: [
          { kind: "bot", id: "bot-c" },
          { kind: "epic", id: "tab-1" },
          { kind: "bot", id: "bot-a" },
          { kind: "bot", id: "bot-b" },
        ],
        customizations: {
          "bot:bot-a": CUSTOMIZATION_BLUE,
          "bot:bot-c": CUSTOMIZATION_RED,
        },
      },
    );

    const layout = readTabStripLayout();
    // The active item (the mixed split) keeps the surface; the split of two
    // bots held only the surface's duplicates, so it is gone.
    expect({
      items: layout.items,
      activeItemId: layout.activeItemId,
      history: layout.activationHistory,
      customizations: layout.customizations,
      botId: useTracySurfaceStore.getState().botId,
    }).toEqual({
      items: [
        {
          kind: "split",
          id: "split-mixed",
          left: { kind: "tab", ref: { kind: "epic", id: "tab-1" } },
          right: { kind: "tab", ref: TRACY_TAB_REF },
          focusedSide: "right",
          routeBackingSide: "right",
          leftRatio: 0.5,
        },
      ],
      activeItemId: "split-mixed",
      history: [TRACY_TAB_REF, { kind: "epic", id: "tab-1" }],
      customizations: { "tracy:tracy": CUSTOMIZATION_RED },
      botId: "bot-c",
    });
  });

  it("keeps a split's other side when only one of its sides was a bot, and the split of two bots becomes the surface's tab", async () => {
    await rehydrate(
      legacyBotTabsPayload(
        [
          { botId: "bot-a", hostId: "host-a", openedAt: 1 },
          { botId: "bot-b", hostId: "host-a", openedAt: 2 },
          { botId: "bot-c", hostId: "host-a", openedAt: 3 },
        ],
        null,
      ),
      {
        version: 2,
        items: [
          split(
            "split-ae",
            { kind: "bot", id: "bot-a" },
            { kind: "epic", id: "tab-1" },
            "right",
          ),
          split(
            "split-bc",
            { kind: "bot", id: "bot-b" },
            { kind: "bot", id: "bot-c" },
            "left",
          ),
        ],
        activeItemId: "split-bc",
        systemTabs: SYSTEM_TABS,
      },
    );

    const layout = readTabStripLayout();
    expect(
      layout.items.map((item) =>
        item.kind === "tab"
          ? { id: item.id, refs: [item.ref] }
          : {
              id: item.id,
              refs: [item.left, item.right].flatMap((side) =>
                side.kind === "tab" ? [side.ref] : [],
              ),
            },
      ),
    ).toEqual([
      { id: "split-ae", refs: [{ kind: "epic", id: "tab-1" }] },
      { id: "tab:tracy:tracy", refs: [TRACY_TAB_REF] },
    ]);
    expect(layout.activeItemId).toBe("tab:tracy:tracy");
  });

  it("opens the surface as an ordinary, closable tab when Show Tracy is off", async () => {
    useSettingsStore.setState({ showTracy: false });
    await rehydrate(
      legacyBotTabsPayload(
        [
          { botId: "bot-a", hostId: "host-a", openedAt: 1 },
          { botId: "bot-b", hostId: "host-a", openedAt: 2 },
        ],
        null,
      ),
      {
        version: 2,
        items: [botTab("bot-a"), epicTab("tab-1"), botTab("bot-b")],
        activeItemId: "tab:epic:tab-1",
        systemTabs: SYSTEM_TABS,
      },
    );

    const layout = readTabStripLayout();
    expect(
      layout.items.map((item) => (item.kind === "tab" ? item.ref : null)),
    ).toEqual([TRACY_TAB_REF, { kind: "epic", id: "tab-1" }]);
    expect(useTracySurfaceStore.getState().open).toBe(true);
    expect(isTracyEntryRef(TRACY_TAB_REF)).toBe(false);
    expect(isTabCloseLocked(TRACY_TAB_REF)).toBe(false);

    // The same surface is the pinned, close-locked entry once the setting is on.
    useSettingsStore.setState({ showTracy: true });
    expect(isTabCloseLocked(TRACY_TAB_REF)).toBe(true);
  });

  it("collapses the local layout and the desktop snapshot into the one ref, with no duplicate", async () => {
    await rehydrate(
      legacyBotTabsPayload(
        [
          { botId: "bot-a", hostId: "host-a", openedAt: 1 },
          { botId: "bot-b", hostId: "host-a", openedAt: 2 },
        ],
        null,
      ),
      {
        version: 2,
        items: [botTab("bot-a"), botTab("bot-b")],
        activeItemId: "tab:bot:bot-a",
        systemTabs: SYSTEM_TABS,
      },
    );
    expect(
      readTabStripLayout().items.map((item) =>
        item.kind === "tab" ? item.ref : null,
      ),
    ).toEqual([TRACY_TAB_REF]);

    const snapshot: DesktopPerWindowSnapshot = {
      epicTabs: [],
      activeTabId: null,
      canvasByTabId: {},
      landingDrafts: [],
      activeLandingDraftId: null,
      revision: 3,
      tabStripLayout: {
        version: 2,
        items: [botTab("bot-b"), botTab("bot-a")],
        activeItemId: "tab:bot:bot-b",
        systemTabs: SYSTEM_TABS,
        customizations: { "bot:bot-a": CUSTOMIZATION_BLUE },
      },
      activeRoute: "/bot/bot-b",
    };
    const hydration = hydrateDesktopTabs(snapshot, true, null);

    const layout = readTabStripLayout();
    expect({
      refs: layout.items.map((item) => (item.kind === "tab" ? item.ref : null)),
      activeIsTracy: layout.activeItemId === layout.items[0].id,
      customizations: layout.customizations,
      route: hydration.route,
      botId: useTracySurfaceStore.getState().botId,
    }).toEqual({
      refs: [TRACY_TAB_REF],
      activeIsTracy: true,
      customizations: { "tracy:tracy": CUSTOMIZATION_BLUE },
      route: "/bot/bot-b",
      botId: "bot-b",
    });
  });
});
