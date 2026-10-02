import { act } from "@testing-library/react";
import { MotionGlobalConfig } from "motion/react";
import { vi } from "vitest";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type { LocalHostSnapshot } from "@traycer-clients/shared/platform/runner-host";
import { providersListResponseSchema } from "@traycer/protocol/host/provider-schemas";
import { rateLimitUsageResponseSchemaV40 } from "@traycer/protocol/host/rate-limit/schemas";
import { createResourcesStore } from "@/stores/resources/resources-store";
import { resourcesRegistry } from "@/stores/resources/resources-registry";
import type { HostNotificationsIndicatorStateResponse } from "@traycer/protocol/host/notifications/contracts";
import type { HostRpcRegistry, MessengerFactory } from "@/lib/host";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";
import type { EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";
import type { ChatProjection, TreeNode } from "@/stores/epics/open-epic/types";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import { __setAgentActivityStateForTests } from "@/stores/agent-activity-store";
import { useSideTabStripStore } from "@/stores/layout/side-tab-strip-store";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  getLayoutSnapshot,
  useLayoutStore,
} from "@/stores/layout/layout-store";
import type { RateLimitProviderId } from "@/lib/rate-limit-providers";
import { tabItemId, tabRefKey, type StripItem } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";
import type { TabCustomizations } from "@/stores/tabs/tab-groups";
import type { TabRef } from "@/stores/tabs/types";
import type { LayoutSnapshot } from "@/lib/layout/layout-snapshot";

/**
 * The fixed facts the layout sweep composes its windows from: the host boundary's
 * answers, the shipped layout, the seeded tabs, epic session and resource
 * streams, the clocks held still, and the signature helpers. No JSX and no
 * component lives here (`layout-sweep-surfaces.tsx` holds those), so this file
 * can export whatever the harness and the test need.
 */

export type SweepWindow = "sample" | "epic";

/** This computer's host: the window's derived host, which the usage read needs. */
export const HARNESS_LOCAL_HOST: LocalHostSnapshot = {
  hostId: "sweep-host-studio",
  websocketUrl: "ws://127.0.0.1:9/studio",
  version: "1.2.3",
  pid: 1,
  systemHostName: "mac-studio.local",
  displayName: "Mac Studio",
  availability: "available",
};

/** The providers this host has signed in: the ones its usage cluster reads. */
export const SWEEP_CONFIGURED_PROVIDERS: ReadonlyArray<RateLimitProviderId> = [
  "codex",
  "claude-code",
];

/** Two signed-in providers, so the usage cluster has two real readings. */
const HARNESS_PROVIDERS = providersListResponseSchema.parse({
  providers: SWEEP_CONFIGURED_PROVIDERS.map((providerId) => ({
    providerId,
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [],
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
  })),
  native: null,
});

const HARNESS_RESETS_AT = Date.now() + 2 * 3_600_000;

/** Codex at 19% of its 5h window, Claude Code at 62% of its own. */
function harnessRateLimitUsage(providerId: string | undefined) {
  const window = (usedPercent: number, durationMinutes: number) => ({
    usedPercent,
    resetsAt: HARNESS_RESETS_AT,
    durationMinutes,
  });
  return rateLimitUsageResponseSchemaV40.parse({
    totalTokens: 0,
    remainingTokens: 0,
    providerRateLimits:
      providerId === "codex"
        ? {
            provider: "codex",
            available: true,
            planType: "pro",
            limitId: null,
            limitName: null,
            primary: window(19, 300),
            secondary: window(23, 10_080),
            extraWindows: [],
            credits: null,
            individualLimit: null,
            resetCredits: null,
            rateLimitReachedType: null,
          }
        : {
            provider: "claude-code",
            available: true,
            subscriptionType: "max",
            fiveHour: window(62, 300),
            sevenDay: window(41, 10_080),
            sevenDayOpus: null,
            sevenDaySonnet: null,
            modelScoped: [],
            extraUsage: null,
          },
  });
}

