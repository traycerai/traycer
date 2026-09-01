import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { BrowserSessionInfo } from "@traycer/protocol/host/browser/contracts";
import { TabSurfaceActivityProvider } from "@/components/layout/tab-surface-activity";
import type { BrowserSessionsState } from "@/components/epic-canvas/renderers/browser-sessions-context";
import {
  epicTabRightActionsKey,
  useMobileHeaderStore,
} from "@/stores/layout/mobile-header-store";

/**
 * Controllable open-epic handle: desktop EpicSessionProvider intentionally
 * supplies null during ownership/session acquisition (Ticket-08 cold path).
 */
const openEpicHandleState = vi.hoisted(() => ({
  handle: null as { readonly epicId: string } | null,
}));

const chatRecordsState = vi.hoisted(() => ({
  chats: [{ id: "chat-z" }, { id: "chat-a" }] as ReadonlyArray<{
    readonly id: string;
  }>,
}));

const readySessionsState = vi.hoisted(() => ({
  items: [] as BrowserSessionInfo[],
}));

const pipMountState = vi.hoisted(() => ({
  mounts: 0,
  unmounts: 0,
  nextId: 1,
}));

// No epic route match anywhere in this suite: that is the phone cold-restore
// state, where the layout has restored the tab but the router is still on the
// landing route it booted at.
vi.mock("@tanstack/react-router", () => ({
  useMatch: () => undefined,
}));

vi.mock("@/providers/use-open-epic-handle", () => ({
  useMaybeOpenEpicHandle: () => openEpicHandleState.handle,
  useOpenEpicHandle: () => {
    if (openEpicHandleState.handle === null) {
      throw new Error(
        "useOpenEpicHandle requires a non-null open epic handle.",
      );
    }
    return openEpicHandleState.handle;
  },
}));

vi.mock("@/lib/epic-selectors", () => ({
  useEpicChatRecords: () => chatRecordsState.chats,
}));

const viewport = vi.hoisted(() => ({ mobile: false }));
vi.mock("@/hooks/ui/use-mobile-viewport", () => ({
  useIsMobileViewport: () => viewport.mobile,
}));

vi.mock("@/providers/epic-session-provider", () => ({
  EpicSessionProvider: (props: {
    readonly children: ReactNode;
    readonly epicId: string;
    readonly tabId: string;
  }) => (
    <div
      data-epic-id={props.epicId}
      data-tab-id={props.tabId}
      data-testid="epic-session-boundary"
    >
      {props.children}
    </div>
  ),
}));

/**
 * BrowserSessionsProvider stand-in: publishes the same cold/live transition as
 * the real continuously mounted provider without pulling in the host stream.
 */
vi.mock(
  "@/components/epic-canvas/renderers/browser-sessions-provider",
  async () => {
    const { BrowserSessionsContext } =
      await import("@/components/epic-canvas/renderers/browser-sessions-context");
    return {
      BrowserSessionsProvider: (props: {
        readonly epicId: string;
        readonly children: ReactNode;
      }) => {
        const ready = openEpicHandleState.handle !== null;
        const value: BrowserSessionsState = {
          hostId: "host-test",
          lifecycle: ready ? "live" : "connecting",
          inventoryReady: ready,
          items: ready ? readySessionsState.items : [],
          errorMessage: null,
          retry: () => undefined,
          openTab: () => Promise.reject(new Error("not used")),
          closeTab: () => Promise.resolve(),
        };
        return (
          <BrowserSessionsContext.Provider value={value}>
            <div
              data-epic-id={props.epicId}
              data-testid="browser-sessions-provider"
            />
            {props.children}
          </BrowserSessionsContext.Provider>
        );
      },
    };
  },
);

vi.mock("@/components/epic-canvas/epic-route-session-body", () => ({
  EpicRouteSessionBody: (props: { readonly tabId: string }) => (
    <div data-testid={`epic-canvas-body-${props.tabId}`} />
  ),
}));

