vi.mock("@/hooks/notifications/use-host-notification-indicators-query", () => ({
  useHostNotificationIndicators: () => ({
    data: { epics: {}, chats: {} },
    isPending: false,
    isFetching: false,
    error: null,
    refetch: () => Promise.resolve(),
  }),
}));

vi.mock("@/components/chat/chat-progress-icon", () => ({
  ChatProgressIcon: () => <span data-testid="chat-progress-icon" />,
}));
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { TabStrip } from "@/components/epic-canvas/canvas/tab-strip";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type {
  EpicCanvasTileRef,
  EpicNodeRef,
  SplitDirection,
} from "@/stores/epics/canvas/types";
import { makeGitBundleDiffTile } from "@/lib/git/git-diff-tile";
import { makeManagedCommandOutputTileRef } from "@/stores/epics/canvas/tile-schema/managed-command-output-tile";
import {
  disposeManagedCommandChatSessions,
  installManagedCommandChatSession,
} from "@/stores/managed-commands/test-support/managed-command-chat-session";
import { managedCommandSchema } from "@traycer/protocol/host/managed-command/unary-schemas";
import type { BrowserSessionInfo } from "@traycer/protocol/host/browser/contracts";
import {
  BrowserSessionsContext,
  type BrowserSessionsState,
} from "@/components/epic-canvas/renderers/browser-sessions-context";
import { tooltipTextFor } from "@/components/ui/__tests__/tooltip-probe";
import { NotificationConsumptionContext } from "@/components/notifications/notification-consumption-context";

interface CapturedDraggableInput {
  readonly id: string;
  readonly data: unknown;
}

interface CapturedDroppableInput {
  readonly id: string;
  readonly data: unknown;
}

interface TabStripTestState {
  draggableInputs: CapturedDraggableInput[];
  droppableInputs: CapturedDroppableInput[];
}

const testState = vi.hoisted((): TabStripTestState => ({
  draggableInputs: [],
  droppableInputs: [],
}));

interface TerminalAuthorityTestState {
  capability: "unknown" | "legacy" | "capable";
  canMutate: boolean;
  viewModel: {
    readonly displayTitle: string;
    readonly manualTitle: string | null;
    readonly activeProcessName: string | null;
    readonly liveCwd: string | null;
  } | null;
  rename: Mock<
    (request: {
      readonly terminalId: string;
      readonly manualTitle: string;
    }) => void
  >;
  close: Mock<(request: { readonly terminalId: string }) => void>;
}

const terminalAuthorityState = vi.hoisted((): TerminalAuthorityTestState => ({
  capability: "legacy",
  canMutate: false,
  viewModel: null,
  rename:
    vi.fn<
      (request: {
        readonly terminalId: string;
        readonly manualTitle: string;
      }) => void
    >(),
  close: vi.fn<(request: { readonly terminalId: string }) => void>(),
}));

const consumeNotificationEntity = vi.hoisted(() => vi.fn());

vi.mock("@dnd-kit/core", () => ({
  useDraggable: (input: CapturedDraggableInput) => {
    testState.draggableInputs.push(input);
    return {
      setNodeRef: () => undefined,
      listeners: undefined,
      isDragging: false,
    };
  },
  useDroppable: (input: CapturedDroppableInput) => {
    testState.droppableInputs.push(input);
    return {
      setNodeRef: () => undefined,
    };
  },
}));

vi.mock("@/lib/epic-selectors", () => {
  return {
    useEpicTabDisplayTitle: (node: EpicCanvasTileRef) => node.name,
    useEpicLiveArtifactTitleGenerating: () => false,
    useRegisteredEpicNodeArchived: () => false,
  };
});

// TabItem resolves the tab's bound-host client for terminal renames; these
// tests render outside a <HostRuntimeProvider>, so stub the host seam.
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));

vi.mock("@/hooks/terminal/use-terminal-rename-for-mutation", () => ({
  useTerminalRenameFor: () => ({ mutate: () => undefined }),
}));

