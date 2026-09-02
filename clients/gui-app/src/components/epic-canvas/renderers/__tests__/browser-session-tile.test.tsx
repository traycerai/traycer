import "../../../../../__tests__/test-browser-apis";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserSessionInfo } from "@traycer/protocol/host/browser/contracts";
import { BrowserSessionTile } from "@/components/epic-canvas/renderers/browser-session-tile";
import type { BrowserPeekCompleteMeaning } from "@/components/epic-canvas/renderers/browser-peek-tile";
import type { ElectronTabBinding } from "@/lib/browser-view/sessions/electron-tabs";
import type { BrowserSessionTileRef } from "@/stores/epics/canvas/types";

const harness = vi.hoisted(() => ({
  binding: null as ElectronTabBinding | null,
  items: [] as BrowserSessionInfo[],
  lifecycle: "live",
  inventoryReady: true,
  // Defaults to the Electron-capable client these cases were written for: a
  // desktop co-located with the tile's host. A viewer-only client sets it
  // false, and then never reaches the native or rebind branches at all.
  canMaterializeElectron: true,
  closeCanvasTile: vi.fn(),
}));

/**
 * Cross-host fence bookkeeping (ticket 13): who each seam was actually
 * called for, so a test can prove the tile bound to the TILE's own
 * `node.hostId` rather than the canvas host.
 */
const hostBindingHarness = vi.hoisted(() => ({
  reachabilityHostIds: [] as string[],
  electronBindingCalls: [] as Array<{
    readonly sessionId: string;
    readonly tabId: string;
    readonly hostId: string;
  }>,
}));

type ReachabilityStatus =
  | "checking"
  | "reachable"
  | "unreachable"
  | "host-starting";

const reachabilityHarness = vi.hoisted(() => ({
  status: "reachable" as ReachabilityStatus,
  hostLabel: "host-test",
}));

const peekFrameHarness = vi.hoisted(() => ({
  frame: null as { readonly src: string; readonly sequence: number } | null,
}));

vi.mock("@/components/epic-canvas/renderers/browser-sessions-context", () => ({
  useBrowserSessionsContext: () => ({
    hostId: "host-test",
    lifecycle: harness.lifecycle,
    inventoryReady: harness.inventoryReady,
    canMaterializeElectron: harness.canMaterializeElectron,
    items: harness.items,
    errorMessage: null,
    retry: vi.fn(),
    openTab: vi.fn(),
    closeTab: vi.fn(),
  }),
}));
vi.mock("@/lib/browser-view/sessions/electron-tabs", () => ({
  useElectronTabBindingOnHost: (
    sessionId: string,
    tabId: string,
    hostId: string,
  ) => {
    hostBindingHarness.electronBindingCalls.push({ sessionId, tabId, hostId });
    return harness.binding;
  },
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
    readonly completeMeans: BrowserPeekCompleteMeaning;
  }) => (
    <button
      type="button"
      aria-label="Browser screencast controls"
      data-testid="headless-browser-tab"
      data-session={props.node.sessionId}
      data-tab={props.node.tabId}
      data-complete-means={props.completeMeans}
    />
  ),
}));
vi.mock("@/lib/browser-view/sessions/peek-frame-cache", () => ({
  useLastBrowserPeekFrame: () => peekFrameHarness.frame,
  clearLastBrowserPeekFrame: vi.fn(),
  browserPeekFrameKey: (node: {
    readonly hostId: string;
    readonly sessionId: string;
    readonly tabId: string;
    readonly instanceId: string;
  }) => `${node.hostId}:${node.sessionId}:${node.tabId}:${node.instanceId}`,
}));
vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: (hostId: string) => {
    hostBindingHarness.reachabilityHostIds.push(hostId);
    return {
      status: reachabilityHarness.status,
      hostLabel: reachabilityHarness.hostLabel,
      unavailability:
        reachabilityHarness.status === "unreachable" ? "offline" : null,
      basis: "directory",
    };
  },
}));

