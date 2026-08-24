import "../../../../../__tests__/test-browser-apis";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserSessionInfo } from "@traycer/protocol/host/browser/contracts";
import { BrowserSessionTile } from "@/components/epic-canvas/renderers/browser-session-tile";
import type { ElectronTabBinding } from "@/lib/browser-view/electron-tabs";
import type { BrowserSessionTileRef } from "@/stores/epics/canvas/types";

const harness = vi.hoisted(() => ({
  binding: null as ElectronTabBinding | null,
  items: [] as BrowserSessionInfo[],
  lifecycle: "live" as "connecting" | "live" | "reconnecting" | "closed",
  closeCanvasTile: vi.fn(),
}));

vi.mock("@/components/epic-canvas/renderers/browser-sessions-context", () => ({
  useBrowserSessionsContext: () => ({
    lifecycle: harness.lifecycle,
    items: harness.items,
    errorMessage: null,
    routingChatId: "chat-route",
    retry: vi.fn(),
    closeSession: vi.fn(),
    closeTab: vi.fn(),
    requestPromoteState: vi.fn(),
    requestLendStorage: vi.fn(),
  }),
}));
vi.mock("@/lib/browser-view/electron-tabs", () => ({
  useElectronTabBindingOnHost: () => harness.binding,
}));
vi.mock("@/components/epic-canvas/hooks/use-canvas-host-id", () => ({
  useCanvasHostId: () => "host-test",
}));
vi.mock(
  "@/components/epic-canvas/renderers/use-close-canvas-tile-with-nested-focus",
  () => ({
    useCloseCanvasTileWithNestedFocus: () => harness.closeCanvasTile,
  }),
);
vi.mock("@/components/epic-canvas/renderers/browser-session-dock", () => ({
  BrowserSessionsHostProvider: (props: {
    readonly children: React.ReactNode;
  }) => props.children,
}));
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
}));
vi.mock("@/components/epic-canvas/renderers/agent-browser-tile", () => ({
  ElectronTabSurface: (props: {
    readonly node: { readonly id: string };
    readonly binding: ElectronTabBinding;
  }) => (
    <div
      data-testid="managed-electron-tab"
      data-node-id={props.node.id}
      data-registration={props.binding.registrationId}
    />
  ),
}));
vi.mock("@/components/epic-canvas/renderers/browser-peek-tile", () => ({
  BrowserPeekTile: (props: {
    readonly node: { readonly sessionId: string; readonly tabId: string };
  }) => (
    <div
      data-testid="headless-browser-tab"
      data-session={props.node.sessionId}
      data-tab={props.node.tabId}
    />
  ),
}));

const NODE: BrowserSessionTileRef = {
  id: "browser-session:sess-1:tab-1",
  instanceId: "pointer-instance-1",
  type: "browser-session",
  name: "Pointer tab",
  hostId: "host-test",
  sessionId: "sess-1",
  tabId: "tab-1",
};

function session(
  status: "ready" | "dormant" | "navigating" | "crashed",
  runtime: "headless" | "electron" | "dormant" | null,
): BrowserSessionInfo {
  return {
    sessionId: "sess-1",
    epicId: "epic-1",
    hostId: "host-test",
    profile: "primary",
    name: "Main",
    createdBy: { chatId: "chat-route", agentRunId: "run-1" },
    createdAt: 1,
    lastActivityAt: 2,
    migration: runtime === null ? undefined : { revision: 1, runtime },
    tabs: [
      {
        tabId: "tab-1",
        url: "https://example.com/page",
        originTier: "dev",
        status,
        title: "Example",
        viewed: false,
        drivenBy: [],
      },
    ],
  };
}

function binding(): ElectronTabBinding {
  return {
    hostId: "host-test",
    sessionId: "sess-1",
    tabId: "tab-1",
    registrationId: "native-registration-1",
    url: "https://example.com/page",
    title: "Example",
    control: vi.fn(async () => {}),
    bindSurface: vi.fn(),
  };
}

function renderTile(): void {
  render(
    <BrowserSessionTile
      node={NODE}
      viewTabId="view-1"
      paneId="pane-1"
      epicId="epic-1"
    />,
  );
}

describe("BrowserSessionTile lifecycle projection", () => {
  beforeEach(() => {
    harness.binding = null;
    harness.items = [session("ready", null)];
    harness.lifecycle = "live";
    harness.closeCanvasTile.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders an accepted native binding without copying registration into canvas identity", () => {
    harness.binding = binding();
    harness.items = [session("ready", "electron")];

    renderTile();

    const managed = screen.getByTestId("managed-electron-tab");
    expect(managed.dataset.nodeId).toBe(NODE.id);
    expect(managed.dataset.registration).toBe("native-registration-1");
  });

  it("renders the headless projection when the host says headless", () => {
    harness.items = [session("ready", "headless")];

    renderTile();

    expect(screen.getByTestId("headless-browser-tab").dataset.tab).toBe(
      "tab-1",
    );
    expect(screen.queryByTestId("managed-electron-tab")).toBeNull();
  });

  it("opens the headless projection so a dormant tab can activate", () => {
    harness.items = [session("dormant", "dormant")];

    renderTile();

    expect(screen.queryByTestId("managed-electron-tab")).toBeNull();
    expect(screen.getByTestId("headless-browser-tab").dataset.tab).toBe(
      "tab-1",
    );
  });

  it("closes a pointer only after a previously visible tab disappears from live state", async () => {
    harness.binding = binding();
    harness.items = [session("ready", "electron")];
    const view = render(
      <BrowserSessionTile
        node={NODE}
        viewTabId="view-1"
        paneId="pane-1"
        epicId="epic-1"
      />,
    );
    harness.items = [];
    view.rerender(
      <BrowserSessionTile
        node={NODE}
        viewTabId="view-1"
        paneId="pane-1"
        epicId="epic-1"
      />,
    );

    await waitFor(() => {
      expect(harness.closeCanvasTile).toHaveBeenCalledTimes(1);
    });
  });
});