vi.mock("@/hooks/terminal/use-epic-terminal-authority", () => ({
  useEpicTerminalAuthority: () => ({
    capability: terminalAuthorityState.capability,
    projection:
      terminalAuthorityState.capability === "capable" ? {} : undefined,
    viewModel: terminalAuthorityState.viewModel,
    canMutate: terminalAuthorityState.canMutate,
    migrationPending: false,
    migrationError: null,
    retryMigration: () => undefined,
    ensureRunning: {},
    rename: { mutate: terminalAuthorityState.rename },
    close: {
      isPending: false,
      mutateAsync: (request: { readonly terminalId: string }) => {
        terminalAuthorityState.close(request);
        return Promise.resolve();
      },
    },
  }),
}));

const VIEW_TAB_ID = "view-tab-1";

const TAB: EpicNodeRef = {
  id: "workspace-file:host-A:/repo:a.md",
  instanceId: "inst-tab-a",
  type: "workspace-file",
  name: "a.md",
  hostId: "host-A",
  workspacePath: "/repo",
  filePath: "a.md",
};

const ARTIFACT_TAB: EpicNodeRef = {
  id: "spec-1",
  instanceId: "inst-spec-1",
  type: "spec",
  name: "Architecture",
  hostId: "host-A",
};

const TERMINAL_TAB: EpicNodeRef = {
  id: "terminal-1",
  instanceId: "inst-terminal-1",
  type: "terminal",
  name: "Local presentation",
  titleSource: "manual",
  hostId: "host-A",
  cwd: "/repo",
};

const CHAT_TAB: EpicNodeRef = {
  id: "chat-1",
  instanceId: "inst-chat-1",
  type: "chat",
  name: "Agent chat",
  hostId: "host-B",
};

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function browserSessionsState(
  items: readonly BrowserSessionInfo[],
): BrowserSessionsState {
  return {
    hostId: "host-A",
    lifecycle: "live",
    inventoryReady: true,
    items,
    errorMessage: null,
    retry: () => undefined,
    openTab: () => Promise.reject(new Error("not used")),
    closeTab: () => Promise.resolve(),
  };
}

// TabItem reads its active/preview/globally-active state from the canvas store
// (via `useTabActivation`), not from props, so seed a tab whose lone group has
// `TAB` as the active + preview tab.
function seedActivePreviewTab(tab: EpicCanvasTileRef): void {
  useEpicCanvasStore.setState({
    tabsById: {
      [VIEW_TAB_ID]: {
        tabId: VIEW_TAB_ID,
        epicId: "epic-1",
        name: "Epic 1",
      },
    },
    canvasByTabId: {
      [VIEW_TAB_ID]: {
        activePaneId: "group-1",
        root: {
          kind: "pane",
          id: "group-1",
          tabInstanceIds: [tab.instanceId],
          activeTabId: tab.instanceId,
          previewTabId: tab.instanceId,
          activationHistory: [tab.instanceId],
        },
        tilesByInstanceId: { [tab.instanceId]: tab },
        sizesByGroupId: {},
      },
    },
  });
}

function renderTabStrip(input: {
  readonly onClose: (groupId: string, tabId: string) => void;
  readonly onMenuClose?: (groupId: string, tabId: string) => void;
  readonly onPromotePreview: (groupId: string) => void;
  readonly onOpenBlankTab: (groupId: string) => void;
  readonly onSplit:
    | ((groupId: string, direction: SplitDirection) => void)
    | undefined;
}) {
  renderTabStripForTab(TAB, input, []);
}

