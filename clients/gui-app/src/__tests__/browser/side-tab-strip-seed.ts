import type { HostNotificationsCloudFeedRowV11 } from "@traycer/protocol/host/notifications/contracts";
import { __setAgentActivityStateForTests } from "@/stores/agent-activity-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useAppLocalNotificationsStore } from "@/stores/notifications/app-local-notifications-store";
import { useCloudNotificationsStore } from "@/stores/notifications/cloud-notifications-store";
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

// ── The Activity view's sections ────────────────────────────────────────────

const MINUTE_MS = 60_000;

/**
 * A row of the cloud feed, which the strip reads both for its prompts and for
 * each task's indicator once the fixture runs in the `cloud` feed mode: a task
 * waiting on an approval or a reply, or finished or failed and unread.
 */
function feedRow(input: {
  readonly epicId: string;
  readonly minutesAgo: number;
  readonly kind:
    | { readonly prompt: "approval" | "interview"; readonly agentTitle: string }
    | { readonly stopped: "done" | "failed" };
}): HostNotificationsCloudFeedRowV11 {
  const { epicId, kind } = input;
  const entryId = `${epicId}-row`;
  const chatId = `${epicId}-chat`;
  const at = Date.now() - input.minutesAgo * MINUTE_MS;
  const base = {
    id: entryId,
    updatedAt: at,
    readAt: null,
    sourceRef: entryId,
    epicId,
    chatId,
  };
  if ("stopped" in kind) {
    const failed = kind.stopped === "failed";
    return {
      entryId,
      originHostId: "host-a",
      coalesceKey: `agent.stopped:${chatId}`,
      entry: {
        ...base,
        kind: "agent.stopped",
        severity: failed ? "failure" : "done",
        outcome: failed ? "errored" : "completed",
        payload: {
          kind: "chat",
          epicId,
          chatId,
          agentName: "Agent",
          taskTitle: epicId,
          outcome: failed ? "errored" : "completed",
        },
      },
      presentation: { epicTitle: epicId, chatTitle: null },
    };
  }
  const approval = kind.prompt === "approval";
  return {
    entryId,
    originHostId: "host-a",
    coalesceKey: `${approval ? "approval" : "interview"}.requested:${chatId}`,
    entry: {
      ...base,
      kind: approval ? "approval.requested" : "interview.requested",
      severity: "needs_action",
      outcome: null,
      resolvedAt: null,
      payload: approval
        ? {
            kind: "approval",
            epicId,
            chatId,
            chatTitle: kind.agentTitle,
            taskTitle: epicId,
            approvalId: entryId,
          }
        : {
            kind: "interview",
            epicId,
            chatId,
            chatTitle: kind.agentTitle,
            taskTitle: epicId,
            interviewBlockId: "block-1",
          },
    },
    presentation: { epicTitle: epicId, chatTitle: kind.agentTitle },
  };
}

/**
 * The Activity view with every section: two tasks waiting on the person (an
 * approval and a reply), one finished and one failed and unread, three working
 * (the current one, one with two agents, one with one) and three idle (one with
 * an icon and a colour, one in a tab group). Written through the product's own
 * stores, as `seedSideStripTabs` is: the strip draws all of it, reading the
 * cloud feed, so the fixture mounts it in the `cloud` feed mode.
 */
export function seedSideStripSections(): void {
  const staging = epicRef("Staging CDP verification");
  const onboarding = epicRef("Onboarding copy");
  const release = epicRef("Release checklist");
  const migration = epicRef("Migration dry run");
  const gui = epicRef("GUI sidebar redesign");
  const cookie = epicRef("Cookie sync perf");
  const hostWatcher = epicRef("Host watcher fix");
  const layout = epicRef("Layout persist schema");
  const launch = epicRef("Launch notes");
  const react = epicRef("React UI performance");
  const refs = [
    staging,
    onboarding,
    release,
    migration,
    gui,
    cookie,
    hostWatcher,
    layout,
    launch,
    react,
  ];
  const customizations: TabCustomizations = {
    [tabRefKey(gui)]: { color: "#f07a6a", icon: null, groupId: null },
    [tabRefKey(hostWatcher)]: {
      color: null,
      icon: null,
      groupId: SEED_GROUP_ID,
    },
    [tabRefKey(layout)]: { color: null, icon: null, groupId: SEED_GROUP_ID },
    [tabRefKey(launch)]: { color: "#3fb8a8", icon: "🚀", groupId: null },
  };
  useTabsStore.setState({
    version: 2,
    items: refs.map(loneItem),
    activeItemId: tabItemId(gui),
    stripOrder: refs,
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
  __setAgentActivityStateForTests(
    {
      "fixture-gui": { working: ["gui-a"], turn: ["gui-a"] },
      "fixture-cookie": {
        working: ["cookie-a", "cookie-b"],
        turn: ["cookie-a", "cookie-b"],
      },
      "fixture-host": { working: ["host-a"], turn: ["host-a"] },
    },
    "local",
    "connected",
  );
  useCloudNotificationsStore.getState().applySnapshot({
    rows: [
      feedRow({
        epicId: "fixture-staging",
        minutesAgo: 2,
        kind: { prompt: "approval", agentTitle: "CDP pass" },
      }),
      feedRow({
        epicId: "fixture-onboarding",
        minutesAgo: 14,
        kind: { prompt: "interview", agentTitle: "Copy agent" },
      }),
      feedRow({
        epicId: "fixture-release",
        minutesAgo: 6,
        kind: { stopped: "done" },
      }),
      feedRow({
        epicId: "fixture-migration",
        minutesAgo: 31,
        kind: { stopped: "failed" },
      }),
    ],
    summary: { totalCount: 4, unreadCount: 4, attentionCount: 2 },
    version: 1,
  });
}