vi.mock("@/components/epic-canvas/pip/agent-browser-pip", async () => {
  const { useEffect, useState } = await import("react");
  return {
    AgentBrowserPip: (props: {
      readonly epicId: string;
      readonly viewTabId: string;
      readonly surfaceVisible: boolean;
    }) => {
      const [mountId] = useState(() => {
        const id = pipMountState.nextId;
        pipMountState.nextId += 1;
        pipMountState.mounts += 1;
        return id;
      });
      useEffect(() => {
        return () => {
          pipMountState.unmounts += 1;
        };
      }, []);
      return (
        <div
          data-epic-id={props.epicId}
          data-mount-id={String(mountId)}
          data-surface-visible={String(props.surfaceVisible)}
          data-testid="agent-browser-pip"
          data-view-tab-id={props.viewTabId}
        />
      );
    },
  };
});

/** Probe consumer under EpicBrowserSessionsScope (real cold/ready context). */
vi.mock("@/components/epic-canvas/sidebar/epic-sidebar-column", async () => {
  const { useBrowserSessionsContext } =
    await import("@/components/epic-canvas/renderers/browser-sessions-context");
  return {
    EpicSidebarColumn: (props: {
      readonly epicId: string;
      readonly tabId: string;
    }) => {
      const sessions = useBrowserSessionsContext();
      return (
        <aside
          data-epic-id={props.epicId}
          data-tab-id={props.tabId}
          data-testid="epic-sidebar-column"
        >
          <span data-testid={`browser-session-count-${props.tabId}`}>
            {sessions.items.length}
          </span>
          <span data-testid={`browser-session-lifecycle-${props.tabId}`}>
            {sessions.lifecycle}
          </span>
        </aside>
      );
    },
  };
});

import { EpicSurface } from "@/components/epic-tabs/epic-surface";

const SAMPLE_SESSION: BrowserSessionInfo = {
  sessionId: "sess-1",
  epicId: "epic-a",
  hostId: "host-test",
  profile: "primary",
  lastActivityAt: 2,
  runtime: { kind: "electron", revision: 0 },
  tabs: [],
};

function renderEpicSurface(tabId: string, epicId: string) {
  return render(
    <TabSurfaceActivityProvider activity={{ visible: true, focused: true }}>
      <EpicSurface epicId={epicId} tabId={tabId} />
    </TabSurfaceActivityProvider>,
  );
}