function renderTabStripForTab(
  tab: EpicCanvasTileRef,
  input: {
    readonly onClose: (groupId: string, tabId: string) => void;
    readonly onMenuClose?: (groupId: string, tabId: string) => void;
    readonly onPromotePreview: (groupId: string) => void;
    readonly onOpenBlankTab: (groupId: string) => void;
    readonly onSplit:
      | ((groupId: string, direction: SplitDirection) => void)
      | undefined;
  },
  browserSessions: readonly BrowserSessionInfo[],
) {
  seedActivePreviewTab(tab);
  const queryClient = createQueryClient();
  const onSplit = input.onSplit === undefined ? () => undefined : input.onSplit;
  render(
    <QueryClientProvider client={queryClient}>
      <BrowserSessionsContext.Provider
        value={browserSessionsState(browserSessions)}
      >
        <NotificationConsumptionContext.Provider
          value={consumeNotificationEntity}
        >
          <TooltipProvider delayDuration={0}>
            <TabStrip
              epicId="epic-1"
              tabId={VIEW_TAB_ID}
              groupId="group-1"
              tabs={[tab]}
              activeTabId={tab.instanceId}
              onSelectTab={() => undefined}
              onCloseTab={input.onClose}
              onPromotePreview={input.onPromotePreview}
              onSplit={onSplit}
              onCloseGroup={() => undefined}
              onOpenBlankTab={input.onOpenBlankTab}
              canRenameTabs
              menuHandlers={{
                onClose: input.onMenuClose ?? (() => undefined),
                onCloseOthers: () => undefined,
                onCloseRight: () => undefined,
                onCloseAll: () => undefined,
                onSplit: () => undefined,
                onRevealInSidebar: () => undefined,
                onRename: () => undefined,
              }}
            />
          </TooltipProvider>
        </NotificationConsumptionContext.Provider>
      </BrowserSessionsContext.Provider>
    </QueryClientProvider>,
  );
}

