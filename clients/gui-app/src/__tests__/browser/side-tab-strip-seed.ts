import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useAppLocalNotificationsStore } from "@/stores/notifications/app-local-notifications-store";
import { tabItemId, tabRefKey, type StripItem } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";
import type { TabCustomizations } from "@/stores/tabs/tab-groups";
import type { TabRef } from "@/stores/tabs/types";

/**
 * The tabs the real-Chrome side-strip fixtures open, written through the
 * product's own stores the way a restored window holds them: six task tabs,
 * one of them a split pair, three of them in one named group, three with a
 * tab colour, and one with an unread failure so a status badge sits on its
 * tile. The canvas fixture adds the layout session's own tab and makes it the
 * active one, which is what a session holds.
 *
 * Nothing here draws a row: every row, tile, badge and group line the drivers
 * measure is the real `SideTabStrip` reading these stores.
 */

/** `Alpha` and the `[Beta | Gamma]` pair share the group; the pair is the group's last item. */
const SEED_GROUP_ID = "fixture-group";
const SEED_GROUP_COLOR = "#8ab4f8";
/** The tab whose tile carries the failure badge. */
const SEED_BADGED_EPIC_ID = "fixture-delta";

const SAMPLE_WORKSPACE_REF: TabRef = {
  kind: "sample-workspace",
  id: "sample-workspace",
};

function epicRef(name: string): TabRef {
  const id = `fixture-${name.split(" ")[0]?.toLowerCase() ?? name}`;
  useEpicCanvasStore.getState().seedEpic(id, { tabId: id, name }, []);
  return { kind: "epic", id };
}

function loneItem(ref: TabRef): StripItem {
  return { kind: "tab", id: tabItemId(ref), ref };
}

/**
 * Seeds the tabs store and the epic records behind it. With `sessionTab`, the
 * Customizing tab is appended and active; otherwise `Epsilon cleanup` is.
 */
export function seedSideStripTabs(sessionTab: boolean): void {
  const alpha = epicRef("Alpha rollout");
  const beta = epicRef("Beta review");
  const gamma = epicRef("Gamma notes");
  const delta = epicRef("Delta migration");
  const epsilon = epicRef("Epsilon cleanup");
  const zeta = epicRef("Zeta spike");
  const refs = [alpha, beta, gamma, delta, epsilon, zeta];
  const items: StripItem[] = [
    loneItem(alpha),
    {
      kind: "split",
      id: "fixture-split",
      left: { kind: "tab", ref: beta },
      right: { kind: "tab", ref: gamma },
      focusedSide: "left",
      routeBackingSide: "left",
      leftRatio: 0.5,
    },
    loneItem(delta),
    loneItem(epsilon),
    loneItem(zeta),
  ];
  if (sessionTab) items.push(loneItem(SAMPLE_WORKSPACE_REF));
  const customizations: TabCustomizations = {
    [tabRefKey(alpha)]: {
      color: "#81c995",
      icon: null,
      groupId: SEED_GROUP_ID,
    },
    [tabRefKey(beta)]: { color: null, icon: null, groupId: SEED_GROUP_ID },
    [tabRefKey(gamma)]: {
      color: "#c58af9",
      icon: null,
      groupId: SEED_GROUP_ID,
    },
    [tabRefKey(delta)]: { color: "#fcad70", icon: null, groupId: null },
  };
  useTabsStore.setState({
    version: 2,
    items,
    activeItemId: tabItemId(sessionTab ? SAMPLE_WORKSPACE_REF : epsilon),
    stripOrder: sessionTab ? [...refs, SAMPLE_WORKSPACE_REF] : refs,
    systemTabs: { history: null, settings: null },
    groups: {
      [SEED_GROUP_ID]: {
        name: "Work",
        color: SEED_GROUP_COLOR,
        collapsed: false,
      },
    },
    customizations,
  });
  seedFailureBadge();
}

/**
 * An unread renderer-local failure on `Delta migration`, which the strip's
 * indicator selector folds into that tab's `unreadFailure` and the row kit
 * turns into the failed badge on its tile (S-17, S-35).
 */
function seedFailureBadge(): void {
  const notifications = useAppLocalNotificationsStore.getState();
  notifications.activateIdentity("fixture-user");
  notifications.upsert({
    id: "fixture-delta-failure",
    originHostId: null,
    updatedAt: 1,
    readAt: null,
    kind: "host.error",
    sourceRef: null,
    payload: { kind: "epic", epicId: SEED_BADGED_EPIC_ID },
    message: "The agent stopped with an error",
    detail: null,
  });
}
