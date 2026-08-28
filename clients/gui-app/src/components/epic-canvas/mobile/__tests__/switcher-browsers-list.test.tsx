import "../../../../../__tests__/test-browser-apis";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type {
  BrowserSessionInfo,
  BrowserTabInfo,
} from "@traycer/protocol/host/browser/contracts";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SwitcherBrowsersList } from "@/components/epic-canvas/mobile/switcher-browsers-list";
import type { BrowserSessionsState } from "@/components/epic-canvas/renderers/browser-sessions-context";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { BROWSER_TAB_AGENT_ACTIVITY_MS } from "@/lib/browser-view/browser-tab-display";

const browserHostPinState = vi.hoisted(() => ({
  selection: null as string | null,
  setSelection: vi.fn(),
}));

vi.mock("@/hooks/host/use-surface-host-pin", () => ({
  useTabSurfaceKey: (kind: string, tabId: string) => `${kind}:${tabId}`,
  useSurfaceHostPin: () => ({
    selection: browserHostPinState.selection,
    honoredSelection: browserHostPinState.selection,
    setSelection: browserHostPinState.setSelection,
    resolvedHostId: browserHostPinState.selection ?? "host-1",
    followingHostId: "host-1",
    isPinned: browserHostPinState.selection !== null,
    latchOnFirstUse: () => undefined,
  }),
  useSurfaceHostClient: () => null,
}));

vi.mock("@/components/settings/host-scope/use-host-options", () => ({
  useHostOptions: () => ({
    hosts: [{ hostId: "host-1", name: "Home Mac", connectable: true }],
    activeHostId: "host-1",
    isLoading: false,
    listsFailed: false,
    retryLists: vi.fn(),
  }),
}));

vi.mock("@/components/settings/host-scope/host-option-row", () => ({
  HostOptionRow: (props: { readonly host: { readonly name: string } }) => (
    <span>{props.host.name}</span>
  ),
}));