describe("<EpicSurface />", () => {
  beforeEach(() => {
    openEpicHandleState.handle = null;
    readySessionsState.items = [];
    chatRecordsState.chats = [{ id: "chat-z" }, { id: "chat-a" }];
    pipMountState.mounts = 0;
    pipMountState.unmounts = 0;
    pipMountState.nextId = 1;
  });

  afterEach(() => {
    cleanup();
    openEpicHandleState.handle = null;
    readySessionsState.items = [];
    viewport.mobile = false;
    useMobileHeaderStore.setState({ rightActionEntries: new Map() });
  });

  it("keeps two split Epic panes under independent session and sidebar boundaries", () => {
    render(
      <>
        <TabSurfaceActivityProvider activity={{ visible: true, focused: true }}>
          <EpicSurface epicId="epic-a" tabId="tab-a" />
        </TabSurfaceActivityProvider>
        <TabSurfaceActivityProvider
          activity={{ visible: true, focused: false }}
        >
          <EpicSurface epicId="epic-b" tabId="tab-b" />
        </TabSurfaceActivityProvider>
      </>,
    );

    const sessions = screen.getAllByTestId("epic-session-boundary");
    const sidebars = screen.getAllByTestId("epic-sidebar-column");
    expect(sessions.map((element) => element.dataset.tabId)).toEqual([
      "tab-a",
      "tab-b",
    ]);
    expect(sidebars.map((element) => element.dataset.epicId)).toEqual([
      "epic-a",
      "epic-b",
    ]);
    expect(screen.getByTestId("epic-canvas-body-tab-a")).not.toBeNull();
    expect(screen.getByTestId("epic-canvas-body-tab-b")).not.toBeNull();
  });

  it("cold-starts browser sessions with a null open-epic handle, then mounts the ready provider when the handle resolves", () => {
    const { rerender } = renderEpicSurface("tab-a", "epic-a");

    // (1) Initial null handle: the real provider remains mounted but has no
    // owner yet, so its one context reports connecting with empty inventory.
    expect(screen.getByTestId("browser-sessions-provider")).not.toBeNull();
    expect(screen.getByTestId("browser-session-count-tab-a").textContent).toBe(
      "0",
    );
    expect(
      screen.getByTestId("browser-session-lifecycle-tab-a").textContent,
    ).toBe("connecting");

    // (2) Handle resolves: the same provider publishes its ready inventory.
    readySessionsState.items = [SAMPLE_SESSION];
    openEpicHandleState.handle = { epicId: "epic-a" };

    act(() => {
      rerender(
        <TabSurfaceActivityProvider activity={{ visible: true, focused: true }}>
          <EpicSurface epicId="epic-a" tabId="tab-a" />
        </TabSurfaceActivityProvider>,
      );
    });

    const provider = screen.getByTestId("browser-sessions-provider");
    expect(provider).not.toBeNull();
    expect(provider.dataset.epicId).toBe("epic-a");
    expect(screen.getByTestId("browser-session-count-tab-a").textContent).toBe(
      "1",
    );
    expect(
      screen.getByTestId("browser-session-lifecycle-tab-a").textContent,
    ).toBe("live");
  });

  it("keeps the same AgentBrowserPip instance across the null open-epic handle to ready handle transition", () => {
    const { rerender } = renderEpicSurface("tab-a", "epic-a");

    const pip = screen.getByTestId("agent-browser-pip");
    const mountId = pip.dataset.mountId;
    expect(mountId).toEqual("1");
    expect(pipMountState.mounts).toBe(1);
    expect(pipMountState.unmounts).toBe(0);

    readySessionsState.items = [SAMPLE_SESSION];
    openEpicHandleState.handle = { epicId: "epic-a" };

    act(() => {
      rerender(
        <TabSurfaceActivityProvider activity={{ visible: true, focused: true }}>
          <EpicSurface epicId="epic-a" tabId="tab-a" />
        </TabSurfaceActivityProvider>,
      );
    });

    const pipAfterReady = screen.getByTestId("agent-browser-pip");
    expect(pipAfterReady.dataset.mountId).toBe(mountId);
    expect(pipMountState.mounts).toBe(1);
    expect(pipMountState.unmounts).toBe(0);
  });

  // Tab focus, not the route: the switcher trigger has to reach the header on a
  // cold restore, when no epic route match exists yet.
  it("registers the mobile header entry from the focused pane", () => {
    viewport.mobile = true;
    render(
      <TabSurfaceActivityProvider activity={{ visible: true, focused: true }}>
        <EpicSurface epicId="epic-a" tabId="tab-a" />
      </TabSurfaceActivityProvider>,
    );

    render(
      <>
        {useMobileHeaderStore
          .getState()
          .rightActionEntries.get(epicTabRightActionsKey("tab-a"))}
      </>,
    );
    expect(screen.getByRole("button", { name: "Switch tab" })).not.toBeNull();
  });

  // A retained-but-unfocused pane registers too: a focus switch onto an
  // already-retained tab must resolve its trigger in that same commit, so the
  // entry has to exist BEFORE the focus flip. Keeping it off the header while
  // unfocused is resolution's job, not the writer's.
  it("registers its entry from a retained unfocused pane", () => {
    viewport.mobile = true;
    render(
      <TabSurfaceActivityProvider activity={{ visible: true, focused: false }}>
        <EpicSurface epicId="epic-b" tabId="tab-b" />
      </TabSurfaceActivityProvider>,
    );

    expect(
      useMobileHeaderStore
        .getState()
        .rightActionEntries.get(epicTabRightActionsKey("tab-b")),
    ).not.toBeUndefined();
  });

  it("registers nothing on desktop", () => {
    viewport.mobile = false;
    render(
      <TabSurfaceActivityProvider activity={{ visible: true, focused: true }}>
        <EpicSurface epicId="epic-a" tabId="tab-a" />
      </TabSurfaceActivityProvider>,
    );

    expect(useMobileHeaderStore.getState().rightActionEntries.size).toBe(0);
  });
});