let harnessRequestCounter = 0;

/** The host calls the runtime makes on startup, and the two the readings read. */
export const harnessMessengerFactory: MessengerFactory<HostRpcRegistry> = ({
  registry,
}) =>
  new MockHostMessenger<HostRpcRegistry>({
    registry,
    requestId: () => `layout-sweep-${String(++harnessRequestCounter)}`,
    handlers: {
      "host.status": () => ({
        ready: true,
        hostVersion: "1.2.3",
        protocolVersion: { major: 1, minor: 2 },
        busy: false,
        busySessionCount: 0,
        updateProgress: null,
        busyBreakdown: null,
        updateOperation: null,
        updateTransaction: null,
        storeFormats: null,
        install: null,
      }),
      "host.notifications.indicatorState":
        (): HostNotificationsIndicatorStateResponse => ({
          epics: {},
          chats: {},
        }),
      "epic.getTaskContexts": () => ({ tasks: {} }),
      "providers.list": () => HARNESS_PROVIDERS,
      "host.getRateLimitUsage": (params) =>
        harnessRateLimitUsage(params.providerId),
    },
  });

// ── The shipped layout, as this window resets to it ─────────────────────────

/**
 * The layout every operation starts from: the shipped defaults with both
 * readings in the tab strip's bar (the fixture's `readings=both`), so the
 * header draws them and the status bar holds none.
 */
const BASE_SNAPSHOT: LayoutSnapshot = {
  ...DEFAULT_LAYOUT_SNAPSHOT,
  arrangement: {
    ...DEFAULT_LAYOUT_SNAPSHOT.arrangement,
    usageHost: "header",
    resourceHost: "header",
  },
};

/**
 * Back to that layout, and the state every reset of the fixture puts back: the
 * three readings the resource tile draws, the strip expanded. `replaceAll` is
 * the seam Undo and Reset restore whole snapshots through, so the base preset,
 * the delta and the arrangement all return.
 */
export function resetToShippedLayout(): void {
  useLayoutStore.getState().replaceAll(BASE_SNAPSHOT);
  useLayoutStore.getState().setRegionValues("resourceMonitor", {
    cpu: true,
    memory: true,
    processes: false,
    ramShare: true,
  });
  useSideTabStripStore.getState().setCollapsed(false);
}

// ── Time and motion ─────────────────────────────────────────────────────────

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Holds every clock the column draws from still, so the only thing that can
 * change its HTML is a setting.
 *
 * Three things move on their own in this column, and the noise control caught
 * the first of them: the status animations' 25 Hz interval (the live Todo dot's
 * ping ring rewrites its inline `opacity` and `transform` every tick), motion's
 * frame loop, and relative times ("1h 59m", "10m") that read `Date.now()`.
 * None of that is stripped from the signature. The status clock is told the
 * user prefers reduced motion - the product's own switch, which stops its
 * interval and leaves the resting look - motion is told to skip its
 * animations, and `Date` is frozen, so a countdown does not tick over a minute
 * boundary in the middle of a run. Timers stay real, so `settle()` still waits.
 */
export function holdClocksStill(): () => void {
  const originalMatchMedia = window.matchMedia.bind(window);
  vi.stubGlobal("matchMedia", (query: string) => {
    if (query !== REDUCED_MOTION_QUERY) return originalMatchMedia(query);
    return {
      matches: true,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    };
  });
  const skipped = MotionGlobalConfig.skipAnimations;
  MotionGlobalConfig.skipAnimations = true;
  vi.useFakeTimers({ toFake: ["Date"] });
  return () => {
    vi.useRealTimers();
    MotionGlobalConfig.skipAnimations = skipped;
    vi.unstubAllGlobals();
  };
}

/** The stored layout the shipped state is: what every sweep entry starts from. */
export function shippedLayoutSnapshot(): LayoutSnapshot {
  resetToShippedLayout();
  return getLayoutSnapshot();
}