vi.mock("@/components/epic-canvas/renderers/browser-sessions-provider", () => ({
  BrowserSessionsHostBoundary: (props: { readonly children: ReactNode }) =>
    props.children,
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

vi.mock("@dnd-kit/core", () => ({
  useDraggable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => undefined,
    isDragging: false,
  }),
}));

const closeTab = vi.fn<(sessionId: string, tabId: string) => Promise<void>>();
const openTab = vi.fn<BrowserSessionsState["openTab"]>();
const navigateNested = vi.fn(
  (_epicId: string, _tabId: string, prepare: () => unknown) => prepare(),
);

function forwardCloseTab(sessionId: string, tabId: string): Promise<void> {
  return closeTab(sessionId, tabId);
}

function forwardOpenTab(
  sessionId: string | null,
  url: string,
): Promise<{ sessionId: string; tabId: string }> {
  return openTab(sessionId, url);
}

const sessionsState = vi.hoisted<{ value: BrowserSessionsState }>(() => ({
  value: {
    hostId: "host-1",
    lifecycle: "live",
    inventoryReady: true,
    items: [],
    errorMessage: null,
    retry: vi.fn(),
    openTab: forwardOpenTab,
    closeTab: forwardCloseTab,
  },
}));

vi.mock("@/components/epic-canvas/renderers/browser-sessions-context", () => ({
  useBrowserSessionsContext: () => sessionsState.value,
}));

vi.mock("@/lib/epic-selectors", () => ({
  useEpicChatRecords: () => [{ id: "chat-driver", title: "Checkout agent" }],
}));

vi.mock("@/hooks/epic/use-epic-nested-focus-navigation", () => ({
  useEpicNestedFocusNavigation: () => navigateNested,
}));

const TAB_ID = "view-tab-1";

function tab(
  overrides: Partial<BrowserTabInfo> & Pick<BrowserTabInfo, "tabId" | "url">,
): BrowserTabInfo {
  return {
    originTier: "dev",
    status: "ready",
    title: null,
    viewed: false,
    drivenBy: [],
    ...overrides,
  };
}

function session(
  overrides: Partial<BrowserSessionInfo> &
    Pick<BrowserSessionInfo, "sessionId" | "profile" | "tabs">,
): BrowserSessionInfo {
  return {
    epicId: "epic-1",
    hostId: "host-1",
    lastActivityAt: 2,
    ...overrides,
    runtime: overrides.runtime ?? { kind: "headless", revision: 0 },
  };
}

function replaceSessions(
  items: readonly BrowserSessionInfo[],
  lifecycle: BrowserSessionsState["lifecycle"],
): void {
  sessionsState.value = { ...sessionsState.value, items, lifecycle };
}

function seedCanvasTab(): void {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useEpicCanvasStore.setState({
    tabsById: {
      [TAB_ID]: { tabId: TAB_ID, epicId: "epic-1", name: "Epic 1" },
    },
  });
}

function renderList(onClose: () => void = () => undefined) {
  return render(
    <TooltipProvider delayDuration={0}>
      <SwitcherBrowsersList epicId="epic-1" tabId={TAB_ID} onClose={onClose} />
    </TooltipProvider>,
  );
}

function openTiles(): ReadonlyArray<{ readonly type: string }> {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[TAB_ID];
  if (canvas === undefined) return [];
  return Object.values(canvas.tilesByInstanceId).flatMap((tile) =>
    tile === undefined ? [] : [tile],
  );
}

describe("SwitcherBrowsersList", () => {
  beforeEach(() => {
    seedCanvasTab();
    browserHostPinState.selection = null;
    closeTab.mockReset();
    openTab.mockReset();
    navigateNested.mockClear();
    replaceSessions(
      [
        session({
          sessionId: "sess-1",
          profile: "primary",
          tabs: [
            tab({
              tabId: "tab-1",
              url: "https://shop.example/cart",
              title: "Cart",
            }),
            tab({
              tabId: "tab-2",
              url: "https://docs.example/guide",
              title: "Guide",
              status: "dormant",
            }),
          ],
        }),
      ],
      "live",
    );
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("lists every tab of every session on the surface's host", () => {
    renderList();
    expect(screen.getByTestId("switcher-browser-row-tab-1")).toBeTruthy();
    expect(screen.getByTestId("switcher-browser-row-tab-2")).toBeTruthy();
  });

  it("shows the URL on the row, where desktop only has a hover tooltip", () => {
    renderList();
    expect(screen.getByText("https://shop.example/cart")).toBeTruthy();
  });

  it("opens a tapped tab as the shown tile and closes the sheet", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderList(onClose);

    await user.click(screen.getByTestId("switcher-browser-row-tab-1"));

    expect(navigateNested).toHaveBeenCalled();
    expect(openTiles()).toMatchObject([
      { type: "browser-session", sessionId: "sess-1", tabId: "tab-1" },
    ]);
    expect(onClose).toHaveBeenCalled();
  });

  it("replaces the shown tile rather than stacking one per tap", async () => {
    const user = userEvent.setup();
    renderList();

    await user.click(screen.getByTestId("switcher-browser-row-tab-1"));
    await user.click(screen.getByTestId("switcher-browser-row-tab-2"));

    // A phone shows one tile; a second permanent tile would be unreachable.
    expect(openTiles()).toHaveLength(1);
    expect(openTiles()).toMatchObject([{ tabId: "tab-2" }]);
  });

  it("narrows the list by title or URL", async () => {
    const user = userEvent.setup();
    renderList();

    await user.type(screen.getByLabelText("Search browsers"), "docs.example");

    expect(screen.queryByTestId("switcher-browser-row-tab-1")).toBeNull();
    expect(screen.getByTestId("switcher-browser-row-tab-2")).toBeTruthy();
  });

  it("offers Add browser on a list that already has rows", async () => {
    const user = userEvent.setup();
    openTab.mockResolvedValue({ sessionId: "sess-2", tabId: "tab-9" });
    renderList();

    await user.click(screen.getByLabelText("Add browser"));

    expect(openTab).toHaveBeenCalledWith(null, "about:blank");
  });

  it("closes a tab from the row's own action", async () => {
    const user = userEvent.setup();
    closeTab.mockResolvedValue(undefined);
    renderList();

    await user.click(screen.getByTestId("switcher-browser-close-tab-1"));

    await waitFor(() => {
      expect(closeTab).toHaveBeenCalledWith("sess-1", "tab-1");
    });
  });

  it("offers the driving chat as a tappable action, not a hover glyph", () => {
    replaceSessions(
      [
        session({
          sessionId: "sess-1",
          profile: "primary",
          tabs: [
            tab({
              tabId: "tab-1",
              url: "https://shop.example/cart",
              title: "Cart",
              drivenBy: [
                {
                  chatId: "chat-driver",
                  agentRunId: null,
                  requestId: "req-1",
                },
              ],
            }),
          ],
        }),
      ],
      "live",
    );
    vi.useFakeTimers();
    renderList();
    // The glyph is coalesced in both directions, so it only exists once the
    // same chat is still driving after the delay.
    act(() => {
      vi.advanceTimersByTime(BROWSER_TAB_AGENT_ACTIVITY_MS);
    });
    vi.useRealTimers();

    fireEvent.click(screen.getByTestId("switcher-browser-driver-tab-1"));

    expect(openTiles()).toMatchObject([{ type: "chat", id: "chat-driver" }]);
  });

  it("mounts the desktop empty state, add affordance included", () => {
    replaceSessions([], "live");
    renderList();
    expect(screen.getByTestId("epic-browsers-panel-empty")).toBeTruthy();
  });

  it("mounts the desktop unavailable state with its retry", () => {
    replaceSessions([], "failed");
    renderList();
    expect(screen.getByText("Browsers unavailable.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
