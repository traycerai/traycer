import "../../../../../__tests__/test-browser-apis";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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

// The close action is a TanStack mutation, so these renders need a client.
// ONE for the file's lifetime: a fresh client per render would leave existing
// observers attached to the old one.
const testQueryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, gcTime: 0 },
    mutations: { retry: false },
  },
});

function renderList(onClose: () => void) {
  return render(
    <QueryClientProvider client={testQueryClient}>
      <TooltipProvider delayDuration={0}>
        <SwitcherBrowsersList
          epicId="epic-1"
          tabId={TAB_ID}
          onClose={onClose}
        />
      </TooltipProvider>
    </QueryClientProvider>,
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
    // The double-tap test leaves a mutation deliberately unsettled, and the
    // client is shared for the file's lifetime - so without this the pending
    // count stays above zero and every later test finds the add button
    // disabled.
    testQueryClient.getMutationCache().clear();
  });

  it("lists every tab of every session on the surface's host", () => {
    renderList(() => undefined);
    expect(screen.getByRole("button", { name: /^Cart/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Guide/ })).toBeTruthy();
  });

  it("shows the URL on the row, where desktop only has a hover tooltip", () => {
    renderList(() => undefined);
    expect(screen.getByText("https://shop.example/cart")).toBeTruthy();
  });

  it("opens a tapped tab as the shown tile and closes the sheet", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderList(onClose);

    await user.click(screen.getByRole("button", { name: /^Cart/ }));

    expect(navigateNested).toHaveBeenCalled();
    expect(openTiles()).toMatchObject([
      { type: "browser-session", sessionId: "sess-1", tabId: "tab-1" },
    ]);
    expect(onClose).toHaveBeenCalled();
  });

  it("replaces the shown tile rather than stacking one per tap", async () => {
    const user = userEvent.setup();
    renderList(() => undefined);

    await user.click(screen.getByRole("button", { name: /^Cart/ }));
    await user.click(screen.getByRole("button", { name: /^Guide/ }));

    // A phone shows one tile; a second permanent tile would be unreachable.
    expect(openTiles()).toHaveLength(1);
    expect(openTiles()).toMatchObject([{ tabId: "tab-2" }]);
  });

  it("narrows the list by title or URL", async () => {
    const user = userEvent.setup();
    renderList(() => undefined);

    await user.type(screen.getByLabelText("Search browsers"), "docs.example");

    expect(screen.queryByRole("button", { name: /^Cart/ })).toBeNull();
    expect(screen.getByRole("button", { name: /^Guide/ })).toBeTruthy();
  });

  it("offers Add browser on a list that already has rows, and closes on the tile", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    openTab.mockResolvedValue({ sessionId: "sess-2", tabId: "tab-9" });
    renderList(onClose);

    // A list with rows renders no empty state, so the header "+" is the only
    // control carrying this name here - the two-match case is pinned by its own
    // test below.
    await user.click(screen.getByRole("button", { name: "Add browser" }));

    await waitFor(() => {
      expect(openTab).toHaveBeenCalledWith(null, "about:blank");
    });
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });

  it("opens one browser for two taps while the host is still answering", async () => {
    const user = userEvent.setup();
    // A request that never settles is the whole of the window this guards: on a
    // phone the host round-trip is long enough to be tapped through, and two
    // answers would mean two tabs and two tiles with nothing downstream to
    // collapse them.
    openTab.mockImplementation(() => new Promise(() => undefined));
    renderList(() => undefined);
    const add = screen.getByRole<HTMLButtonElement>("button", {
      name: "Add browser",
    });

    await user.click(add);
    await waitFor(() => {
      expect(add.disabled).toBe(true);
    });
    await user.click(add);

    expect(openTab).toHaveBeenCalledTimes(1);
  });

  it("keeps the sheet open when a browser cannot be created", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    replaceSessions([], "failed");
    renderList(onClose);

    await user.click(screen.getByRole("button", { name: "Add browser" }));

    // Nothing opened, so there is nothing for the sheet to get out of the way
    // of - and leaving would take this state's Retry with it.
    expect(openTab).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("keeps the sheet open when the host refuses the new tab", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    openTab.mockRejectedValue(new Error("no runtime"));
    renderList(onClose);

    await user.click(screen.getByRole("button", { name: "Add browser" }));

    await waitFor(() => {
      expect(openTab).toHaveBeenCalled();
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes a tab from the row's own action", async () => {
    const user = userEvent.setup();
    closeTab.mockResolvedValue(undefined);
    renderList(() => undefined);

    await user.click(screen.getByRole("button", { name: "Close Cart" }));

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
    renderList(() => undefined);
    // The glyph is coalesced in both directions, so it only exists once the
    // same chat is still driving after the delay.
    act(() => {
      vi.advanceTimersByTime(BROWSER_TAB_AGENT_ACTIVITY_MS);
    });
    vi.useRealTimers();

    fireEvent.click(
      screen.getByRole("button", { name: "Open driving chat: Checkout agent" }),
    );

    expect(openTiles()).toMatchObject([{ type: "chat", id: "chat-driver" }]);
  });

  it("mounts the desktop empty state, add affordance included", () => {
    replaceSessions([], "live");
    renderList(() => undefined);
    const empty = screen.getByTestId("epic-browsers-panel-empty");
    expect(empty).toBeTruthy();
    // On an empty list the header "+" and this labelled button are BOTH on
    // screen and share an accessible name, which device verification caught as
    // a two-match query waiting to happen. Pinned here so the ambiguity is a
    // stated fact rather than a trap for the next name-only query.
    expect(screen.getAllByRole("button", { name: "Add browser" })).toHaveLength(
      2,
    );
    expect(
      within(empty).getByRole("button", { name: "Add browser" }),
    ).toBeTruthy();
  });

  it("keeps the rows reachable when the session stream drops", () => {
    // A stream that fails does not un-open the tabs, and these rows are the
    // only route to them. Desktop renders the banner ABOVE its list for the
    // same reason; replacing the list would strand a phone user with tabs they
    // can see nothing of.
    replaceSessions(sessionsState.value.items, "failed");
    renderList(() => undefined);

    expect(screen.getByText("Browsers unavailable.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Cart/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Guide/ })).toBeTruthy();
  });

  it("mounts the desktop unavailable state with its retry", () => {
    replaceSessions([], "failed");
    renderList(() => undefined);
    expect(screen.getByText("Browsers unavailable.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
