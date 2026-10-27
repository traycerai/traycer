import "../../../../../__tests__/test-browser-apis";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import {
  BROWSER_CATALOG_VERSION,
  type BrowserCatalogReadiness,
  type BrowserCatalogRecord,
} from "@traycer/protocol/host/browser/catalog-contracts";
import {
  sessionInfo,
  tabInfo,
} from "@/lib/browser-view/sessions/__tests__/browser-session-test-kit";
import type { BrowserCatalogInventory } from "@/lib/browser-view/sessions/browser-catalog-inventory";
import type { BrowserSessionsState } from "@/components/epic-canvas/renderers/browser-sessions-context";
import {
  BrowserSessionsContext,
  BrowserSessionsCoordinatorKeyContext,
} from "@/components/epic-canvas/renderers/browser-sessions-context";
import { BrowserCatalogContext } from "@/components/epic-canvas/renderers/browser-catalog-context";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useBrowserPanelStore } from "@/stores/epics/browser-panel-store";
import { useBrowserListModel } from "../use-browser-list-model";

type Health = "online" | "unknown" | "offline" | "stopped" | "removed";

const hostState = vi.hoisted(() => ({
  hosts: [] as Array<{
    hostId: string;
    name: string;
    health: { state: string };
    entry: { kind: string } | null;
  }>,
  localHostId: "host-local" as string | null,
  ownerSupportsInventory: true,
  isLoading: false,
  listsResolved: true,
  listsFailed: false,
}));

vi.mock(
  "@/lib/browser-view/sessions/browser-sessions-coordinator",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/lib/browser-view/sessions/browser-sessions-coordinator")
    >()),
    browserSessionsOwnerSupportsInventory: () =>
      hostState.ownerSupportsInventory,
  }),
);
vi.mock("@/components/settings/host-scope/use-host-options", () => ({
  useHostOptions: () => ({
    hosts: hostState.hosts,
    isLoading: hostState.isLoading,
    listsResolved: hostState.listsResolved,
    listsFailed: hostState.listsFailed,
  }),
}));
vi.mock("@/hooks/host/use-reactive-local-host-id", () => ({
  useReactiveLocalHostId: () => hostState.localHostId,
}));
vi.mock("@/hooks/host/use-surface-host-pin", () => ({
  useTabSurfaceKey: (kind: string, tabId: string) => `${kind}:${tabId}`,
  useSurfaceHostPin: () => ({ resolvedHostId: "host-local" }),
}));
vi.mock("@/components/epic-canvas/renderers/browser-sessions-provider", () => ({
  BrowserSessionsHostBoundary: (props: { readonly children: ReactNode }) =>
    props.children,
}));

const EPIC = "epic-1";

function host(hostId: string, name: string, health: Health): void {
  hostState.hosts.push({
    hostId,
    name,
    health: { state: health },
    entry: { kind: "host" },
  });
}

function record(
  hostId: string,
  sessionId: string,
  tabs: ReadonlyArray<{ tabId: string; title: string | null; url: string }>,
): BrowserCatalogRecord {
  return {
    epicId: EPIC,
    hostId,
    sessionId,
    inventoryRevision: 1,
    lastActivityAt: 1,
    tabs: [...tabs],
  };
}

function readiness(
  hostId: string,
  state: BrowserCatalogReadiness["state"],
): BrowserCatalogReadiness {
  return {
    hostId,
    state,
    indexingRevision: 1,
    capability: {
      catalogVersion: BROWSER_CATALOG_VERSION,
      durableInventoryRevisions: true,
      revisionedMutationAcks: true,
    },
  };
}

function inventory(
  records: readonly BrowserCatalogRecord[],
  overrides: Partial<BrowserCatalogInventory>,
): BrowserCatalogInventory {
  return {
    status: "available",
    records,
    readiness: [...new Set(records.map((entry) => entry.hostId))].map(
      (hostId) => readiness(hostId, "complete"),
    ),
    version: 1,
    pendingCount: 0,
    revokedHostIds: [],
    ...overrides,
  };
}

function liveState(items: BrowserSessionsState["items"]): BrowserSessionsState {
  return {
    hostId: "host-local",
    lifecycle: "live",
    inventoryReady: true,
    canMaterializeElectron: false,
    connectionGeneration: 0,
    items,
    viewports: {},
    setViewport: () => Promise.reject(new Error("not used")),
    reportViewport: () => undefined,
    errorMessage: null,
    retry: vi.fn(),
    openTab: () => Promise.reject(new Error("not used")),
    prepareOpenTab: () => {
      throw new Error("not used");
    },
    closeTab: () => Promise.reject(new Error("not used")),
    attachTab: () => Promise.reject(new Error("not used")),
    moveTab: () => Promise.reject(new Error("not used")),
  };
}

