import type { HostNotificationsCloudFeedRowV11 } from "@traycer/protocol/host/notifications/contracts";
import {
  getOpenEpicRegistry,
  handleHostIds,
} from "@/lib/registries/epic-session-registry";
import type { EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import { openStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import type { ChatProjection } from "@/stores/epics/open-epic/types";
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
 * Nothing here draws a row: every row, tile, badge and group block the drivers
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
 * (the current one, one with two agents, one with one) and three idle. The
 * "Work" group holds Host watcher fix (working) and Layout persist schema and
 * Launch notes (idle), so it is split across Working and Idle; Launch has an
 * icon and a colour of its own, and the group's colour is the one it draws.
 * Written through the product's own stores, as `seedSideStripTabs` is: the
 * strip draws all of it, reading the cloud feed, so the fixture mounts it in
 * the `cloud` feed mode.
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
    [tabRefKey(launch)]: {
      color: "#3fb8a8",
      icon: "🚀",
      groupId: SEED_GROUP_ID,
    },
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
        kind: { prompt: "approval", agentTitle: "CDP verification pass" },
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

/**
 * The owner's grouping report: the Activity view with only Idle, holding
 * Cookie sync perf, a group of one (GUI sidebar redesign, the current task),
 * React UI performance and Start page, in that order. No task is working or
 * waiting, so every one is idle. Signed in, the group is the account
 * organization's and so is every task, stamped the way the organization view's
 * projection stamps them.
 */
export function seedSideStripIdleGroup(): void {
  const refs = [
    epicRef("Cookie sync perf"),
    epicRef("GUI sidebar redesign"),
    epicRef("React UI performance"),
    epicRef("Start page"),
  ];
  const gui = refs[1];
  const owner = "fixture-user";
  useTabsStore.setState({
    version: 2,
    items: refs.map(loneItem),
    activeItemId: tabItemId(gui),
    stripOrder: refs,
    systemTabs: { history: null, settings: null },
    groups: {
      [SEED_GROUP_ID]: {
        name: "group",
        color: "#ff8bcb",
        collapsed: false,
        organizationOwnerId: owner,
      },
    },
    customizations: Object.fromEntries(
      refs.map((ref) => [
        tabRefKey(ref),
        {
          color: null,
          icon: null,
          groupId: ref === gui ? SEED_GROUP_ID : null,
          organizationOwnerId: owner,
        },
      ]),
    ),
  });
  __setAgentActivityStateForTests({}, "local", "connected");
  useCloudNotificationsStore.getState().applySnapshot({
    rows: [],
    summary: { totalCount: 0, unreadCount: 0, attentionCount: 0 },
    version: 1,
  });
}

/** A split pair of two tabs, `focused` its focused half. */
function splitItem(
  id: string,
  left: TabRef,
  right: TabRef,
  focused: "left" | "right",
): StripItem {
  return {
    kind: "split",
    id,
    left: { kind: "tab", ref: left },
    right: { kind: "tab", ref: right },
    focusedSide: focused,
    routeBackingSide: focused,
    leftRatio: 0.5,
  };
}

/**
 * The split pairs' boards: GUI Sidebar Redesign, the current pair (Cookie Sync
 * Performance and React UI Performance Audit, its left half focused), a second
 * pair (Release checklist and Host watcher fix) and Start Page, all idle. The
 * History tab is open as a non-task tab a pair can take.
 */
export function seedSideStripPairs(): void {
  const gui = epicRef("GUI Sidebar Redesign");
  const cookie = epicRef("Cookie Sync Performance");
  const react = epicRef("React UI Performance Audit");
  const release = epicRef("Release checklist");
  const host = epicRef("Host watcher fix");
  const start = epicRef("Start Page");
  const refs = [gui, cookie, react, release, host, start];
  useTabsStore.setState({
    version: 2,
    items: [
      loneItem(gui),
      splitItem("split-current", cookie, react, "left"),
      splitItem("split-other", release, host, "left"),
      loneItem(start),
    ],
    activeItemId: "split-current",
    stripOrder: refs,
    systemTabs: {
      history: {
        id: "history",
        kind: "history",
        name: "All tasks",
        lastPath: null,
      },
      settings: null,
    },
    groups: {},
    customizations: {},
  });
  __setAgentActivityStateForTests({}, "local", "connected");
  useCloudNotificationsStore.getState().applySnapshot({
    rows: [],
    summary: { totalCount: 0, unreadCount: 0, attentionCount: 0 },
    version: 1,
  });
}

/**
 * The pairs' live statuses: Cookie Sync Performance working, React UI
 * Performance Audit waiting on an approval from its Perf agent.
 */
export function seedSideStripPairStatuses(): void {
  __setAgentActivityStateForTests(
    { "fixture-cookie": { working: ["c-bench"], turn: ["c-bench"] } },
    "local",
    "connected",
  );
  useCloudNotificationsStore.getState().applySnapshot({
    rows: [
      feedRow({
        epicId: "fixture-react",
        minutesAgo: 3,
        kind: { prompt: "approval", agentTitle: "Perf agent" },
      }),
    ],
    summary: { totalCount: 1, unreadCount: 1, attentionCount: 1 },
    version: 2,
  });
}

/** The second pair's outcomes: Release checklist done, Host watcher fix failed, both unread. */
export function seedSideStripPairOutcomes(): void {
  useCloudNotificationsStore.getState().applySnapshot({
    rows: [
      feedRow({
        epicId: "fixture-release",
        minutesAgo: 4,
        kind: { stopped: "done" },
      }),
      feedRow({
        epicId: "fixture-host",
        minutesAgo: 8,
        kind: { stopped: "failed" },
      }),
    ],
    summary: { totalCount: 2, unreadCount: 2, attentionCount: 0 },
    version: 4,
  });
}

const noopStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

/** A session for `epicId` holding `chats` (id, title), so the strip names its agents. */
function warmEpic(
  epicId: string,
  chats: ReadonlyArray<readonly [string, string]>,
) {
  const handle = openStoreForTest({
    epicId,
    userId: null,
    factories: {
      streamClientFactory: noopStreamClientFactory,
      laneSelection: null,
    },
    writeCommand: null,
  });
  const byId: Record<string, ChatProjection> = {};
  const startedAt = Date.now() - 4 * MINUTE_MS;
  for (const [id, title] of chats) {
    byId[id] = {
      id,
      title,
      parentId: null,
      createdAt: startedAt,
      updatedAt: startedAt,
      userId: null,
      hostId: "host-a",
      isTitleEditedByUser: false,
      docResident: false,
      archivedAt: null,
      settings: null,
    };
  }
  handle.store.setState({ chats: { allIds: Object.keys(byId), byId } });
  // The serving host, as the session provider stamps it: the strip asks it,
  // and the cloud feed, what each chat waits on.
  handleHostIds.set(handle, "host-a");
  getOpenEpicRegistry().acquire(epicId, () => handle);
}

/**
 * Named agents under the current pair: Cookie Sync's Sync agent and Bench
 * runner, and React UI's Perf agent, all working, so both halves are Working.
 */
export function seedSideStripPairAgents(): void {
  warmEpic("fixture-cookie", [
    ["c-sync", "Sync agent"],
    ["c-bench", "Bench runner"],
  ]);
  warmEpic("fixture-react", [["r-perf", "Perf agent"]]);
  __setAgentActivityStateForTests(
    {
      "fixture-cookie": {
        working: ["c-sync", "c-bench"],
        turn: ["c-sync", "c-bench"],
      },
      "fixture-react": { working: ["r-perf"], turn: ["r-perf"] },
    },
    "local",
    "connected",
  );
}

/**
 * Names the agent behind each waiting prompt, so its task can expand to it:
 * the sections' CDP verification pass (an approval) and Copy agent (a reply),
 * or on the pairs' boards React UI Performance Audit's Perf agent, waiting on
 * an approval while Cookie Sync Performance works.
 */
export function seedSideStripWaitingAgents(pairs: boolean): void {
  if (pairs) {
    seedSideStripPairStatuses();
    warmEpic("fixture-react", [["fixture-react-chat", "Perf agent"]]);
    return;
  }
  warmEpic("fixture-staging", [
    ["fixture-staging-chat", "CDP verification pass"],
  ]);
  warmEpic("fixture-onboarding", [["fixture-onboarding-chat", "Copy agent"]]);
}

// ── Movement and long lists ─────────────────────────────────────────────────

/** Where a task of the long list sits: which Activity-view section the stores put it in. */
export type SeededSection = "needs-you" | "to-review" | "working" | "idle";

const LONG_LIST_TASKS: ReadonlyArray<readonly [string, SeededSection]> = [
  ["Staging CDP verification", "needs-you"],
  ["Onboarding copy", "needs-you"],
  ["Release checklist", "to-review"],
  ["Migration dry run", "to-review"],
  ["Sidebar redesign", "working"],
  ["Cookie sync perf", "working"],
  ["Watcher fix", "working"],
  ["Layout persist schema", "working"],
  ["Telemetry rollup", "working"],
  ["Keyboard shortcuts", "working"],
  ["Launch notes", "idle"],
  ["React UI performance", "idle"],
  ["Billing export", "idle"],
  ["Search indexing", "idle"],
  ["Inspector polish", "idle"],
  ["Terminal resize", "idle"],
  ["Worktree cleanup", "idle"],
  ["Checkout flow", "idle"],
  ["Docs refresh", "idle"],
  ["Dependency audit", "idle"],
];

const longListSections = new Map<string, SeededSection>();
let longListVersion = 0;

/** Writes the stores so every task of the long list is in the section it is assigned. */
function writeLongList(): void {
  const working: Record<string, { working: string[]; turn: string[] }> = {};
  const rows: HostNotificationsCloudFeedRowV11[] = [];
  let minutesAgo = 0;
  for (const [epicId, section] of longListSections) {
    minutesAgo += 3;
    if (section === "working") {
      working[epicId] = { working: [`${epicId}-a`], turn: [`${epicId}-a`] };
    } else if (section === "needs-you") {
      rows.push(
        feedRow({
          epicId,
          minutesAgo,
          kind: { prompt: "approval", agentTitle: "CDP pass" },
        }),
      );
    } else if (section === "to-review") {
      rows.push(feedRow({ epicId, minutesAgo, kind: { stopped: "done" } }));
    }
  }
  __setAgentActivityStateForTests(working, "local", "connected");
  longListVersion += 1;
  useCloudNotificationsStore.getState().applySnapshot({
    rows,
    summary: {
      totalCount: rows.length,
      unreadCount: rows.length,
      attentionCount: rows.filter(
        (row) => row.entry.severity === "needs_action",
      ).length,
    },
    version: longListVersion,
  });
}

/**
 * Twenty tasks, two in each of Needs you and To review, six working and ten
 * idle, the current one working: enough to overflow a short window. Written
 * through the product's own stores, like `seedSideStripSections`.
 */
export function seedSideStripLongList(): void {
  longListSections.clear();
  const refs = LONG_LIST_TASKS.map(([name, section]) => {
    const ref = epicRef(name);
    longListSections.set(ref.id, section);
    return ref;
  });
  useTabsStore.setState({
    version: 2,
    items: refs.map(loneItem),
    activeItemId: tabItemId(refs[4] ?? refs[0]),
    stripOrder: refs,
    systemTabs: { history: null, settings: null },
    groups: {},
    customizations: {},
  });
  writeLongList();
}

/** Moves one task of the long list to a section, as its state changing would. */
export function moveSideStripLongListTask(
  epicId: string,
  section: SeededSection,
): void {
  longListSections.set(epicId, section);
  writeLongList();
}
