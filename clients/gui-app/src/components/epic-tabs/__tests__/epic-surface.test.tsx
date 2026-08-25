import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { BrowserSessionInfo } from "@traycer/protocol/host/browser/contracts";
import { TabSurfaceActivityProvider } from "@/components/layout/tab-surface-activity";
import type { BrowserSessionsState } from "@/components/epic-canvas/renderers/browser-sessions-context";

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
 * Ready-scope BrowserSessionsProvider stand-in: proves ReadyEpicBrowserSessionsScope
 * mounts it (and can publish sessions) without pulling in the host stream stack.
 */
vi.mock("@/lib/browser-view/use-pip-epic-sessions", () => ({
  PipEpicSessionsFeed: () => null,
  usePipEpicSessionsFeed: () => undefined,
}));

vi.mock("@/components/epic-canvas/renderers/browser-session-dock", async () => {
  const { BrowserSessionsContext } =
    await import("@/components/epic-canvas/renderers/browser-sessions-context");
  return {
    BrowserSessionsProvider: (props: {
      readonly epicId: string;
      readonly routingChatId: string | null;
      readonly children: ReactNode;
    }) => {
      const value: BrowserSessionsState = {
        lifecycle: "live",
        inventoryReady: true,
        items: readySessionsState.items,
        errorMessage: null,
        routingChatId: props.routingChatId,
        retry: () => undefined,
        closeSession: () => undefined,
        closeTab: () => Promise.resolve(),
        requestPromoteState: () =>
          Promise.reject(new Error("not used in epic-surface test")),
        requestLendStorage: () =>
          Promise.reject(new Error("not used in epic-surface test")),
      };
      return (
        <BrowserSessionsContext.Provider value={value}>
          <div
            data-epic-id={props.epicId}
            data-routing-chat-id={props.routingChatId ?? "null"}
            data-testid="browser-sessions-provider"
          />
          {props.children}
        </BrowserSessionsContext.Provider>
      );
    },
  };
});

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
  name: "Main",
  createdBy: { chatId: "chat-a", agentRunId: null },
  createdAt: 1,
  lastActivityAt: 2,
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

    // (1) Initial null handle: empty no-op BrowserSessionsContext, no throw.
    expect(screen.queryByTestId("browser-sessions-provider")).toBeNull();
    expect(screen.getByTestId("browser-session-count-tab-a").textContent).toBe(
      "0",
    );
    expect(
      screen.getByTestId("browser-session-lifecycle-tab-a").textContent,
    ).toBe("connecting");

    // (2) Handle resolves: ReadyEpicBrowserSessionsScope mounts provider;
    // sessions can appear via the ready context.
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
    // Lexicographic first chat id is the deterministic routing chat.
    expect(provider.dataset.routingChatId).toBe("chat-a");
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
});
