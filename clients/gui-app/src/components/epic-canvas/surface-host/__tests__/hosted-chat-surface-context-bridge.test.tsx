/**
 * Ticket 21 slice 4: pins the environment-to-context bridge for a hosted
 * chat. Scope note - `renderTile` is swapped for a test probe that reads the
 * bridged contexts and surfaces the `isActive` argument the bridge body
 * computed. The full real-`renderTile` path is exercised transitively by the
 * switch-ON ActiveTabBody routing tests; this file's job is narrowly "are
 * the contexts wired right + isActive mirrors ActiveTabBody".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { use } from "react";
import type { ReactNode } from "react";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import {
  pane,
  TEST_HOST_ID,
} from "@/stores/epics/canvas/__tests__/canvas-test-fixtures";
import { buildSyntheticTileSurfaceEnvironment } from "@/components/epic-canvas/surface-host/__tests__/synthetic-tile-surface-fixture";
import type { ReadyTileSurfaceEnvironment } from "@/components/epic-canvas/surface-host/tile-surface-environment-registry";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";
import { EpicViewTabContext } from "@/components/epic-canvas/view-tab-context";
import { useOpenEpicHandle } from "@/providers/use-open-epic-handle";
import { BrowserSessionsContext } from "@/components/epic-canvas/renderers/browser-sessions-context";
import { handleHostIds } from "@/lib/registries/epic-session-registry";
import { usePanePortalContainer } from "@/components/epic-tabs/pane-visibility-context";
import {
  usePaneActivationFocusIntent,
  type PaneActivationFocusIntent,
} from "@/components/epic-canvas/pane-activation";

const INSTANCE_ID = "chat-bridge-1";
const VIEW_TAB_ID = "view-tab-bridge";
const PANE_ID = "pane-bridge";
const EPIC_ID = "epic-bridge";

const CHAT_NODE = {
  id: INSTANCE_ID,
  instanceId: INSTANCE_ID,
  type: "chat" as const,
  name: "Bridge chat",
  hostId: TEST_HOST_ID,
};

const OPEN_EPIC_HANDLE =
  {} as ReadyTileSurfaceEnvironment["services"]["openEpicHandle"];
const HOST_CLIENT = {} as NonNullable<
  ReadyTileSurfaceEnvironment["services"]["hostClient"]
>;

interface CaptureState {
  lastIsActive: boolean | null;
  lastBrowserSessionsEpicId: string | null;
  lastBrowserSessionsHostClient: ReadyTileSurfaceEnvironment["services"]["hostClient"];
  lastBrowserSessionsHostId: string | null;
  lastViewTabId: string | null;
  lastOpenEpicHandle: OpenEpicStoreHandle | null;
  lastPanePortalContainer: HTMLElement | null;
  lastPaneActivationFocusIntent: PaneActivationFocusIntent | null;
}

const capture = vi.hoisted((): CaptureState => ({
  lastIsActive: null,
  lastBrowserSessionsEpicId: null,
  lastBrowserSessionsHostClient: null,
  lastBrowserSessionsHostId: null,
  lastViewTabId: null,
  lastOpenEpicHandle: null,
  lastPanePortalContainer: null,
  lastPaneActivationFocusIntent: null,
}));

interface PermissionRoleState {
  role: string | null;
}

const permissionRole = vi.hoisted((): PermissionRoleState => ({
  role: "owner",
}));

vi.mock("@/lib/epic-selectors", () => ({
  useEpicPermissionRole: () => permissionRole.role,
}));

vi.mock(
  "@/components/epic-canvas/renderers/browser-sessions-provider",
  async () => {
    const { createElement } = await import("react");
    const { BrowserSessionsContext: Context } =
      await import("@/components/epic-canvas/renderers/browser-sessions-context");
    return {
      BrowserSessionsHostProvider: (props: {
        readonly epicId: string;
        readonly hostClient: ReadyTileSurfaceEnvironment["services"]["hostClient"];
        readonly hostId: string | null;
        readonly children: ReactNode;
      }) => {
        capture.lastBrowserSessionsEpicId = props.epicId;
        capture.lastBrowserSessionsHostClient = props.hostClient;
        return createElement(
          Context.Provider,
          {
            value: {
              hostId: props.hostId,
              lifecycle: "live",
              inventoryReady: true,
              items: [],
              errorMessage: null,
              retry: () => undefined,
              openTab: () => Promise.reject(new Error("not used")),
              closeTab: () => Promise.resolve(),
            },
          },
          props.children,
        );
      },
    };
  },
);

vi.mock("@/components/epic-canvas/renderers/tile-render", () => ({
  renderTile: (args: {
    readonly isActive: boolean;
    readonly viewTabId: string;
  }): ReactNode => {
    capture.lastIsActive = args.isActive;
    // Probe lives under every context the bridge re-provides; reading them
    // here proves the provider wiring without mounting ChatTile.
    function Probe(): ReactNode {
      capture.lastBrowserSessionsHostId =
        use(BrowserSessionsContext)?.hostId ?? null;
      capture.lastViewTabId = use(EpicViewTabContext);
      capture.lastOpenEpicHandle = useOpenEpicHandle();
      capture.lastPanePortalContainer = usePanePortalContainer();
      capture.lastPaneActivationFocusIntent = usePaneActivationFocusIntent();
      return (
        <div
          data-testid="hosted-bridge-probe"
          data-is-active={args.isActive ? "true" : "false"}
          data-view-tab-id={args.viewTabId}
        />
      );
    }
    return <Probe />;
  },
}));

// Import AFTER the mocks so HostedChatSurfaceContextBridge picks them up.
import { HostedChatSurfaceContextBridge } from "@/components/epic-canvas/surface-host/hosted-chat-surface-context-bridge";

function seedChatTile(): void {
  useEpicCanvasStore.setState({
    tabsById: {
      [VIEW_TAB_ID]: {
        tabId: VIEW_TAB_ID,
        epicId: EPIC_ID,
        name: "Epic",
      },
    },
    canvasByTabId: {
      [VIEW_TAB_ID]: {
        root: pane(PANE_ID, [INSTANCE_ID]),
        activePaneId: PANE_ID,
        tilesByInstanceId: { [INSTANCE_ID]: CHAT_NODE },
        sizesByGroupId: {},
      },
    },
    openTabOrder: [VIEW_TAB_ID],
    activeTabId: VIEW_TAB_ID,
  });
}

function buildEnvironment(
  overrides: Partial<ReadyTileSurfaceEnvironment>,
): ReadyTileSurfaceEnvironment {
  return buildSyntheticTileSurfaceEnvironment(INSTANCE_ID, {
    identity: {
      instanceId: INSTANCE_ID,
      tileKind: "chat",
      contentId: INSTANCE_ID,
      epicId: EPIC_ID,
      hostId: TEST_HOST_ID,
    },
    placement: {
      epicId: EPIC_ID,
      viewTabId: VIEW_TAB_ID,
      paneId: PANE_ID,
      hostId: TEST_HOST_ID,
    },
    services: {
      openEpicHandle: OPEN_EPIC_HANDLE,
      hostClient: HOST_CLIENT,
      geometryAnchorElement: document.createElement("div"),
      panePortalContainer: null,
      isPaneFocusedNow: () => false,
    },
    ...overrides,
  });
}

function resetCapture(): void {
  capture.lastIsActive = null;
  capture.lastBrowserSessionsEpicId = null;
  capture.lastBrowserSessionsHostClient = null;
  capture.lastBrowserSessionsHostId = null;
  capture.lastViewTabId = null;
  capture.lastOpenEpicHandle = null;
  capture.lastPanePortalContainer = null;
  capture.lastPaneActivationFocusIntent = null;
  permissionRole.role = "owner";
}

describe("HostedChatSurfaceContextBridge", () => {
  beforeEach(() => {
    resetCapture();
    handleHostIds.set(OPEN_EPIC_HANDLE, TEST_HOST_ID);
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    seedChatTile();
  });
  afterEach(() => {
    cleanup();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    handleHostIds.delete(OPEN_EPIC_HANDLE);
    resetCapture();
  });

  it("re-provides EpicViewTabContext from environment.placement.viewTabId", () => {
    const environment = buildEnvironment({
      canvasActivity: { tabSelected: true, canvasPaneActive: true },
    });
    render(<HostedChatSurfaceContextBridge environment={environment} />);

    expect(screen.getByTestId("hosted-bridge-probe")).not.toBeNull();
    expect(capture.lastViewTabId).toBe(VIEW_TAB_ID);
    expect(
      screen
        .getByTestId("hosted-bridge-probe")
        .getAttribute("data-view-tab-id"),
    ).toBe(VIEW_TAB_ID);
  });

  it("provides browser sessions to the hosted chat render root", () => {
    const environment = buildEnvironment({
      canvasActivity: { tabSelected: true, canvasPaneActive: true },
    });
    render(<HostedChatSurfaceContextBridge environment={environment} />);

    expect(capture.lastBrowserSessionsEpicId).toBe(EPIC_ID);
    expect(capture.lastBrowserSessionsHostClient).toBe(HOST_CLIENT);
    expect(capture.lastBrowserSessionsHostId).toBe(TEST_HOST_ID);
  });

  it("re-provides the SAME openEpicHandle object reference (no second EpicSessionProvider)", () => {
    const environment = buildEnvironment({
      canvasActivity: { tabSelected: true, canvasPaneActive: true },
    });
    render(<HostedChatSurfaceContextBridge environment={environment} />);

    expect(capture.lastOpenEpicHandle).toBe(OPEN_EPIC_HANDLE);
    expect(capture.lastOpenEpicHandle).toBe(
      environment.services.openEpicHandle,
    );
  });

  it("re-provides the exact pane activation focus intent from its environment", () => {
    const focusIntent: PaneActivationFocusIntent = {
      mark: vi.fn(),
      shouldYieldAutoFocus: () => true,
    };
    const environment = {
      ...buildEnvironment({
        canvasActivity: { tabSelected: true, canvasPaneActive: true },
      }),
      paneActivation: { focusIntent },
    };
    render(<HostedChatSurfaceContextBridge environment={environment} />);

    expect(capture.lastPaneActivationFocusIntent).toBe(focusIntent);
    expect(capture.lastPaneActivationFocusIntent?.shouldYieldAutoFocus()).toBe(
      true,
    );
  });

  it("computes isActive = role!==null && tabSelected && canvasPaneActive (true case)", () => {
    permissionRole.role = "owner";
    const environment = buildEnvironment({
      canvasActivity: { tabSelected: true, canvasPaneActive: true },
    });
    render(<HostedChatSurfaceContextBridge environment={environment} />);

    expect(capture.lastIsActive).toBe(true);
    expect(
      screen.getByTestId("hosted-bridge-probe").getAttribute("data-is-active"),
    ).toBe("true");
  });

  it("computes isActive = false when canvasPaneActive is false", () => {
    permissionRole.role = "owner";
    const environment = buildEnvironment({
      canvasActivity: { tabSelected: true, canvasPaneActive: false },
    });
    render(<HostedChatSurfaceContextBridge environment={environment} />);

    expect(capture.lastIsActive).toBe(false);
    expect(
      screen.getByTestId("hosted-bridge-probe").getAttribute("data-is-active"),
    ).toBe("false");
  });

  it("computes isActive = false when role is null", () => {
    permissionRole.role = null;
    const environment = buildEnvironment({
      canvasActivity: { tabSelected: true, canvasPaneActive: true },
    });
    render(<HostedChatSurfaceContextBridge environment={environment} />);

    expect(capture.lastIsActive).toBe(false);
  });

  it("design-review F5: re-provides the REAL panePortalContainer value, not the slot's own geometry anchor", () => {
    const realPortalHost = document.createElement("div");
    const geometryAnchor = document.createElement("div");
    const environment = buildEnvironment({
      canvasActivity: { tabSelected: true, canvasPaneActive: true },
      services: {
        openEpicHandle: OPEN_EPIC_HANDLE,
        hostClient: null,
        geometryAnchorElement: geometryAnchor,
        panePortalContainer: realPortalHost,
        isPaneFocusedNow: () => false,
      },
    });
    render(<HostedChatSurfaceContextBridge environment={environment} />);

    expect(capture.lastPanePortalContainer).toBe(realPortalHost);
    expect(capture.lastPanePortalContainer).not.toBe(geometryAnchor);
  });

  it("renders nothing when the canvas tile is missing from the store", () => {
    useEpicCanvasStore.setState({
      tabsById: {},
      canvasByTabId: {},
      openTabOrder: [],
      activeTabId: null,
    });
    const environment = buildEnvironment({
      canvasActivity: { tabSelected: true, canvasPaneActive: true },
    });
    render(<HostedChatSurfaceContextBridge environment={environment} />);

    expect(screen.queryByTestId("hosted-bridge-probe")).toBeNull();
    expect(capture.lastIsActive).toBeNull();
  });
});