function render(
  inv: BrowserCatalogInventory,
  live: BrowserSessionsState,
  query: string,
) {
  const wrapper = ({ children }: { readonly children: ReactNode }) => (
    <BrowserCatalogContext.Provider
      value={{ inventory: inv, hosts: new Map(), refresh: vi.fn() }}
    >
      <BrowserSessionsContext.Provider value={live}>
        {children}
      </BrowserSessionsContext.Provider>
    </BrowserCatalogContext.Provider>
  );
  return renderHook(({ q }) => useBrowserListModel(EPIC, q, null), {
    wrapper,
    initialProps: { q: query },
  });
}

function renderBrowsingDevice(
  inv: BrowserCatalogInventory,
  live: BrowserSessionsState,
) {
  const wrapper = ({ children }: { readonly children: ReactNode }) => (
    <BrowserCatalogContext.Provider
      value={{ inventory: inv, hosts: new Map(), refresh: vi.fn() }}
    >
      <BrowserSessionsCoordinatorKeyContext.Provider value="coordinator-key">
        <BrowserSessionsContext.Provider value={live}>
          {children}
        </BrowserSessionsContext.Provider>
      </BrowserSessionsCoordinatorKeyContext.Provider>
    </BrowserCatalogContext.Provider>
  );
  return renderHook(() => useBrowserListModel(EPIC, "", null), { wrapper });
}

const RECORDS = [
  record("host-local", "s-local", [
    { tabId: "t1", title: "Docs", url: "https://docs.example.com" },
  ]),
  record("host-work", "s-work", [
    { tabId: "t1", title: "Docs", url: "https://work.example.com/docs" },
    { tabId: "t2", title: "Billing", url: "https://billing.example.com" },
  ]),
  record("host-nas", "s-nas", [
    { tabId: "t1", title: "Router", url: "http://192.168.0.1" },
  ]),
];

