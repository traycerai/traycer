import "../../../../../__tests__/test-browser-apis";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { BrowserSessionsState } from "@/lib/browser-view/sessions/browser-sessions-coordinator";
import { renderTile } from "@/components/epic-canvas/renderers/tile-render";
import { useOpenLink } from "@/lib/links/open-link";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";

const CANVAS_HOST_ID = "host-canvas";
const TILE_HOST_ID = "host-remote";
const EPIC_ID = "epic-1";

/**
 * The two-host fence: which hosts the sessions machinery was acquired for, and
 * which host's stream an `openTab` actually went out on. A tile on a remote
 * host must reach ITS host, never the canvas host's stream.
 */
const sessionsHarness = vi.hoisted(() => ({
  acquiredHostIds: [] as string[],
  openTabCalls: [] as Array<{ readonly hostId: string; readonly url: string }>,
}));

vi.mock(
  "@/lib/browser-view/sessions/browser-sessions-coordinator",
  async () => {
    const actual = await vi.importActual<
      typeof import("@/lib/browser-view/sessions/browser-sessions-coordinator")
    >("@/lib/browser-view/sessions/browser-sessions-coordinator");
    const states = new Map<string, BrowserSessionsState>();
    const listeners = new Map<string, Set<() => void>>();
    const notify = (key: string): void => {
      listeners.get(key)?.forEach((listener) => listener());
    };
    return {
      ...actual,
      hasBrowserSessionsCoordinator: (key: string) => states.has(key),
      browserSessionsCoordinatorState: (key: string | null) =>
        key === null ? null : (states.get(key) ?? null),
      upsertBrowserSessionsCoordinatorConsumer: () => undefined,
      subscribeToBrowserSessionsCoordinator: (
        key: string | null,
        listener: () => void,
      ) => {
        if (key === null) return () => undefined;
        const existing = listeners.get(key) ?? new Set<() => void>();
        existing.add(listener);
        listeners.set(key, existing);
        return () => {
          existing.delete(listener);
        };
      },
      acquireBrowserSessionsCoordinator: (args: {
        readonly key: string;
        readonly owner: { readonly hostId: string };
      }) => {
        sessionsHarness.acquiredHostIds.push(args.owner.hostId);
        states.set(args.key, liveSessionsState(args.owner.hostId));
        notify(args.key);
        return () => {
          states.delete(args.key);
          notify(args.key);
        };
      },
    };
  },
);

vi.mock("@/components/epic-canvas/hooks/use-canvas-host-id", () => ({
  useCanvasHostId: () => CANVAS_HOST_ID,
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) =>
    hostId === null ? null : { hostId },
}));
vi.mock("@/hooks/epic/use-epic-session-host-client", () => ({
  useEpicSessionHostClient: () => null,
}));
vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => null,
}));
vi.mock("@/hooks/host/use-host-stream-client-for", () => ({
  authenticatedHostStreamKey: () => "stream-key",
  authenticatedOwnerIdentityKey: () => "owner-key",
}));
vi.mock("@/lib/host/use-durable-stream-transport", () => ({
  useDurableStreamTransportFactory: () => () => {
    throw new Error("transport is not opened in this test");
  },
}));
vi.mock("@/hooks/host/use-reactive-local-host-id", () => ({
  useReactiveLocalHostId: () => CANVAS_HOST_ID,
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ browserView: null }),
}));

vi.mock("@/components/epic-canvas/tile-find/tile-find-scope", () => ({
  TileFindScope: (props: { readonly children: ReactNode }) => props.children,
}));
vi.mock("@/components/epic-canvas/tile-minimap/tile-minimap-scope", () => ({
  TileMinimapScope: (props: { readonly children: ReactNode }) => props.children,
}));
vi.mock("@/components/epic-canvas/renderers/ticket-tile", () => ({
  TicketTile: () => <LinkClickProbe />,
}));

function liveSessionsState(hostId: string): BrowserSessionsState {
  return {
    hostId,
    lifecycle: "live",
    inventoryReady: true,
    items: [],
    errorMessage: null,
    retry: () => undefined,
    openTab: (_sessionId, url) => {
      sessionsHarness.openTabCalls.push({ hostId, url });
      return Promise.resolve({ sessionId: "sess-1", tabId: "tab-1" });
    },
    closeTab: () => Promise.resolve(),
  };
}

/**
 * Stands in for any in-tile link surface (Markdown anchors, terminal OSC-8
 * links): it only reads the shared router, with no host knowledge of its own.
 */
function LinkClickProbe() {
  const openLink = useOpenLink();
  return (
    <button
      type="button"
      data-testid="tile-link"
      onClick={() => openLink("https://example.test/docs", "markdown", null)}
    >
      link
    </button>
  );
}

function tileNode(hostId: string): EpicCanvasTileRef {
  return {
    id: "ticket-1",
    instanceId: "ticket-1-instance",
    type: "ticket",
    name: "Ticket",
    hostId,
  };
}

describe("renderTile browser sessions host boundary", () => {
  beforeEach(() => {
    sessionsHarness.acquiredHostIds = [];
    sessionsHarness.openTabCalls = [];
    useEpicCanvasStore.setState({ canvasByTabId: {}, tabsById: {} });
    useSettingsStore.setState({
      linkOpen: {
        default: "in-app",
        markdown: "in-app",
        terminal: "in-app",
        github: "in-app",
        image: "in-app",
      },
      browserDevOrigins: [],
    });
  });

  afterEach(cleanup);

  it("routes a remote-host tile's first link click to that tile's host", () => {
    render(
      renderTile({
        node: tileNode(TILE_HOST_ID),
        viewTabId: "view-1",
        tileId: "pane-1",
        epicId: EPIC_ID,
        isActive: true,
      }),
    );

    fireEvent.click(screen.getByTestId("tile-link"));

    expect(sessionsHarness.acquiredHostIds).toEqual([TILE_HOST_ID]);
    expect(sessionsHarness.openTabCalls).toEqual([
      { hostId: TILE_HOST_ID, url: "https://example.test/docs" },
    ]);
  });

  it("keeps a canvas-host tile on the ambient stream", () => {
    render(
      renderTile({
        node: tileNode(CANVAS_HOST_ID),
        viewTabId: "view-1",
        tileId: "pane-1",
        epicId: EPIC_ID,
        isActive: true,
      }),
    );

    expect(screen.getByTestId("tile-link")).toBeTruthy();

    // No boundary is mounted for the canvas host: the ambient provider above
    // the canvas already owns that stream, and a second one would be a second
    // socket for the same host.
    expect(sessionsHarness.acquiredHostIds).toEqual([]);
  });
});