const NODE: BrowserSessionTileRef = {
  id: "browser-session:sess-1:tab-1",
  instanceId: "pointer-instance-1",
  type: "browser-session",
  name: "Browser",
  hostId: "host-test",
  sessionId: "sess-1",
  tabId: "tab-1",
  viewportPreset: "responsive",
};

function session(
  status: "ready" | "dormant" | "navigating" | "crashed",
  runtime: "headless" | "electron" | "dormant",
): BrowserSessionInfo {
  return {
    sessionId: "sess-1",
    epicId: "epic-1",
    hostId: "host-test",
    profile: "primary",
    lastActivityAt: 2,
    runtime: { kind: runtime, revision: 1 },
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
    harness.items = [session("dormant", "dormant")];
    harness.lifecycle = "live";
    harness.inventoryReady = true;
    harness.canMaterializeElectron = true;
    harness.closeCanvasTile.mockClear();
    reachabilityHarness.status = "reachable";
    reachabilityHarness.hostLabel = "host-test";
    peekFrameHarness.frame = null;
    hostBindingHarness.reachabilityHostIds = [];
    hostBindingHarness.electronBindingCalls = [];
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
    // A plain headless viewer: the host's `complete` frame is an ordinary
    // dead cast here, never a native handoff or an unreachable native tab.
    expect(
      screen.getByTestId("headless-browser-tab").dataset.completeMeans,
    ).toBe("ended");
    expect(screen.queryByTestId("managed-electron-tab")).toBeNull();
  });

  it("opens the headless projection so a dormant tab can activate", () => {
    harness.items = [session("dormant", "dormant")];

    renderTile();

    expect(screen.queryByTestId("managed-electron-tab")).toBeNull();
    expect(screen.getByTestId("headless-browser-tab").dataset.tab).toBe(
      "tab-1",
    );
    expect(
      screen.getByTestId("headless-browser-tab").dataset.completeMeans,
    ).toBe("ended");
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

  it("closes a cold-start orphan after the authoritative snapshot arrives", async () => {
    harness.items = [];

    renderTile();

    await waitFor(() => {
      expect(harness.closeCanvasTile).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps a pointer while the authoritative inventory is still loading", () => {
    harness.items = [];
    harness.inventoryReady = false;

    renderTile();

    expect(harness.closeCanvasTile).not.toHaveBeenCalled();
    expect(screen.getByText("Loading browser session…")).toBeTruthy();
    expect(
      screen.queryByText("Browser tab is no longer available."),
    ).toBeNull();
  });

  it("does not start a headless projection while an Electron binding is reconnecting", () => {
    harness.items = [session("ready", "electron")];

    renderTile();

    expect(screen.getByText("Reconnecting browser tab…")).toBeTruthy();
    expect(screen.queryByTestId("headless-browser-tab")).toBeNull();
  });

  it("takes the viewer branch for a non-capable client on a ready electron session, never the rebind alert", () => {
    // A viewer-only client (no co-located browserView, or a browserView bound
    // to a different host than the session's) can never place a native tab
    // for this session. `kind === "electron"` + `binding === null` alone would
    // fall into `BrowserTabRebindWait`, which waits on a desktop-side
    // re-publish that structurally cannot come for this client.
    harness.canMaterializeElectron = false;
    harness.items = [session("ready", "electron")];

    renderTile();

    expect(screen.getByTestId("headless-browser-tab").dataset.tab).toBe(
      "tab-1",
    );
    // The non-capable client's own view of the same `complete` frame: this
    // tab is live in the desktop's window on that host, unreachable from
    // here - never the "my own tab is arriving" handoff spinner.
    expect(
      screen.getByTestId("headless-browser-tab").dataset.completeMeans,
    ).toBe("native-elsewhere");
    expect(screen.queryByText("Reconnecting browser tab…")).toBeNull();
    expect(screen.queryByTestId("browser-tab-rebind-timeout")).toBeNull();
    expect(screen.queryByTestId("managed-electron-tab")).toBeNull();
  });

  it("takes the viewer branch for a non-capable client even once the reconnect wait would have expired", () => {
    // Same non-capable client, but proving the bounded-wait/rebind-timeout
    // machinery never engages at all for it - not merely that it starts in the
    // viewer branch. An electron-capable client (default harness) reaches the
    // timeout alert at this point (see "bounds the reconnect wait..." above);
    // this client must not.
    vi.useFakeTimers();
    try {
      harness.canMaterializeElectron = false;
      harness.items = [session("ready", "electron")];

      renderTile();

      act(() => {
        vi.advanceTimersByTime(10_000);
      });

      expect(screen.getByTestId("headless-browser-tab").dataset.tab).toBe(
        "tab-1",
      );
      expect(
        screen.getByTestId("headless-browser-tab").dataset.completeMeans,
      ).toBe("native-elsewhere");
      expect(screen.queryByTestId("browser-tab-rebind-timeout")).toBeNull();
      expect(screen.queryByText("Reconnecting browser tab…")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the electron-capable default meaningful: the same session still reaches the reconnect wait and rebind alert", () => {
    // Pins that the harness's `canMaterializeElectron: true` default (used by
    // every other case in this suite) is not accidentally masking the branch
    // this file exists to cover - the capable path still resolves to the
    // native-binding-reconnect machinery, not the viewer branch.
    harness.items = [session("ready", "electron")];

    renderTile();

    expect(screen.getByText("Reconnecting browser tab…")).toBeTruthy();
    expect(screen.queryByTestId("headless-browser-tab")).toBeNull();
  });

  it("takes the wake path for a dormant tab of an Electron session", () => {
    // `materialize` provisions only the tab it was asked for, so a live
    // Electron session routinely publishes dormant siblings. A sibling that
    // fell into the bare null-binding branch had no way back: the reconnect
    // spinner subscribes to nothing, and the screencast subscription behind
    // the peek tile is the only thing that reaches `ensureTabAttached`.
    harness.items = [session("dormant", "electron")];

    renderTile();

    expect(
      screen.getByRole("button", { name: "Browser screencast controls" })
        .dataset.tab,
    ).toBe("tab-1");
    // The capable client's own wake/peek path: the desktop is about to
    // publish a native binding for this tab, so the frame reads as a
    // handoff in progress, not an unreachable native tab.
    expect(
      screen.getByRole("button", { name: "Browser screencast controls" })
        .dataset.completeMeans,
    ).toBe("native-handoff");
    expect(
      screen.queryByRole("status", { name: "Reconnecting browser tab" }),
    ).toBeNull();
  });

  it("prefers an accepted binding over the wake path even while the tab still reads dormant", () => {
    // The renderer publishes the binding before the host's `electronTabState`
    // lands, so this window is ordinary. Native pixels win it.
    harness.binding = binding();
    harness.items = [session("dormant", "electron")];

    renderTile();

    expect(screen.getByTestId("managed-electron-tab")).toBeTruthy();
    expect(screen.queryByTestId("headless-browser-tab")).toBeNull();
  });

  it("bounds the reconnect wait and offers the wake path once it expires", () => {
    vi.useFakeTimers();
    try {
      harness.items = [session("ready", "electron")];

      renderTile();

      expect(screen.getByText("Reconnecting browser tab…")).toBeTruthy();
      expect(screen.queryByTestId("browser-tab-rebind-timeout")).toBeNull();

      act(() => {
        vi.advanceTimersByTime(10_000);
      });

      expect(screen.queryByText("Reconnecting browser tab…")).toBeNull();
      const timedOut = screen.getByTestId("browser-tab-rebind-timeout");
      expect(timedOut.getAttribute("role")).toBe("alert");

      fireEvent.click(screen.getByRole("button", { name: "Reopen tab" }));

      expect(screen.getByTestId("headless-browser-tab").dataset.tab).toBe(
        "tab-1",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns to the actionable error state once the bounded wake window itself expires with no binding", () => {
    // The wake request is bounded, not latched: a reader who clicked "Reopen
    // tab" and never got a binding back must land on the same actionable
    // error state the original reconnect wait offers, not spin on the peek
    // tile forever.
    vi.useFakeTimers();
    try {
      harness.items = [session("ready", "electron")];

      renderTile();

      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      fireEvent.click(screen.getByRole("button", { name: "Reopen tab" }));
      expect(screen.getByTestId("headless-browser-tab")).toBeTruthy();

      // The bounded wake window's own deadline, still with no binding.
      act(() => {
        vi.advanceTimersByTime(10_000);
      });

      expect(screen.queryByTestId("headless-browser-tab")).toBeNull();
      // Falls straight to the error state - no intervening reconnect spinner.
      expect(screen.queryByText("Reconnecting browser tab…")).toBeNull();
      const timedOut = screen.getByTestId("browser-tab-rebind-timeout");
      expect(timedOut.getAttribute("role")).toBe("alert");
      expect(screen.getByRole("button", { name: "Reopen tab" })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a binding arrive mid-wake-window, then falls back to the actionable alert (not a phantom headless tab) once a stale wake request has naturally expired", () => {
    vi.useFakeTimers();
    try {
      harness.items = [session("ready", "electron")];

      const view = render(
        <BrowserSessionTile
          node={NODE}
          viewTabId="view-1"
          paneId="pane-1"
          epicId="epic-1"
        />,
      );

      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      fireEvent.click(screen.getByRole("button", { name: "Reopen tab" }));
      expect(screen.getByTestId("headless-browser-tab")).toBeTruthy();

      // A binding arrives before the wake window expires - native pixels win.
      harness.binding = binding();
      view.rerender(
        <BrowserSessionTile
          node={NODE}
          viewTabId="view-1"
          paneId="pane-1"
          epicId="epic-1"
        />,
      );
      expect(screen.getByTestId("managed-electron-tab")).toBeTruthy();

      // A later, transient reconnect: the binding drops again well after the
      // original wake window would have elapsed. The stale request is inert
      // by then, so this lands on the same actionable alert a fresh expiry
      // produces - never stuck spinning, and never a phantom headless tab.
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      harness.binding = null;
      view.rerender(
        <BrowserSessionTile
          node={NODE}
          viewTabId="view-1"
          paneId="pane-1"
          epicId="epic-1"
        />,
      );

      expect(screen.queryByText("Reconnecting browser tab…")).toBeNull();
      expect(screen.queryByTestId("headless-browser-tab")).toBeNull();
      const timedOut = screen.getByTestId("browser-tab-rebind-timeout");
      expect(timedOut.getAttribute("role")).toBe("alert");
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders a dormant placeholder for an unreachable host and never closes the tile", async () => {
    harness.items = [session("ready", "headless")];
    reachabilityHarness.status = "unreachable";
    reachabilityHarness.hostLabel = "mac-mini";

    renderTile();

    expect(
      screen.getByTestId("browser-session-dormant-placeholder"),
    ).toBeTruthy();
    expect(screen.getByText("mac-mini")).toBeTruthy();
    expect(screen.queryByTestId("headless-browser-tab")).toBeNull();
    // Give any stray effect a tick to fire before asserting the negative.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.closeCanvasTile).not.toHaveBeenCalled();
  });

  it("re-renders live once reachability recovers", () => {
    harness.items = [session("ready", "headless")];
    reachabilityHarness.status = "unreachable";
    const view = render(
      <BrowserSessionTile
        node={NODE}
        viewTabId="view-1"
        paneId="pane-1"
        epicId="epic-1"
      />,
    );

    expect(
      screen.getByTestId("browser-session-dormant-placeholder"),
    ).toBeTruthy();

    reachabilityHarness.status = "reachable";
    view.rerender(
      <BrowserSessionTile
        node={NODE}
        viewTabId="view-1"
        paneId="pane-1"
        epicId="epic-1"
      />,
    );

    expect(
      screen.queryByTestId("browser-session-dormant-placeholder"),
    ).toBeNull();
    expect(screen.getByTestId("headless-browser-tab").dataset.tab).toBe(
      "tab-1",
    );
  });

  it("shows a dismissible runtime-demotion note when a session flips electron to headless", () => {
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
    expect(screen.queryByTestId("browser-runtime-demotion-note")).toBeNull();

    harness.items = [
      {
        ...session("ready", "headless"),
        runtime: { kind: "headless", revision: 2 },
      },
    ];
    view.rerender(
      <BrowserSessionTile
        node={NODE}
        viewTabId="view-1"
        paneId="pane-1"
        epicId="epic-1"
      />,
    );

    const note = screen.getByTestId("browser-runtime-demotion-note");
    expect(note.textContent).toContain("Continuing streamed from host-test");

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("browser-runtime-demotion-note")).toBeNull();
  });

  it("keeps the placeholder's greyed frame stable across a re-render even if the cache changes underneath it", () => {
    harness.items = [session("ready", "headless")];
    reachabilityHarness.status = "unreachable";
    peekFrameHarness.frame = {
      src: "data:image/jpeg;base64,seed",
      sequence: 1,
    };

    const view = render(
      <BrowserSessionTile
        node={NODE}
        viewTabId="view-1"
        paneId="pane-1"
        epicId="epic-1"
      />,
    );

    const img = screen
      .getByTestId("browser-session-dormant-placeholder")
      .querySelector("img");
    expect(img?.getAttribute("src")).toBe("data:image/jpeg;base64,seed");

    // The peek tile's own cache can change (or empty out) underneath an
    // already-mounted placeholder - it must not re-read it.
    peekFrameHarness.frame = null;
    view.rerender(
      <BrowserSessionTile
        node={NODE}
        viewTabId="view-1"
        paneId="pane-1"
        epicId="epic-1"
      />,
    );

    const imgAfter = screen
      .getByTestId("browser-session-dormant-placeholder")
      .querySelector("img");
    expect(imgAfter?.getAttribute("src")).toBe("data:image/jpeg;base64,seed");
  });

  it("clears the runtime-demotion note once the session is re-promoted back to electron", () => {
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

    harness.items = [
      {
        ...session("ready", "headless"),
        runtime: { kind: "headless", revision: 2 },
      },
    ];
    view.rerender(
      <BrowserSessionTile
        node={NODE}
        viewTabId="view-1"
        paneId="pane-1"
        epicId="epic-1"
      />,
    );
    expect(screen.getByTestId("browser-runtime-demotion-note")).toBeTruthy();

    harness.binding = binding();
    harness.items = [
      {
        ...session("ready", "electron"),
        runtime: { kind: "electron", revision: 3 },
      },
    ];
    view.rerender(
      <BrowserSessionTile
        node={NODE}
        viewTabId="view-1"
        paneId="pane-1"
        epicId="epic-1"
      />,
    );

    expect(screen.queryByTestId("browser-runtime-demotion-note")).toBeNull();
  });

  it("binds the boundary, reachability, and the electron binding lookup to the tile's OWN hostId, not the canvas host", () => {
    // The canvas host (`useCanvasHostId`, mocked above) is always
    // "host-test". This node names a different host - the first case in
    // this suite where a browser tile's hostId diverges from the canvas
    // it's rendered on. Every per-host seam the tile touches must key off
    // `node.hostId`, never the canvas host it happens to be pinned inside.
    const remoteNode: BrowserSessionTileRef = {
      ...NODE,
      hostId: "host-remote",
    };
    harness.items = [
      { ...session("ready", "headless"), hostId: "host-remote" },
    ];

    render(
      <BrowserSessionTile
        node={remoteNode}
        viewTabId="view-1"
        paneId="pane-1"
        epicId="epic-1"
      />,
    );

    expect(screen.getByTestId("headless-browser-tab").dataset.tab).toBe(
      "tab-1",
    );
    expect(hostBindingHarness.reachabilityHostIds).toContain("host-remote");
    expect(hostBindingHarness.reachabilityHostIds).not.toContain("host-test");
    expect(hostBindingHarness.electronBindingCalls).toContainEqual({
      sessionId: "sess-1",
      tabId: "tab-1",
      hostId: "host-remote",
    });
  });
});