describe("<TabStrip />", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    testState.draggableInputs = [];
    testState.droppableInputs = [];
    terminalAuthorityState.capability = "legacy";
    terminalAuthorityState.canMutate = false;
    terminalAuthorityState.viewModel = null;
    terminalAuthorityState.rename.mockReset();
    terminalAuthorityState.close.mockReset();
    consumeNotificationEntity.mockReset();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  });

  it("uses the live browser tab title, URL, and favicon", () => {
    const browserTab: EpicCanvasTileRef = {
      id: "browser-session:session-1:browser-tab-1",
      instanceId: "browser-instance-1",
      type: "browser-session",
      name: "Browser",
      hostId: "host-A",
      sessionId: "session-1",
      tabId: "browser-tab-1",
      viewportPreset: "responsive",
    };
    renderTabStripForTab(
      browserTab,
      {
        onClose: () => undefined,
        onPromotePreview: () => undefined,
        onOpenBlankTab: () => undefined,
        onSplit: () => undefined,
      },
      [
        {
          sessionId: "session-1",
          epicId: "epic-1",
          hostId: "host-A",
          profile: "primary",
          lastActivityAt: 2,
          runtime: { kind: "electron", revision: 0 },
          tabs: [
            {
              tabId: "browser-tab-1",
              url: "https://thepier5.com/",
              originTier: "external",
              status: "ready",
              title: "Waterfront Hotel in Baltimore | Pier 5 Hotel",
              viewed: true,
              drivenBy: [],
            },
          ],
        },
      ],
    );

    const tab = screen.getByRole("tab", {
      name: /Waterfront Hotel in Baltimore \| Pier 5 Hotel/,
    });
    expect(
      tooltipTextFor(screen.getByTestId("tab-title-browser-instance-1")),
    ).toContain("https://thepier5.com/");
    expect(tab.querySelector("img")?.getAttribute("src")).toBe(
      "https://thepier5.com/favicon.ico",
    );
  });

  it("renders preview tabs with an overlaid close button that does not reserve flex space", () => {
    const onClose = vi.fn();
    renderTabStrip({
      onClose,
      onPromotePreview: () => undefined,
      onOpenBlankTab: () => undefined,
      onSplit: undefined,
    });

    const tab = screen.getByRole("tab", { name: /a\.md/ });
    expect(tab.getAttribute("data-preview")).toBe("true");
    expect(tab.querySelector(".italic")).toBeTruthy();

    const closeButton = screen.getByRole("button", { name: "Close a.md" });
    expect(closeButton.className).toContain("absolute");
    expect(closeButton.className).not.toContain("ml-1");

    fireEvent.click(closeButton);

    expect(onClose).toHaveBeenCalledWith("group-1", TAB.instanceId);
  });

  it("promotes preview tabs on double click", () => {
    const onPromotePreview = vi.fn();
    renderTabStrip({
      onClose: () => undefined,
      onPromotePreview,
      onOpenBlankTab: () => undefined,
      onSplit: undefined,
    });

    fireEvent.doubleClick(screen.getByRole("tab", { name: /a\.md/ }));

    expect(onPromotePreview).toHaveBeenCalledWith("group-1");
  });

  it("marks the clicked active chat tab's host-qualified notifications read", () => {
    renderTabStripForTab(
      CHAT_TAB,
      {
        onClose: () => undefined,
        onPromotePreview: () => undefined,
        onOpenBlankTab: () => undefined,
        onSplit: undefined,
      },
      [],
    );

    fireEvent.click(screen.getByRole("tab", { name: /Agent chat/ }));

    expect(consumeNotificationEntity).toHaveBeenCalledWith({
      originHostId: "host-B",
      entity: { epicId: "epic-1", chatId: "chat-1" },
    });
  });

  it("copies the absolute file path from a workspace-file tab context menu", () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText },
    });
    renderTabStrip({
      onClose: () => undefined,
      onPromotePreview: () => undefined,
      onOpenBlankTab: () => undefined,
      onSplit: undefined,
    });

    fireEvent.contextMenu(screen.getByTestId(`tab-item-${TAB.instanceId}`));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy File Path" }));

    expect(writeText).toHaveBeenCalledWith("/repo/a.md");
  });

  it("does not offer the file-path action for non-file tabs", () => {
    renderTabStripForTab(
      ARTIFACT_TAB,
      {
        onClose: () => undefined,
        onPromotePreview: () => undefined,
        onOpenBlankTab: () => undefined,
        onSplit: undefined,
      },
      [],
    );

    fireEvent.contextMenu(
      screen.getByTestId(`tab-item-${ARTIFACT_TAB.instanceId}`),
    );

    expect(
      screen.queryByRole("menuitem", { name: "Copy File Path" }),
    ).toBeNull();
  });

  it.each([
    {
      name: "before readiness",
      capability: "unknown" as const,
      canMutate: false,
      viewModel: null,
      title: "Local presentation",
    },
    {
      name: "after PTY startup",
      capability: "capable" as const,
      canMutate: true,
      viewModel: {
        displayTitle: "Manual title",
        manualTitle: "Manual title",
        activeProcessName: "bun",
        liveCwd: "/repo/live",
      },
      title: "Manual title",
    },
  ])(
    "closes a terminal tab $name as a local presentation only",
    ({ capability, canMutate, viewModel, title }) => {
      terminalAuthorityState.capability = capability;
      terminalAuthorityState.canMutate = canMutate;
      terminalAuthorityState.viewModel = viewModel;
      const onClose = vi.fn((groupId: string, instanceId: string): void => {
        useEpicCanvasStore
          .getState()
          .closeCanvasTab(VIEW_TAB_ID, groupId, instanceId);
      });
      renderTabStripForTab(
        TERMINAL_TAB,
        {
          onClose,
          onPromotePreview: () => undefined,
          onOpenBlankTab: () => undefined,
          onSplit: undefined,
        },
        [],
      );

      expect(
        screen.getByTestId(`tab-title-${TERMINAL_TAB.instanceId}`).textContent,
      ).toBe(title);

      fireEvent.click(screen.getByRole("button", { name: `Close ${title}` }));

      expect(terminalAuthorityState.close).not.toHaveBeenCalled();
      expect(onClose).toHaveBeenCalledWith("group-1", TERMINAL_TAB.instanceId);
      expect(
        useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID]
          ?.tilesByInstanceId[TERMINAL_TAB.instanceId],
      ).toBeUndefined();
    },
  );

  it("offers Edit Title for a capable terminal tab", () => {
    terminalAuthorityState.capability = "capable";
    terminalAuthorityState.canMutate = true;
    terminalAuthorityState.viewModel = {
      displayTitle: "Manual title",
      manualTitle: "Manual title",
      activeProcessName: "bun",
      liveCwd: "/repo/live",
    };
    renderTabStripForTab(
      TERMINAL_TAB,
      {
        onClose: () => undefined,
        onPromotePreview: () => undefined,
        onOpenBlankTab: () => undefined,
        onSplit: undefined,
      },
      [],
    );

    fireEvent.contextMenu(
      screen.getByTestId(`tab-item-${TERMINAL_TAB.instanceId}`),
    );
    expect(screen.getByRole("menuitem", { name: "Edit Title" })).not.toBeNull();
  });

  it("closes a capable terminal tab from middle-click without a lifetime mutation", () => {
    terminalAuthorityState.capability = "capable";
    terminalAuthorityState.canMutate = true;
    terminalAuthorityState.viewModel = {
      displayTitle: "Manual title",
      manualTitle: "Manual title",
      activeProcessName: "bun",
      liveCwd: "/repo/live",
    };
    const onClose = vi.fn((groupId: string, instanceId: string): void => {
      useEpicCanvasStore
        .getState()
        .closeCanvasTab(VIEW_TAB_ID, groupId, instanceId);
    });
    renderTabStripForTab(
      TERMINAL_TAB,
      {
        onClose,
        onPromotePreview: () => undefined,
        onOpenBlankTab: () => undefined,
        onSplit: undefined,
      },
      [],
    );

    fireEvent(
      screen.getByTestId(`tab-item-${TERMINAL_TAB.instanceId}`),
      new MouseEvent("auxclick", { bubbles: true, button: 1 }),
    );

    expect(terminalAuthorityState.close).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledWith("group-1", TERMINAL_TAB.instanceId);
    expect(
      useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID]
        ?.tilesByInstanceId[TERMINAL_TAB.instanceId],
    ).toBeUndefined();
  });

  it.each([
    {
      name: "provider-login",
      tab: {
        id: "term-signin",
        instanceId: "inst-signin",
        type: "terminal" as const,
        name: "Copilot sign-in",
        titleSource: "manual" as const,
        hostId: "host-A",
        cwd: "~",
        origin: "provider-login" as const,
        originProviderId: "copilot" as const,
      },
    },
    {
      name: "setup",
      tab: {
        id: "term-setup",
        instanceId: "inst-setup",
        type: "terminal" as const,
        name: "Setup: traycer",
        titleSource: "manual" as const,
        hostId: "host-A",
        cwd: "/repo",
        origin: "setup" as const,
      },
    },
  ])(
    "closes a capable-host $name ref through the legacy coordinator branch",
    ({ tab }) => {
      // Import-exempt refs report capability: "legacy" from
      // useEpicTerminalAuthority even against a capable host, so the
      // coordinator can close them locally. Projection stays undefined.
      terminalAuthorityState.capability = "legacy";
      terminalAuthorityState.canMutate = true;
      const onClose = vi.fn((groupId: string, instanceId: string): void => {
        useEpicCanvasStore
          .getState()
          .closeCanvasTab(VIEW_TAB_ID, groupId, instanceId);
      });
      renderTabStripForTab(
        tab,
        {
          onClose,
          onPromotePreview: () => undefined,
          onOpenBlankTab: () => undefined,
          onSplit: undefined,
        },
        [],
      );

      fireEvent.click(
        screen.getByRole("button", { name: `Close ${tab.name}` }),
      );
      expect(onClose).toHaveBeenCalledWith("group-1", tab.instanceId);
      expect(
        useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID]
          ?.tilesByInstanceId[tab.instanceId],
      ).toBeUndefined();
      expect(terminalAuthorityState.close).not.toHaveBeenCalled();
    },
  );

  it("fails closed for unknown-capability terminal rename and still closes the presentation", () => {
    terminalAuthorityState.capability = "unknown";
    terminalAuthorityState.canMutate = false;
    const onMenuClose = vi.fn((groupId: string, instanceId: string): void => {
      useEpicCanvasStore
        .getState()
        .closeCanvasTab(VIEW_TAB_ID, groupId, instanceId);
    });
    renderTabStripForTab(
      TERMINAL_TAB,
      {
        onClose: () => undefined,
        onMenuClose,
        onPromotePreview: () => undefined,
        onOpenBlankTab: () => undefined,
        onSplit: undefined,
      },
      [],
    );

    fireEvent.contextMenu(
      screen.getByTestId(`tab-item-${TERMINAL_TAB.instanceId}`),
    );

    expect(screen.queryByRole("menuitem", { name: "Edit Title" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Close" }));
    expect(onMenuClose).toHaveBeenCalledWith(
      "group-1",
      TERMINAL_TAB.instanceId,
    );
    expect(terminalAuthorityState.close).not.toHaveBeenCalled();
    expect(
      useEpicCanvasStore.getState().canvasByTabId[VIEW_TAB_ID]
        ?.tilesByInstanceId[TERMINAL_TAB.instanceId],
    ).toBeUndefined();
  });

  it("opens a blank tab when the empty strip area is double-clicked", () => {
    const onOpenBlankTab = vi.fn();
    renderTabStrip({
      onClose: () => undefined,
      onPromotePreview: () => undefined,
      onOpenBlankTab,
      onSplit: undefined,
    });

    // Double-clicking the strip-end container itself (not a tab) opens a blank.
    fireEvent.doubleClick(screen.getByTestId("tab-strip-end"));

    expect(onOpenBlankTab).toHaveBeenCalledWith("group-1");
  });

  it("maps vertical wheel movement to horizontal scroll when task tabs overflow", () => {
    renderTabStrip({
      onClose: () => undefined,
      onPromotePreview: () => undefined,
      onOpenBlankTab: () => undefined,
      onSplit: undefined,
    });

    const scroller = screen.getByTestId("tab-strip-end");
    Object.defineProperties(scroller, {
      clientWidth: { configurable: true, value: 100 },
      scrollWidth: { configurable: true, value: 400 },
    });

    fireEvent.wheel(scroller, { deltaY: 80, deltaMode: 0 });

    expect(scroller.scrollLeft).toBe(80);
  });

  it("does not open a blank tab when an existing tab is double-clicked", () => {
    const onOpenBlankTab = vi.fn();
    renderTabStrip({
      onClose: () => undefined,
      onPromotePreview: () => undefined,
      onOpenBlankTab,
      onSplit: undefined,
    });

    // The guard (target === currentTarget) keeps tab double-clicks from
    // bubbling into a blank-tab open.
    fireEvent.doubleClick(screen.getByRole("tab", { name: /a\.md/ }));

    expect(onOpenBlankTab).not.toHaveBeenCalled();
  });

  it("splits right by default and down when Shift is held for the click", () => {
    const onSplit = vi.fn();
    renderTabStrip({
      onClose: () => undefined,
      onPromotePreview: () => undefined,
      onOpenBlankTab: () => undefined,
      onSplit,
    });

    const splitButton = screen.getByRole("button", {
      name: "Split group right",
    });
    fireEvent.click(splitButton);
    fireEvent.click(splitButton, { shiftKey: true });

    expect(onSplit).toHaveBeenNthCalledWith(1, "group-1", "horizontal");
    expect(onSplit).toHaveBeenNthCalledWith(2, "group-1", "vertical");
  });

  it("shows the down-split affordance when focus arrives with Shift held", () => {
    renderTabStrip({
      onClose: () => undefined,
      onPromotePreview: () => undefined,
      onOpenBlankTab: () => undefined,
      onSplit: undefined,
    });

    fireEvent.keyDown(window, { key: "Shift", shiftKey: true });
    const splitButton = screen.getByRole("button", {
      name: "Split group right",
    });
    fireEvent.focus(splitButton);

    expect(splitButton.getAttribute("aria-label")).toBe("Split group down");
    expect(splitButton.getAttribute("data-split-direction")).toBe("vertical");
  });

  it("keeps the default affordance while neither hovered nor focused", () => {
    renderTabStrip({
      onClose: () => undefined,
      onPromotePreview: () => undefined,
      onOpenBlankTab: () => undefined,
      onSplit: undefined,
    });

    fireEvent.keyDown(window, { key: "Shift", shiftKey: true });

    const splitButton = screen.getByRole("button", {
      name: "Split group right",
    });
    expect(splitButton.getAttribute("data-split-direction")).toBe("horizontal");
  });

  it("updates the split affordance and tooltip while Shift is held", async () => {
    renderTabStrip({
      onClose: () => undefined,
      onPromotePreview: () => undefined,
      onOpenBlankTab: () => undefined,
      onSplit: undefined,
    });

    const splitButton = screen.getByRole("button", {
      name: "Split group right",
    });
    fireEvent.focus(splitButton);

    expect(splitButton.getAttribute("aria-label")).toBe("Split group right");
    expect(splitButton.getAttribute("data-split-direction")).toBe("horizontal");
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toContain("Shift+click to split down");
    expect(tooltip.querySelector('[data-slot="kbd"]')).not.toBeNull();

    fireEvent.keyDown(window, { key: "Shift", shiftKey: true });

    expect(splitButton.getAttribute("aria-label")).toBe("Split group down");
    expect(splitButton.getAttribute("data-split-direction")).toBe("vertical");
    expect(screen.getByRole("tooltip").textContent).toContain(
      "Release Shift to split right",
    );
  });

  it("shows repository hierarchy in Git bundle titles and structured tooltips", async () => {
    const gitTab = makeGitBundleDiffTile({
      hostId: "host-A",
      runningDir: "/worktrees/right-click-context-menu/traycer",
      bundleGroup: "changes",
      repositoryContext: {
        workspaceLabel: "traycer-internal",
        repositoryLabel: "traycer",
      },
    });
    renderTabStripForTab(
      gitTab,
      {
        onClose: () => undefined,
        onPromotePreview: () => undefined,
        onOpenBlankTab: () => undefined,
        onSplit: undefined,
      },
      [],
    );

    const title = screen.getByTestId(`tab-title-${gitTab.instanceId}`);
    expect(title.textContent).toBe("traycer-internal › traycer · Changes");

    fireEvent.focus(title);

    const tooltips = await screen.findAllByTestId(
      `git-diff-tab-tooltip-${gitTab.instanceId}`,
    );
    const tooltip = within(tooltips[0]);
    expect(tooltip.getByTestId("git-diff-tooltip-workspace").textContent).toBe(
      "Workspacetraycer-internal",
    );
    expect(tooltip.getByTestId("git-diff-tooltip-repository").textContent).toBe(
      "Repositorytraycer",
    );
    expect(tooltip.getByTestId("git-diff-tooltip-scope").textContent).toBe(
      "DiffChanges",
    );
    expect(tooltip.getByTestId("git-diff-tooltip-path").textContent).toBe(
      "Path/worktrees/right-click-context-menu/traycer",
    );
  });
});

/**
 * A shell's tab used to draw lucide `Activity` - a glyph no other shell surface
 * uses - so the strip was the one place a watcher did not look like a watcher.
 * It reads the same live record the tab TITLE already resolves, so the icon and
 * the name in one tab can never disagree.
 */
describe("<TabStrip /> shell output tabs", () => {
  const EPIC_ID = "epic-1";
  const CHAT_ID = "chat-shell";
  const HOST_ID = "host-A";

  afterEach(() => {
    cleanup();
    disposeManagedCommandChatSessions();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  });

  function renderShellTab(monitoring: boolean | null): void {
    const tab = makeManagedCommandOutputTileRef({
      commandId: "cmd-1",
      hostId: HOST_ID,
    });
    if (monitoring !== null) {
      const session = installManagedCommandChatSession({
        epicId: EPIC_ID,
        chatId: CHAT_ID,
        hostId: HOST_ID,
      });
      session.setCommands([
        managedCommandSchema.parse({
          id: "cmd-1",
          monitoring,
          description: "deploy watcher",
          command: "tail -f deploy.log",
          cwd: "/work/repo",
          cadence: { debounceMs: 500, maxWaitMs: 15_000, throttleMs: 5_000 },
          status: { state: "running", pid: 41, startedAtMs: 1 },
          chatId: CHAT_ID,
          createdAtMs: 1,
          updatedAtMs: 1,
        }),
      ]);
    }
    renderTabStripForTab(
      tab,
      {
        onClose: () => undefined,
        onPromotePreview: () => undefined,
        onOpenBlankTab: () => undefined,
        onSplit: undefined,
      },
      [],
    );
  }

  it("draws the shared shell glyph, following the live monitor flag", () => {
    renderShellTab(true);
    expect(document.querySelector("[data-monitor-icon='on']")).not.toBeNull();
  });

  it("draws the quiet glyph for a shell that is not watching", () => {
    renderShellTab(false);
    expect(document.querySelector("[data-monitor-icon='off']")).not.toBeNull();
  });

  it("falls back to the quiet glyph when the owning chat has no live session", () => {
    // A restored tab whose chat was never opened resolves to no record. A
    // watcher announces itself the moment its record lands; guessing "on"
    // meanwhile would be the strip inventing state.
    renderShellTab(null);
    expect(document.querySelector("[data-monitor-icon='off']")).not.toBeNull();
  });

  it("ignores a same-id shell living on another host", () => {
    // A cross-host clone keeps the source transcript's command ids. The tab is
    // bound to its own host for life, so a watching shell of the same id over
    // on the source host must not lend this tab its glyph - the tab cannot
    // open that shell's output at all.
    const session = installManagedCommandChatSession({
      epicId: EPIC_ID,
      chatId: CHAT_ID,
      hostId: "host-source",
    });
    session.setCommands([
      managedCommandSchema.parse({
        id: "cmd-1",
        monitoring: true,
        description: "deploy watcher",
        command: "tail -f deploy.log",
        cwd: "/work/repo",
        cadence: { debounceMs: 500, maxWaitMs: 15_000, throttleMs: 5_000 },
        status: { state: "running", pid: 41, startedAtMs: 1 },
        chatId: CHAT_ID,
        createdAtMs: 1,
        updatedAtMs: 1,
      }),
    ]);
    renderTabStripForTab(
      makeManagedCommandOutputTileRef({ commandId: "cmd-1", hostId: HOST_ID }),
      {
        onClose: () => undefined,
        onPromotePreview: () => undefined,
        onOpenBlankTab: () => undefined,
        onSplit: undefined,
      },
      [],
    );

    expect(document.querySelector("[data-monitor-icon='on']")).toBeNull();
    expect(document.querySelector("[data-monitor-icon='off']")).not.toBeNull();
    // ...and the title stays the tile's own name rather than the other host's
    // shell: the glyph and the name read the same lookup.
    expect(screen.queryByText("Monitor · deploy watcher")).toBeNull();
  });
});