// ── Tabs ────────────────────────────────────────────────────────────────────

const SEED_GROUP_ID = "sweep-group";
export const EPIC_SURFACE_ID = "sweep-epsilon";
const SAMPLE_WORKSPACE_REF: TabRef = {
  kind: "sample-workspace",
  id: "sample-workspace",
};

function epicRef(name: string): TabRef {
  const id = `sweep-${name.split(" ")[0].toLowerCase()}`;
  useEpicCanvasStore.getState().seedEpic(id, { tabId: id, name }, []);
  return { kind: "epic", id };
}

function loneItem(ref: TabRef): StripItem {
  return { kind: "tab", id: tabItemId(ref), ref };
}

/**
 * Six task tabs written through the product's own stores as a restored window
 * holds them: one split pair, three in one named group, three with a colour.
 * The sample window also holds the layout session's own tab and has it active;
 * the epic window has `Epsilon cleanup` active.
 */
export function seedTabs(sessionTab: boolean): void {
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
      id: "sweep-split",
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
      [SEED_GROUP_ID]: { name: "Work", color: "#8ab4f8", collapsed: false },
    },
    customizations,
  });
}

// ── The epic window ─────────────────────────────────────────────────────────

const EPIC_SURFACE_AGENTS: ReadonlyArray<TreeNode> = [
  chatNode("sweep-agent-plan", null, "Plan the migration"),
  chatNode("sweep-agent-tests", "sweep-agent-plan", "Write the tests"),
  chatNode("sweep-agent-index", null, "Rebuild the index"),
];

/** The agent Epsilon's resource stream tracks: the row chip's owner. */
export const TRACKED_AGENT_ID = "sweep-agent-plan";

function chatNode(
  id: string,
  parentId: string | null,
  title: string,
): TreeNode {
  return {
    id,
    parentId,
    title,
    type: "chat",
    status: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

const noopStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

/**
 * Epsilon's session: a real open-epic store with its agents in the tree and as
 * chats, registered so the strip names them, with the activity plane saying
 * they are working, so the Activity view nests them under Epsilon's row.
 */
export function openEpicSession(): OpenedStoreForTest {
  const handle = openStoreForTest({
    epicId: EPIC_SURFACE_ID,
    userId: null,
    factories: {
      streamClientFactory: noopStreamClientFactory,
      laneSelection: null,
    },
    writeCommand: null,
  });
  const nodeById: Record<string, TreeNode> = {};
  const childrenByParent: Record<string, string[]> = {};
  const rootIds: string[] = [];
  for (const node of EPIC_SURFACE_AGENTS) {
    nodeById[node.id] = node;
    if (node.parentId === null) rootIds.push(node.id);
    else (childrenByParent[node.parentId] ??= []).push(node.id);
  }
  handle.store.setState({ tree: { rootIds, childrenByParent, nodeById } });
  const chats: Record<string, ChatProjection> = {};
  for (const node of EPIC_SURFACE_AGENTS) {
    chats[node.id] = {
      id: node.id,
      title: node.title,
      parentId: node.parentId,
      createdAt: 1,
      updatedAt: 1,
      userId: null,
      hostId: HARNESS_LOCAL_HOST.hostId,
      isTitleEditedByUser: false,
      docResident: false,
      archivedAt: null,
      settings: null,
    };
  }
  handle.store.setState({ chats: { allIds: Object.keys(chats), byId: chats } });
  __getOpenEpicRegistryForTests().acquire(EPIC_SURFACE_ID, () => handle);
  const working = EPIC_SURFACE_AGENTS.map((node) => node.id);
  __setAgentActivityStateForTests(
    { [EPIC_SURFACE_ID]: { working, turn: working.slice(0, 2) } },
    "local",
    "connected",
  );
  return handle;
}

export const EPIC_SURFACE_CHAT: EpicCanvasTileRef = {
  id: "sweep-epsilon-chat",
  instanceId: "sweep-epsilon-chat",
  type: "chat",
  name: "Plan the migration",
  hostId: "sweep-host",
};

export function seedEpicCanvas(): void {
  const paneId = "sweep-epsilon-pane";
  useEpicCanvasStore.setState((state) => ({
    canvasByTabId: {
      ...state.canvasByTabId,
      [EPIC_SURFACE_ID]: {
        root: {
          kind: "pane",
          id: paneId,
          tabInstanceIds: [EPIC_SURFACE_CHAT.instanceId],
          activeTabId: EPIC_SURFACE_CHAT.instanceId,
          previewTabId: null,
          activationHistory: [EPIC_SURFACE_CHAT.instanceId],
        },
        activePaneId: paneId,
        tilesByInstanceId: {
          [EPIC_SURFACE_CHAT.instanceId]: EPIC_SURFACE_CHAT,
        },
        sizesByGroupId: {},
      },
    },
  }));
}

// ── Mounting ────────────────────────────────────────────────────────────────

export interface SweepMount {
  /** The mounted tree's root element (the app column, or the settings panel). */
  readonly root: () => HTMLElement;
  /** The app column's HTML now, normalised for React's minted ids. */
  readonly signature: () => string;
  /** The app column's HTML with nothing normalised. */
  readonly rawHtml: () => string;
  /** Runs `write` inside `act` and lets what it wrote land. */
  readonly apply: (write: () => void) => Promise<void>;
  /**
   * `write` inside `act` and one macrotask, without reading the column: for a
   * warm-up pass, which only needs every render a write causes to have run.
   */
  readonly poke: (write: () => void) => Promise<void>;
  /** Lets pending renders, queries and effects land, until the HTML holds still. */
  readonly settle: () => Promise<void>;
  readonly unmount: () => void;
}

/** One macrotask, inside `act`, so promises and timers a write queued run. */
export async function tick(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  });
}

