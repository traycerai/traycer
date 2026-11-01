/**
 * The tracy tab kind (Tracy is one surface): the singleton kind module's
 * projection, the surface store behind it, and the seams that join them to
 * the strip - `tabSourceRefs`, the route helpers and
 * the real `getHeaderTabs()` projection against the actual stores.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readBotIdFromPath, tracyPathname, tracyRoute } from "@/lib/routes";
import { botTabIntent } from "@/lib/tab-navigation/intents";
import { useBotOpenThreadStore } from "@/stores/bots/bot-open-thread-store";
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";
import {
  isTracySurfaceOpen,
  TRACY_TAB_LABEL,
  TRACY_TAB_REF,
  tracyTabModule,
} from "@/stores/tabs/kinds/tracy";
import {
  TAB_KINDS,
  tabEpicId,
  tabMatchesPath,
  tabRequestClose,
  tabResolveIntent,
  tabRouteOptions,
} from "@/stores/tabs/registry";
import { tabSourceRefs } from "@/stores/tabs/source-refs";
import { useTabsStore } from "@/stores/tabs/store";
import type { TabRef } from "@/stores/tabs/types";
import { getHeaderTabs } from "@/stores/tabs/use-header-tabs";

const BOT_A = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const BOT_B = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAW";

function resetStores(): void {
  useTracySurfaceStore.setState({
    open: false,
    hostId: null,
    botId: null,
    visitedBotIds: [],
  });
  useBotOpenThreadStore.setState({ byBotId: {} });
  useTabsStore.setState(useTabsStore.getInitialState(), true);
}

describe("tracy tab kind - build and descriptor", () => {
  it("projects the surface source into a non-duplicable, single-window tab named Tracy", () => {
    const tab = TAB_KINDS.tracy.build({ hostId: "host-1", botId: BOT_A });
    expect(tab).toMatchObject({
      kind: "tracy",
      id: "tracy",
      hostId: "host-1",
      botId: BOT_A,
      route: `/bot/${encodeURIComponent(BOT_A)}`,
      name: TRACY_TAB_LABEL,
      canDuplicate: false,
      canOpenInNewWindow: false,
    });
    expect(TAB_KINDS.tracy).toBe(tracyTabModule);
  });

  it("matches /bot and one-segment channel paths, not deeper paths or look-alikes", () => {
    const tab = TAB_KINDS.tracy.build({ hostId: "host-1", botId: BOT_A });
    expect(tabMatchesPath(tab, "/bot")).toBe(true);
    expect(tabMatchesPath(tab, tracyPathname(BOT_A))).toBe(true);
    expect(tabMatchesPath(tab, tracyPathname(BOT_B))).toBe(true);
    expect(tabMatchesPath(tab, "/bot/")).toBe(true);
    expect(tabMatchesPath(tab, `${tracyPathname(BOT_A)}/extra`)).toBe(false);
    expect(tabMatchesPath(tab, "/botany")).toBe(false);
    expect(tabMatchesPath(tab, "/bots")).toBe(false);
    expect(tabMatchesPath(tab, "/")).toBe(false);
  });

  it("owns no epic, resolves to a tracy intent with or without a channel, and routes to /bot or /bot/$botId", () => {
    const withChannel = TAB_KINDS.tracy.build({
      hostId: "host-1",
      botId: BOT_A,
    });
    expect(tabEpicId(withChannel)).toBeNull();
    expect(tabResolveIntent(withChannel)).toEqual(botTabIntent(BOT_A));
    expect(tabRouteOptions(botTabIntent(BOT_A))).toEqual(tracyRoute(BOT_A));
    expect(tracyRoute(BOT_A)).toEqual({
      to: "/bot/$botId",
      params: { botId: BOT_A },
    });

    const noChannel = TAB_KINDS.tracy.build({ hostId: "host-1", botId: null });
    expect(noChannel.route).toBe("/bot");
    expect(tabResolveIntent(noChannel)).toEqual({
      kind: "tracy",
      botId: null,
    });
    expect(tabRouteOptions({ kind: "tracy", botId: null })).toEqual({
      to: "/bot",
    });
  });

  it("closes through its one ref", () => {
    const tab = TAB_KINDS.tracy.build({ hostId: "host-1", botId: BOT_A });
    const closed: TabRef[] = [];
    tabRequestClose(tab, (ref) => {
      closed.push(ref);
    });
    expect(closed).toEqual([TRACY_TAB_REF]);
  });
});

describe("tracy surface path matching", () => {
  it("decodes the bot id from a /bot/:id path", () => {
    expect(readBotIdFromPath("/bot/abc%20d")).toBe("abc d");
    expect(readBotIdFromPath(`/bot/${BOT_A}`)).toBe(BOT_A);
    expect(readBotIdFromPath(`/bot/${BOT_A}/`)).toBe(BOT_A);
  });

  it("rejects other shapes and malformed escapes", () => {
    expect(readBotIdFromPath("/bot/a/b")).toBeNull();
    expect(readBotIdFromPath("/bot")).toBeNull();
    expect(readBotIdFromPath("/epic/abc")).toBeNull();
    expect(readBotIdFromPath("/bot/%E0%A4%A")).toBeNull();
  });
});

describe("tracy surface source refs", () => {
  beforeEach(resetStores);
  afterEach(resetStores);

  it("tabSourceRefs includes the tracy ref while the surface is open and drops it once closed", () => {
    expect(tabSourceRefs()).not.toContainEqual(TRACY_TAB_REF);
    expect(isTracySurfaceOpen()).toBe(false);

    useTracySurfaceStore.getState().openSurface("host-1");
    expect(tabSourceRefs()).toContainEqual(TRACY_TAB_REF);
    expect(isTracySurfaceOpen()).toBe(true);

    useTracySurfaceStore.getState().closeSurface();
    expect(tabSourceRefs()).not.toContainEqual(TRACY_TAB_REF);
    expect(isTracySurfaceOpen()).toBe(false);
  });

  it("keeps one ref across channel switches: the surface is never opened twice", () => {
    const store = useTracySurfaceStore.getState();
    store.openSurface("host-1");
    store.selectChannel(BOT_A);
    store.openSurface("host-2");
    store.selectChannel(BOT_B);

    expect(tabSourceRefs().filter((ref) => ref.kind === "tracy")).toEqual([
      TRACY_TAB_REF,
    ]);
    expect(useTracySurfaceStore.getState().hostId).toBe("host-1");
  });
});

describe("tracy tab in the header strip", () => {
  beforeEach(resetStores);
  afterEach(resetStores);

  it("getHeaderTabs projects the surface for the tracy ref in the strip", () => {
    const store = useTracySurfaceStore.getState();
    store.openSurface("host-1");
    store.selectChannel(BOT_A);
    useTabsStore.setState({ stripOrder: [TRACY_TAB_REF] });

    const tabs = getHeaderTabs();
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({
      kind: "tracy",
      id: "tracy",
      hostId: "host-1",
      botId: BOT_A,
      name: TRACY_TAB_LABEL,
      canDuplicate: false,
      canOpenInNewWindow: false,
    });
  });

  it("getHeaderTabs omits the tracy ref while the surface is closed", () => {
    useTabsStore.setState({ stripOrder: [TRACY_TAB_REF] });
    expect(getHeaderTabs()).toEqual([]);
  });

  it("follows the selected channel and a rebind on the next projection, under the same name", () => {
    const store = useTracySurfaceStore.getState();
    store.openSurface("host-1");
    store.selectChannel(BOT_A);
    useTabsStore.setState({ stripOrder: [TRACY_TAB_REF] });
    expect(getHeaderTabs()[0]).toMatchObject({
      route: tracyPathname(BOT_A),
    });

    store.selectChannel(BOT_B);
    store.rebind("host-2");
    expect(getHeaderTabs()[0]).toMatchObject({
      name: TRACY_TAB_LABEL,
      hostId: "host-2",
      botId: BOT_B,
      route: tracyPathname(BOT_B),
    });

    store.selectChannel(null);
    expect(getHeaderTabs()[0]).toMatchObject({ route: "/bot" });
  });
});
