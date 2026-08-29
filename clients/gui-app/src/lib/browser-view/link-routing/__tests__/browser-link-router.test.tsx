import "../../../../../__tests__/test-browser-apis";
import type { ReactNode } from "react";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { useBrowserLinkRouterForRunnerHost } from "@/lib/browser-view/link-routing/browser-link-router";
import { BrowserLinkRoutingContext } from "@/lib/browser-view/link-routing/browser-link-routing-context";
import type { BrowserLinkSource } from "@/lib/browser-view/link-routing/browser-link-routing-core";
import type { BrowserTabIdentity } from "@traycer/protocol/host/browser/contracts";
import type { BrowserSessionsState } from "@/components/epic-canvas/renderers/browser-sessions-context";
import { createSingleTileCanvas } from "@/stores/epics/canvas/actions";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";
import { useSettingsStore } from "@/stores/settings/settings-store";

const VIEW_TAB_ID = "view-tab-router";
const HOST_ID = "host-router";

const viewportState = vi.hoisted(() => ({ mobile: false }));
const sessionsState = vi.hoisted<{ value: BrowserSessionsState | null }>(
  () => ({
    value: null,
  }),
);
let routingSource: BrowserLinkSource | null = null;

vi.mock("@/hooks/ui/use-mobile-viewport", () => ({
  useIsMobileViewport: () => viewportState.mobile,
  isMobileViewport: () => viewportState.mobile,
}));