/**
 * The ids a page mints from a counter, which differ between two renders of the
 * same tree in one document because the counter is global: the id attribute,
 * and every attribute that names another element by it, carries one. They are
 * replaced by one token, so what is compared is the tree and not the counter.
 * These are the only two kinds this column mints, and the test file proves
 * each differs between two identical renders before it lets either be
 * stripped.
 *
 * - React's `useId`, which Radix's ids are built from.
 * - dnd-kit's `DndDescribedBy-<n>` / `DndLiveRegion-<n>`, which come from a
 *   module counter of its own and so move whenever a sortable list mounts.
 */
export interface MintedIdKind {
  readonly name: string;
  readonly pattern: RegExp;
  /** What each match becomes; `$1` keeps a prefix the counter was appended to. */
  readonly replacement: string;
}

export const MINTED_ID_KINDS: ReadonlyArray<MintedIdKind> = [
  {
    name: "React useId",
    pattern: /«r[0-9a-z]+»|_r_[0-9a-z]+_|:r[0-9a-z]+:/g,
    replacement: "«id»",
  },
  {
    name: "dnd-kit unique id",
    pattern: /(Dnd(?:DescribedBy|LiveRegion))-\d+/g,
    replacement: "$1-«id»",
  },
];

export function normalisedMintedIds(html: string): string {
  return MINTED_ID_KINDS.reduce(
    (text, kind) => text.replace(kind.pattern, kind.replacement),
    html,
  );
}

/**
 * Two signatures of the same tree, compared as a browser would read them.
 *
 * `innerHTML` writes a tag's attributes in the order they were SET, and that
 * order is not part of what a tree is: a Radix collapsible that remounts sets
 * `hidden` after `data-slot`, one that never left sets it before, and the two
 * are the same element. So when the strings differ they are compared again
 * with each tag's attributes sorted. Nothing is removed: every attribute,
 * `style` and `data-state` included, still has to match name for name and value
 * for value.
 */
