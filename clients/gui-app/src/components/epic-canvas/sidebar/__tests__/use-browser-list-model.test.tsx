import "../../../../../__tests__/test-browser-apis";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextType, ReactNode } from "react";
import type { BrowserCatalogRecord } from "@traycer/protocol/host/browser/catalog-contracts";
import {
  sessionInfo,
  tabInfo,
} from "@/lib/browser-view/sessions/__tests__/browser-session-test-kit";
import type { BrowserSessionsState } from "@/components/epic-canvas/renderers/browser-sessions-context";
import { BrowserSessionsContext } from "@/components/epic-canvas/renderers/browser-sessions-context";
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
  isLoading: false,
  listsResolved: true,
  listsFailed: false,
  held: [] as Array<{ key: string; state: unknown }>,
}));

vi.mock(
  "@/lib/browser-view/sessions/browser-sessions-coordinator",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/lib/browser-view/sessions/browser-sessions-coordinator")
    >()),
    browserSessionsCoordinatorsForEpic: () => hostState.held,
    subscribeToBrowserSessionsCoordinators: () => () => undefined,
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

type CatalogValue = NonNullable<ContextType<typeof BrowserCatalogContext>>;

function catalog(
  records: readonly BrowserCatalogRecord[],
  overrides: Partial<CatalogValue>,
): CatalogValue {
  return {
    status: "ready",
    scope: "cloud",
    records,
    refetch: vi.fn(),
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

// An ambient stream that is not yet serving: it holds no host's membership.
function idleLive(): BrowserSessionsState {
  return { ...liveState([]), lifecycle: "connecting", inventoryReady: false };
}

function render(
  catalogValue: CatalogValue,
  live: BrowserSessionsState,
  query: string,
) {
  const wrapper = ({ children }: { readonly children: ReactNode }) => (
    <BrowserCatalogContext.Provider value={catalogValue}>
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

function hold(hostId: string, items: BrowserSessionsState["items"]): void {
  hostState.held.push({
    key: `held-${hostId}`,
    state: { ...liveState(items), hostId },
  });
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
    useBrowserPanelStore.setState({ preferences: {} });
    useAuthStore.setState({
      profile: { userId: "user-a", userName: "A", email: "a@example.com" },
    });
    hostState.hosts = [];
    hostState.localHostId = "host-local";
    hostState.held = [];
    hostState.isLoading = false;
    hostState.listsResolved = true;
    hostState.listsFailed = false;
    host("host-local", "This Mac", "online");
    host("host-work", "Work Mac", "online");
    host("host-nas", "NAS", "offline");
  });

  it("groups durable tabs by owning device, flags only the co-located one as local, and hides confirmed-offline devices", () => {
    const { result } = render(catalog(RECORDS, {}), idleLive(), "");
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
    const { result } = render(catalog(RECORDS, {}), idleLive(), "");
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
    const { result } = render(catalog(RECORDS, {}), idleLive(), "");
    const nas = result.current.groups.find(
      (group) => group.hostId === "host-nas",
    );
    expect(nas?.offline).toBe(true);
    expect(nas?.rows).toHaveLength(1);
  });

  it("offers offline recovery only when a hidden offline device matches the search", () => {
    const hit = render(catalog(RECORDS, {}), idleLive(), "router");
    expect(hit.result.current.groups).toEqual([]);
    expect(hit.result.current.hiddenOfflineMatches).toBe(true);
    expect(hit.result.current.filteredEmpty).toBe(false);

    const miss = render(catalog(RECORDS, {}), idleLive(), "nothing-matches");
    expect(miss.result.current.hiddenOfflineMatches).toBe(false);
  });

  it("reports a filter-emptied list distinctly from a task with no browsers", () => {
    const onlyOffline = [RECORDS[2]];
    const filtered = render(catalog(onlyOffline, {}), idleLive(), "");
    expect(filtered.result.current.filteredEmpty).toBe(true);
    expect(filtered.result.current.rows).toHaveLength(1);

    const none = render(catalog([], {}), idleLive(), "");
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
    const { result } = render(catalog(RECORDS, {}), idleLive(), "");
    expect(result.current.groups.map((group) => group.hostId)).toEqual([
      "host-local",
      "host-nas",
    ]);
  });

  it("expands a collapsed device while searching and restores the deliberate collapse when cleared", () => {
    useBrowserPanelStore
      .getState()
      .setCollapsed(JSON.stringify(["user-a", EPIC]), "host-work", true);
    const { result, rerender } = render(catalog(RECORDS, {}), idleLive(), "");
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

  it("replaces a held device's catalog rows with its live tabs and leaves other devices on the catalog", () => {
    hold("host-local", [
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
            tabId: "t9",
            url: "https://opened-since.example",
            title: "Opened since",
          }),
        ],
      }),
    ]);
    const { result } = render(catalog(RECORDS, {}), idleLive(), "");
    const rowsOf = (hostId: string) =>
      result.current.groups.find((group) => group.hostId === hostId)?.rows;

    const local = rowsOf("host-local");
    expect(local?.map((row) => row.tab.tabId)).toEqual(["t1", "t9"]);
    expect(local?.[0]?.tab.title).toBe("Live title");
    expect(local?.[0]?.tab.status).toBe("navigating");

    const work = rowsOf("host-work");
    expect(work?.map((row) => row.tab.tabId)).toEqual(["t1", "t2"]);
    expect(work?.[0]?.identity.title).toBe("Docs");
  });

  it("drops a held device's catalog rows when its live list is empty", () => {
    hold("host-work", []);
    const { result } = render(catalog(RECORDS, {}), idleLive(), "");
    expect(result.current.groups.map((group) => group.hostId)).toEqual([
      "host-local",
    ]);
  });

  it("shows only live tabs for a local-only task and nothing for an inaccessible one", () => {
    hold("host-local", [
      sessionInfo({
        sessionId: "s-live",
        hostId: "host-local",
        tabs: [
          tabInfo({ tabId: "t1", url: "https://live.example", title: "Live" }),
        ],
      }),
    ]);
    const localOnly = render(
      catalog(RECORDS, { scope: "local-only" }),
      idleLive(),
      "",
    );
    expect(localOnly.result.current.rows.map((row) => row.tab.title)).toEqual([
      "Live",
    ]);

    const blocked = render(
      catalog(RECORDS, { scope: "inaccessible" }),
      idleLive(),
      "",
    );
    expect(blocked.result.current.rows.map((row) => row.tab.title)).toEqual([
      "Live",
    ]);
  });

  it("is loading, not empty, until the first catalog fetch answers", () => {
    const { result } = render(
      catalog([], { status: "loading" }),
      idleLive(),
      "",
    );
    expect(result.current.status).toBe("loading");
    expect(result.current.loading).toBe(true);
  });

  it("keeps the last known groups when a refetch fails", () => {
    const { result } = render(
      catalog(RECORDS, { status: "error" }),
      idleLive(),
      "",
    );
    expect(result.current.groups.map((group) => group.hostId)).toEqual([
      "host-local",
      "host-work",
    ]);
    expect(result.current.status).toBe("error");
    expect(result.current.loading).toBe(false);
  });
});