vi.mock("@/components/epic-canvas/renderers/browser-sessions-context", () => ({
  useMaybeBrowserSessionsContext: () => sessionsState.value,
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const SOURCE_TILE: EpicCanvasTileRef = {
  id: "ticket-router",
  instanceId: "ticket-router-instance",
  type: "ticket",
  name: "Ticket",
  hostId: HOST_ID,
};

function seedCanvas(): void {
  const canvas = createSingleTileCanvas(SOURCE_TILE);
  const pane = collectPanes(canvas.root).at(0);
  if (pane === undefined) throw new Error("expected a pane");
  useEpicCanvasStore.setState({
    tabsById: {
      [VIEW_TAB_ID]: { tabId: VIEW_TAB_ID, epicId: "epic-router", name: "R" },
    },
    canvasByTabId: { [VIEW_TAB_ID]: canvas },
  });
  routingSource = { viewTabId: VIEW_TAB_ID, paneId: pane.id, hostId: HOST_ID };
}

function wrapper(props: { readonly children: ReactNode }): ReactNode {
  return (
    <BrowserLinkRoutingContext
      value={routingSource === null ? null : { source: routingSource }}
    >
      {props.children}
    </BrowserLinkRoutingContext>
  );
}

function renderRouter(runnerHost: {
  readonly openExternalLink: (url: string) => Promise<void>;
}) {
  return renderHook(() => useBrowserLinkRouterForRunnerHost(runnerHost), {
    wrapper,
  });
}

function liveSessions(
  openTab: BrowserSessionsState["openTab"],
): BrowserSessionsState {
  return {
    hostId: HOST_ID,
    lifecycle: "live",
    inventoryReady: true,
    items: [],
    errorMessage: null,
    retry: vi.fn(),
    openTab,
    closeTab: () => Promise.resolve(),
  };
}

function paneCount(): number {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID];
  if (canvas === undefined) return 0;
  return collectPanes(canvas.root).length;
}

describe("useBrowserLinkRouterForRunnerHost", () => {
  beforeEach(() => {
    useEpicCanvasStore.setState({ canvasByTabId: {}, tabsById: {} });
    useSettingsStore.setState({
      browserLinkDefaultMode: "in-app",
      terminalBrowserLinkOpenMode: "in-app",
      markdownBrowserLinkOpenMode: "in-app",
      browserDevOrigins: [],
    });
    viewportState.mobile = false;
    seedCanvas();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("falls back when the tab opens but has nowhere to land", async () => {
    const runnerHost = { openExternalLink: vi.fn(() => Promise.resolve()) };
    // The pane has to be gone BEFORE the open resolves, or the assertion is
    // racing the microtask queue. Tearing it down inside the `openTab` stub
    // gets that ordering from the call sequence itself: the router calls this
    // synchronously, so the canvas is empty by the time the `.then()` runs.
    sessionsState.value = liveSessions((): Promise<BrowserTabIdentity> => {
      useEpicCanvasStore.setState({ canvasByTabId: {}, tabsById: {} });
      return Promise.resolve({ sessionId: "sess-1", tabId: "tab-1" });
    });
    const { result } = renderRouter(runnerHost);

    // The host reports success - a FULFILLED promise - but the tile has
    // nowhere to land, so placement returns false. The link is as lost as it
    // is on a rejection, and takes the same fallback.
    result.current("markdown", "https://example.test/docs", null);

    await waitFor(() => {
      expect(runnerHost.openExternalLink).toHaveBeenCalledWith(
        "https://example.test/docs",
      );
    });
  });

  it("sends the link outside Traycer when the in-app open is refused", async () => {
    const runnerHost = { openExternalLink: vi.fn(() => Promise.resolve()) };
    sessionsState.value = liveSessions(() =>
      Promise.reject(new Error("no runtime")),
    );
    const { result } = renderRouter(runnerHost);

    expect(result.current("markdown", "https://example.test/docs", null)).toBe(
      "in-app",
    );

    // The click is answered before the host round trip settles, so the only
    // honest recovery from a refusal is to open the link where it would have
    // gone had the session never been live.
    await waitFor(() => {
      expect(runnerHost.openExternalLink).toHaveBeenCalledWith(
        "https://example.test/docs",
      );
    });
  });

  it("does not claim the link landed when the fallback fails too", async () => {
    const runnerHost = {
      openExternalLink: vi.fn(() => Promise.reject(new Error("no handler"))),
    };
    sessionsState.value = liveSessions(() =>
      Promise.reject(new Error("no runtime")),
    );
    const { result } = renderRouter(runnerHost);

    result.current("markdown", "https://example.test/docs", null);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Couldn't open this link.");
    });
    expect(toast.error).not.toHaveBeenCalledWith(
      "Couldn't open the browser tab. Opened it outside Traycer instead.",
    );
  });

  it("leaves a successful open alone", async () => {
    const runnerHost = { openExternalLink: vi.fn(() => Promise.resolve()) };
    sessionsState.value = liveSessions(() =>
      Promise.resolve({ sessionId: "sess-1", tabId: "tab-1" }),
    );
    const { result } = renderRouter(runnerHost);

    result.current("markdown", "https://example.test/docs", null);

    await waitFor(() => {
      expect(paneCount()).toBe(2);
    });
    expect(runnerHost.openExternalLink).not.toHaveBeenCalled();
  });

  it("takes over the pane instead of splitting it on a one-tile viewport", async () => {
    viewportState.mobile = true;
    const runnerHost = { openExternalLink: vi.fn(() => Promise.resolve()) };
    sessionsState.value = liveSessions(() =>
      Promise.resolve({ sessionId: "sess-1", tabId: "tab-1" }),
    );
    const { result } = renderRouter(runnerHost);

    result.current("markdown", "https://example.test/docs", null);

    await waitFor(() => {
      const canvas = useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID];
      expect(Object.keys(canvas?.tilesByInstanceId ?? {})).toHaveLength(2);
    });
    expect(paneCount()).toBe(1);
  });

  it("still refuses synchronously when no session is live", () => {
    const runnerHost = { openExternalLink: vi.fn(() => Promise.resolve()) };
    sessionsState.value = null;
    const { result } = renderRouter(runnerHost);

    expect(result.current("markdown", "https://example.test/docs", null)).toBe(
      "external",
    );
    expect(runnerHost.openExternalLink).toHaveBeenCalledWith(
      "https://example.test/docs",
    );
  });
});