const TAG = /<([A-Za-z][^\s/>]*)((?:\s+[^\s"'=<>`/]+(?:="[^"]*")?)*)\s*(\/?)>/g;
const ATTRIBUTE = /\s+([^\s"'=<>`/]+)(?:="([^"]*)")?/g;

function withSortedAttributes(
  _tag: string,
  name: string,
  attributes: string,
  selfClosing: string,
): string {
  const pairs = [...attributes.matchAll(ATTRIBUTE)].map((match) =>
    match[0].trim(),
  );
  pairs.sort();
  return `<${name}${pairs.map((pair) => ` ${pair}`).join("")}${selfClosing}>`;
}

export function sameSignature(left: string, right: string): boolean {
  if (left === right) return true;
  return (
    left.replace(TAG, withSortedAttributes) ===
    right.replace(TAG, withSortedAttributes)
  );
}

/**
 * The two resource streams the readings draw from: the host's own machine reading
 * (every window), and the tracked agent's process (the epic window). Both answer
 * through the REAL `resourcesRegistry` and `createResourcesStore`; only the wire
 * beneath them is a stand-in.
 */
export function seedResourceStreams(windowKind: SweepWindow | "panel"): void {
  const sampledAt = Date.now();
  resourcesRegistry.acquireGlobal("sweep", HARNESS_LOCAL_HOST.hostId, () =>
    createResourcesStore({
      scope: { kind: "global" },
      streamClientFactory: (_scope, callbacks) => {
        queueMicrotask(() => {
          callbacks.onScopeSupport("supported");
          callbacks.onSnapshot({
            epicId: "__global__",
            sampledAt,
            app: {
              sampledAt,
              hostTotalMemoryBytes: 32 * 1024 ** 3,
              process: {
                pid: 10,
                parentPid: null,
                rootPid: 10,
                name: "traycer-host",
                command: "traycer-host",
                cpuPercent: 2,
                rssBytes: 400 * 1024 ** 2,
                pssBytes: null,
                privateBytes: null,
                descriptor: null,
              },
              processCount: 1,
              cpuPercent: 2,
              rssBytes: 400 * 1024 ** 2,
              pssBytes: null,
              privateBytes: null,
            },
            owners: [],
            epic: null,
            epics: [],
            hostTree: {
              sampledAt,
              processCount: 12,
              cpuPercent: 14,
              rssBytes: 3.2 * 1024 ** 3,
              pssBytes: null,
              privateBytes: null,
            },
            other: null,
            restricted: null,
          });
        });
        return { close: () => undefined, setDemand: () => undefined };
      },
    }),
  );
  if (windowKind === "epic") {
    resourcesRegistry.acquire(EPIC_SURFACE_ID, "sweep", "sweep-host", () =>
      createResourcesStore({
        scope: { kind: "epic", epicId: EPIC_SURFACE_ID },
        streamClientFactory: (_scope, callbacks) => {
          queueMicrotask(() => {
            callbacks.onSnapshot({
              epicId: EPIC_SURFACE_ID,
              sampledAt,
              app: null,
              owners: [
                {
                  owner: {
                    kind: "chat",
                    hostId: "sweep-host",
                    epicId: EPIC_SURFACE_ID,
                    ownerId: TRACKED_AGENT_ID,
                  },
                  sampledAt,
                  rootPids: [20],
                  activeProcessName: "claude",
                  processCount: 3,
                  cpuPercent: 0.5,
                  rssBytes: 472 * 1024 ** 2,
                  pssBytes: null,
                  privateBytes: null,
                  harnessId: "claude",
                  managedCommand: null,
                  processes: [],
                },
              ],
              epic: null,
              epics: [],
              hostTree: null,
              other: null,
              restricted: null,
            });
          });
          return { close: () => undefined, setDemand: () => undefined };
        },
      }),
    );
  }
}