describe("useBrowserListModel", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useBrowserPanelStore.setState({ preferences: {}, legacyHostByScope: {} });
    useAuthStore.setState({
      profile: { userId: "user-a", userName: "A", email: "a@example.com" },
    });
    hostState.hosts = [];
    hostState.localHostId = "host-local";
    hostState.ownerSupportsInventory = true;
    hostState.isLoading = false;
    hostState.listsResolved = true;
    hostState.listsFailed = false;
    host("host-local", "This Mac", "online");
    host("host-work", "Work Mac", "online");
    host("host-nas", "NAS", "offline");
  });

  it("groups durable tabs by owning device, flags only the co-located one as local, and hides confirmed-offline devices", () => {
    const { result } = render(inventory(RECORDS, {}), liveState([]), "");
    expect(
      result.current.groups.map((group) => [
        group.hostId,
        group.name,
        group.isLocal,
        group.rows.length,
      ]),
    ).toEqual([
      ["host-local", "This Mac", true, 1],
      ["host-work", "Work Mac", false, 2],
    ]);
    expect(result.current.groups.every((group) => group.expanded)).toBe(true);
  });

  it("keeps duplicate titles apart by owner and shows an unknown device instead of hiding it", () => {
    hostState.hosts = [];
    host("host-local", "This Mac", "online");
    host("host-work", "Work Mac", "unknown");
    host("host-nas", "NAS", "offline");
    const { result } = render(inventory(RECORDS, {}), liveState([]), "");
    const titles = result.current.groups.flatMap((group) =>
      group.rows
        .filter((row) => row.tab.title === "Docs")
        .map(() => group.hostId),
    );
    expect(titles).toEqual(["host-local", "host-work"]);
    expect(
      result.current.groups.find((group) => group.hostId === "host-work")
        ?.offline,
    ).toBe(false);
  });

  it("reveals offline devices once the preference is on and labels them offline", () => {
    useBrowserPanelStore
      .getState()
      .setShowOffline(JSON.stringify(["user-a", EPIC]), true);
    const { result } = render(inventory(RECORDS, {}), liveState([]), "");
    const nas = result.current.groups.find(
      (group) => group.hostId === "host-nas",
    );
    expect(nas?.offline).toBe(true);
    expect(nas?.rows).toHaveLength(1);
  });

  it("offers offline recovery only when a hidden offline device matches the search", () => {
    const hit = render(inventory(RECORDS, {}), liveState([]), "router");
    expect(hit.result.current.groups).toEqual([]);
    expect(hit.result.current.hiddenOfflineMatches).toBe(true);
    expect(hit.result.current.filteredEmpty).toBe(false);

    const miss = render(
      inventory(RECORDS, {}),
      liveState([]),
      "nothing-matches",
    );
    expect(miss.result.current.hiddenOfflineMatches).toBe(false);
  });

  it("reports a filter-emptied list distinctly from a task with no browsers", () => {
    const onlyOffline = [RECORDS[2]];
    const filtered = render(inventory(onlyOffline, {}), liveState([]), "");
    expect(filtered.result.current.filteredEmpty).toBe(true);
    expect(filtered.result.current.rows).toHaveLength(1);

    const none = render(inventory([], {}), liveState([]), "");
    expect(none.result.current.filteredEmpty).toBe(false);
    expect(none.result.current.rows).toHaveLength(0);
  });

  it("drops removed devices even with the offline preference on", () => {
    useBrowserPanelStore
      .getState()
      .setShowOffline(JSON.stringify(["user-a", EPIC]), true);
    hostState.hosts = [];
    host("host-local", "This Mac", "online");
    host("host-work", "Work Mac", "removed");
    host("host-nas", "NAS", "stopped");
    const { result } = render(inventory(RECORDS, {}), liveState([]), "");
    expect(result.current.groups.map((group) => group.hostId)).toEqual([
      "host-local",
      "host-nas",
    ]);
  });

  it("expands a collapsed device while searching and restores the deliberate collapse when cleared", () => {
    useBrowserPanelStore
      .getState()
      .setCollapsed(JSON.stringify(["user-a", EPIC]), "host-work", true);
    const { result, rerender } = render(
      inventory(RECORDS, {}),
      liveState([]),
      "",
    );
    const expanded = (): Record<string, boolean> =>
      Object.fromEntries(
        result.current.groups.map((group) => [group.hostId, group.expanded]),
      );
    expect(expanded()).toEqual({ "host-local": true, "host-work": false });

    rerender({ q: "billing" });
    expect(expanded()).toEqual({ "host-work": true });

    rerender({ q: "https://docs.example.com" });
    expect(expanded()).toEqual({ "host-local": true });

    rerender({ q: "" });
    expect(expanded()).toEqual({ "host-local": true, "host-work": false });
  });

  it("takes membership from durable records and only decorates them with live status", () => {
    const live = liveState([
      sessionInfo({
        sessionId: "s-local",
        hostId: "host-local",
        tabs: [
          tabInfo({
            tabId: "t1",
            url: "https://redirected.example",
            title: "Live title",
            status: "navigating",
          }),
          tabInfo({
            tabId: "ghost",
            url: "https://ghost.example",
            title: "Ghost",
          }),
        ],
      }),
    ]);
    const { result } = render(inventory(RECORDS, {}), live, "");
    const local = result.current.groups.find(
      (group) => group.hostId === "host-local",
    );
    expect(local?.rows.map((row) => row.tab.tabId)).toEqual(["t1"]);
    expect(local?.rows[0]?.identity.title).toBe("Docs");
    expect(local?.rows[0]?.tab.status).toBe("navigating");
  });

  it("flags incomplete indexing rather than presenting it as complete", () => {
    const partial = render(
      inventory(RECORDS, {
        readiness: [readiness("host-local", "incomplete")],
      }),
      liveState([]),
      "",
    );
    expect(partial.result.current.incomplete).toBe(true);

    const complete = render(inventory(RECORDS, {}), liveState([]), "");
    expect(complete.result.current.incomplete).toBe(false);
  });

  it("falls back to the selected host's live list for a local-only task and never shows an inaccessible one", () => {
    const live = liveState([
      sessionInfo({
        sessionId: "s-live",
        hostId: "host-local",
        tabs: [
          tabInfo({ tabId: "t1", url: "https://live.example", title: "Live" }),
        ],
      }),
    ]);
    const localOnly = render(inventory([], { status: "local-only" }), live, "");
    expect(localOnly.result.current.fallback).toBe(true);
    expect(localOnly.result.current.rows).toHaveLength(1);

    const blocked = render(
      inventory(RECORDS, { status: "inaccessible" }),
      live,
      "",
    );
    expect(blocked.result.current.rows).toHaveLength(0);
  });

  it("never unions live sessions into a durable owner's rows", () => {
    const live = liveState([
      sessionInfo({
        sessionId: "s-new",
        hostId: "host-local",
        tabs: [tabInfo({ tabId: "t7", url: "https://not-durable.example" })],
      }),
    ]);
    const { result } = render(inventory(RECORDS, {}), live, "");
    expect(result.current.rows.some((row) => row.tab.tabId === "t7")).toBe(
      false,
    );
  });

  it("browses one explicitly chosen older device from its own live list, not the catalog, and leaves through All devices", () => {
    hostState.ownerSupportsInventory = false;
    const live = {
      ...liveState([
        sessionInfo({
          sessionId: "s-live",
          hostId: "host-work",
          tabs: [
            tabInfo({
              tabId: "t-live",
              url: "https://live.example",
              title: "Live only",
            }),
          ],
        }),
      ]),
      hostId: "host-work",
    };
    // Stale "complete" readiness for the device must not hide what it is serving now.
    const inv = inventory(RECORDS, {});
    const chosen = renderBrowsingDevice(inv, live);
    expect(chosen.result.current.legacyView).toBe(false);

    act(() => chosen.result.current.preferences.setLegacyHost("host-work"));
    expect(chosen.result.current.legacyView).toBe(true);
    expect(chosen.result.current.groups.map((group) => group.hostId)).toEqual([
      "host-work",
    ]);
    expect(chosen.result.current.rows.map((row) => row.tab.tabId)).toEqual([
      "t-live",
    ]);
    expect(chosen.result.current.rows[0]?.session.source).toBe("legacy");

    act(() => chosen.result.current.preferences.setLegacyHost(null));
    expect(chosen.result.current.legacyView).toBe(false);
    expect(
      chosen.result.current.groups.flatMap((group) =>
        group.rows.map((row) => `${group.hostId}:${row.tab.tabId}`),
      ),
    ).toEqual(["host-local:t1", "host-work:t1", "host-work:t2"]);
  });

  it("never switches to a device's own list for a supported owner, a local-only task or an inaccessible one", () => {
    useBrowserPanelStore
      .getState()
      .setLegacyHost(JSON.stringify(["user-a", EPIC]), "host-work");
    const live = liveState([]);

    hostState.ownerSupportsInventory = true;
    expect(
      renderBrowsingDevice(inventory(RECORDS, {}), live).result.current
        .legacyView,
    ).toBe(false);

    hostState.ownerSupportsInventory = false;
    expect(
      renderBrowsingDevice(inventory(RECORDS, { status: "inaccessible" }), live)
        .result.current.legacyView,
    ).toBe(false);
    expect(
      renderBrowsingDevice(inventory([], { status: "local-only" }), live).result
        .current.legacyView,
    ).toBe(false);
  });

  it("is loading, not empty, while the device lists have not answered", () => {
    hostState.isLoading = true;
    hostState.listsResolved = false;
    const { result } = render(
      inventory([], { readiness: [readiness("host-local", "complete")] }),
      liveState([]),
      "",
    );
    expect(result.current.loading).toBe(true);
    expect(result.current.incomplete).toBe(true);
  });

  it("keeps known groups and flags the list unavailable when the device lists fail", () => {
    hostState.listsFailed = true;
    const { result } = render(inventory(RECORDS, {}), liveState([]), "");
    expect(result.current.groups.map((group) => group.hostId)).toEqual([
      "host-local",
      "host-work",
    ]);
    expect(result.current.directoryUnavailable).toBe(true);
    expect(result.current.incomplete).toBe(true);
    expect(result.current.loading).toBe(false);
  });

  it("marks a partly answered directory incomplete without hiding the rows it has", () => {
    hostState.listsResolved = false;
    const { result } = render(inventory(RECORDS, {}), liveState([]), "");
    expect(result.current.rows.length).toBeGreaterThan(0);
    expect(result.current.incomplete).toBe(true);
    expect(result.current.loading).toBe(false);
  });

  it("is a complete empty list only once every fact has resolved successfully", () => {
    const { result } = render(
      inventory([], {
        readiness: ["host-local", "host-work", "host-nas"].map((hostId) =>
          readiness(hostId, "complete"),
        ),
      }),
      liveState([]),
      "",
    );
    expect(result.current.rows).toHaveLength(0);
    expect(result.current.loading).toBe(false);
    expect(result.current.incomplete).toBe(false);
    expect(result.current.directoryUnavailable).toBe(false);
  });

  it("drops a revoked device's rows even while it is online, and ignores an explicit choice of it", () => {
    hostState.ownerSupportsInventory = false;
    useBrowserPanelStore
      .getState()
      .setLegacyHost(JSON.stringify(["user-a", EPIC]), "host-work");
    const live = {
      ...liveState([
        sessionInfo({
          sessionId: "s-live",
          hostId: "host-work",
          tabs: [
            tabInfo({
              tabId: "t-live",
              url: "https://live.example",
              title: "Live only",
            }),
          ],
        }),
      ]),
      hostId: "host-work",
    };

    const { result } = renderBrowsingDevice(
      inventory(RECORDS, { revokedHostIds: ["host-work"] }),
      live,
    );

    expect(result.current.groups.map((group) => group.hostId)).toEqual([
      "host-local",
    ]);
    expect(result.current.legacyView).toBe(false);
    expect(result.current.legacyHostId).toBeNull();
    expect(result.current.rows.some((row) => row.tab.tabId === "t-live")).toBe(
      false,
    );
  });
});
