import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { CanonicalTerminalSessionInfo } from "@traycer/protocol/host/terminal/unary-schemas";
import type { PlainTerminalProjection } from "@traycer/protocol/host/terminal/plain-schemas";
import type { PlainTerminalCollection } from "@/lib/terminals/plain-terminal-authority";
import {
  landingTerminalLayoutFor,
  useLandingTerminalStore,
} from "@/stores/home/landing-terminal-store";
import {
  landingTerminalRightActionsKey,
  useMobileHeaderStore,
} from "@/stores/layout/mobile-header-store";
import { useMobileHeaderRightActions } from "@/stores/layout/mobile-header-right-actions";
import { registerComposerFocus } from "@/lib/composer/composer-focus-registry";
import {
  handlePrimaryFocusIn,
  reconcilePrimaryFocus,
  resetPrimaryFocusCoordinatorForTests,
  setPrimaryFocusInteractionActive,
} from "@/lib/focus/primary-focus-coordinator";
import {
  registerTerminalFocus,
  resetTerminalFocusRegistryForTests,
} from "@/lib/terminals/terminal-focus-registry";
import {
  dispatchAction,
  matchDigitAction,
  type KeybindingRouter,
} from "@/lib/keybindings/dispatch";
import { pointerEvent } from "@/components/epic-canvas/canvas/__tests__/test-pointer-events";
import { setSystemTabModalApi } from "@/stores/tabs/system-tab-modal-bridge";
import type { SystemTabModalApi } from "@/stores/tabs/use-system-tab-modal";
import { useTabsStore } from "@/stores/tabs/store";
import type { StripItem, TabStripItem } from "@/stores/tabs/layout";

type TerminalListFixture = {
  readonly sessions: ReadonlyArray<CanonicalTerminalSessionInfo>;
  readonly homeCwd: string | null;
};

const mocks = vi.hoisted(() => {
  const initialPlainAuthorityStatus = (): "legacy" | "capable" | "unknown" =>
    "legacy";
  let plainCollection: PlainTerminalCollection | undefined;
  // Per-host authority overrides for tests that need a MIX of readiness across
  // hosts in one render (e.g. "Close All" spanning a ready host and a not-ready
  // one). A host absent from either map falls back to the two globals below, so
  // every existing single-authority test is unaffected.
  //
  // Declared and annotated here rather than asserted on the literal below: the
  // lint rule that bans `as` on an object literal auto-strips such a cast, and
  // a bare `{}` then infers a type whose index access is an error type.
  // `Partial<Record<…>>` also mirrors the production shape these stand in for
  // (`LandingTerminalAuthorityEntries`) and is what makes the `??` well-typed.
  const plainAuthorityStatusByHost: Partial<
    Record<string, "legacy" | "capable" | "unknown">
  > = {};
  const plainCanMutateByHost: Partial<Record<string, boolean>> = {};
  return {
    // React reactive host (useAddressableHostId) vs client host (getActiveHostId).
    // Kept in lockstep for ordinary tests; the host-switch race test diverges them.
    activeHostId: null as string | null,
    // The COMPOSER placement's resolved host (the window pin). Follows
    // `activeHostId` unless a test sets it, so one arm can make the two differ.
    placementHostId: null as string | null,
    clientActiveHostId: null as string | null,
    probeData: undefined as TerminalListFixture | undefined,
    freshProbeData: undefined as TerminalListFixture | undefined,
    probeError: null,
    dataUpdatedAt: 1,
    primaryWorkspacePath: null as string | null,
    isMobile: false,
    workspacePaths: [] as ReadonlyArray<string>,
    mutableWorkspacePaths: [] as string[],
    kill: vi.fn(),
    killAsync: vi.fn(() => Promise.resolve({ killed: true })),
    plainAuthorityStatus: initialPlainAuthorityStatus(),
    plainCanMutate: false,
    plainAuthorityStatusByHost,
    plainCanMutateByHost,
    plainCollection,
    plainCreateAsync: vi.fn(),
    plainEnsureAsync: vi.fn(),
    plainRename: vi.fn(),
    plainCloseAsync: vi.fn(),
    plainImportAsync: vi.fn(),
    reconcileXtermHostAfterLayoutTransition: vi.fn(),
    queryClient: {
      cancelQueries: vi.fn(() => Promise.resolve()),
      fetchQuery: vi.fn(),
      getQueryData: vi.fn(() => mocks.plainCollection),
    },
    onChangeListeners: [] as Array<
      (event: {
        readonly previousHostId: string | null;
        readonly currentHostId: string | null;
        readonly reason: string;
      }) => void
    >,
    // The connection registry's per-host row signal. The panel used to be told
    // "this host's transport moved" by the active slot's `host-updated` event;
    // P4.2 deleted the slot, and the registry reports the same move per host.
    rowChangedListeners: [] as Array<{
      readonly hostId: string;
      readonly listener: () => void;
    }>,
    defaultClient: {
      getActiveHostId: () => mocks.clientActiveHostId,
      onChange: (
        listener: (event: {
          readonly previousHostId: string | null;
          readonly currentHostId: string | null;
          readonly reason: string;
        }) => void,
      ) => {
        mocks.onChangeListeners.push(listener);
        return () => {
          mocks.onChangeListeners = mocks.onChangeListeners.filter(
            (entry) => entry !== listener,
          );
        };
      },
    },
    buildTransientHostClient: vi.fn<
      (
        client: unknown,
        entry: { readonly hostId: string },
      ) => { getActiveHostId: () => string; onChange: () => () => void } | null
    >((_client, entry) => ({
      getActiveHostId: () => entry.hostId,
      onChange: () => () => undefined,
    })),
  };
});

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQueryClient: () => mocks.queryClient,
  };
});
vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => mocks.activeHostId,
}));
// The gesture provider resolves the COMPOSER'S placement (the window's surface
// pin ?? effective), not the app-wide host, so the landing terminals and the
// composer beside them describe one machine. Mocked at its seam with the same
// `mocks.activeHostId` / `mocks.defaultClient` the rest of this suite drives.
vi.mock("@/hooks/host/use-composer-placement", () => ({
  useComposerPlacement: () => {
    const resolvedHostId = mocks.placementHostId ?? mocks.activeHostId;
    const target = {
      resolvedHostId,
      client: mocks.defaultClient,
      hostLabel: null,
      isPinned: false,
      namedHostDead: false,
    };
    return {
      pin: {
        selection: null,
        honoredSelection: null,
        resolvedHostId,
        isPinned: false,
        setSelection: () => undefined,
        latchOnFirstUse: () => undefined,
      },
      target,
      submitTarget: target,
      hostLabelFor: () => null,
      followsEffective: true,
    };
  },
}));
// Partial, not whole-module: the registry also owns `acquireHostConnection`
// and the equality helpers, and replacing the module wholesale would strand
// whatever else in this graph reaches for them.
vi.mock(
  "@traycer-clients/shared/host-client/host-connection-registry",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-client/host-connection-registry")
      >();
    return {
      ...actual,
      subscribeHostRowChanged: (hostId: string, listener: () => void) => {
        const entry = { hostId, listener };
        mocks.rowChangedListeners.push(entry);
        return () => {
          mocks.rowChangedListeners = mocks.rowChangedListeners.filter(
            (candidate) => candidate !== entry,
          );
        };
      },
    };
  },
);
vi.mock("@/hooks/terminal/use-terminal-list-for-query", () => ({
  useTerminalListFor: () => ({
    data: mocks.probeData,
    error: mocks.probeError,
    dataUpdatedAt: mocks.dataUpdatedAt,
  }),
}));
vi.mock("@/lib/host", () => ({
  useHostClient: () => mocks.defaultClient,
  // The SPINE, a separate export since redesign P2.1.
  useHostRuntimeClient: () => mocks.defaultClient,
  useHostDirectory: () => ({
    findById: (hostId: string) => ({ hostId, websocketUrl: "ws://test" }),
  }),
}));
vi.mock("@/hooks/host/use-host-client-for", () => ({
  buildTransientHostClient: mocks.buildTransientHostClient,
}));
// jsdom reports a desktop width, so this only makes the default explicit -
// the phone case flips it per test.
vi.mock("@/hooks/ui/use-mobile-viewport", () => ({
  useIsMobileViewport: () => mocks.isMobile,
  isMobileViewport: () => mocks.isMobile,
}));
vi.mock(
  "@/components/home/host-workspace-selector/use-home-workspace-source",
  () => ({
    useHomeWorkspaceSource: (key: {
      readonly surface: string;
      readonly draftId: string | null;
    }) => ({
      primaryWorkspacePath: mocks.primaryWorkspacePath,
      folders: mocks.workspacePaths,
      // Tag the source with the draft it was keyed by so a test can assert the
      // provider keys it to the CAPTURED draft while a gesture pins.
      draftId: key.surface === "landing" ? key.draftId : null,
    }),
  }),
);
vi.mock(
  "@/components/home/terminal-panel/use-landing-terminal-kill-mutation",
  () => ({
    useLandingTerminalKill: () => ({
      mutate: mocks.kill,
      mutateAsync: mocks.killAsync,
    }),
  }),
);
vi.mock(
  "@/components/home/terminal-panel/landing-terminal-authority-fleet",
  async () => {
    const { useEffect } = await import("react");
    return {
      LandingTerminalAuthorityFleet: (props: {
        readonly hostIds: readonly string[];
        readonly onEntry: (hostId: string, entry: unknown) => void;
      }) => {
        const { onEntry } = props;
        const hostKey = props.hostIds.join("\u0000");
        useEffect(() => {
          const hostIds = hostKey.length === 0 ? [] : hostKey.split("\u0000");
          hostIds.forEach((hostId) => {
            const status =
              mocks.plainAuthorityStatusByHost[hostId] ??
              mocks.plainAuthorityStatus;
            const canMutate =
              mocks.plainCanMutateByHost[hostId] ?? mocks.plainCanMutate;
            onEntry(hostId, {
              authority: {
                hostId,
                scope: { kind: "independent" },
                capability:
                  status === "capable"
                    ? {
                        status: "capable",
                        schemaVersion: { major: 1, minor: 0 },
                      }
                    : { status },
                collection: mocks.plainCollection,
                terminals: [],
                canMutate,
                query: {},
              },
              mutations: {
                create: { mutateAsync: mocks.plainCreateAsync },
                ensureRunning: { mutateAsync: mocks.plainEnsureAsync },
                rename: { mutate: mocks.plainRename },
                close: { mutateAsync: mocks.plainCloseAsync },
                importLegacy: { mutateAsync: mocks.plainImportAsync },
              },
            });
          });
          return () => {
            hostIds.forEach((hostId) => onEntry(hostId, null));
          };
        }, [hostKey, onEntry]);
        return null;
      },
    };
  },
);
vi.mock("@/components/home/terminal-panel/landing-terminal-tile", () => ({
  LandingTerminalTile: () => (
    <div data-testid="landing-terminal-tile">Starting terminal…</div>
  ),
}));
vi.mock("@/components/epic-canvas/renderers/xterm-host-registry", () => ({
  reconcileXtermHostAfterLayoutTransition:
    mocks.reconcileXtermHostAfterLayoutTransition,
}));

import { LandingTerminalPanel } from "@/components/home/terminal-panel/landing-terminal-panel";
import { LandingTerminalGestureProvider } from "@/components/home/terminal-panel/landing-terminal-gesture-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { requestLandingTerminalClose } from "@/lib/terminals/landing-terminal-close-coordinator";

const TEST_LANDING_PAGE_ID = "test-landing-page";

function testLayout() {
  return landingTerminalLayoutFor(
    useLandingTerminalStore.getState(),
    TEST_LANDING_PAGE_ID,
  );
}

function layoutFor(landingPageId: string) {
  return landingTerminalLayoutFor(
    useLandingTerminalStore.getState(),
    landingPageId,
  );
}

/**
 * The app mounts one `TooltipProvider` at the root; the strip's disabled "+"
 * tooltip needs it, so every render goes through this wrapper. The gesture
 * provider (the single live-value reader) wraps the panel exactly as
 * `LandingTerminalHost` does in production; `draftId` models the focused draft
 * the host projects, so a rerender with a new `draftId` models a focus switch.
 */
function panelUi() {
  return panelUiForDraft(TEST_LANDING_PAGE_ID);
}

function panelUiForDraft(draftId: string | null) {
  return (
    <TooltipProvider>
      <LandingTerminalGestureProvider draftId={draftId}>
        <LandingTerminalPanel />
      </LandingTerminalGestureProvider>
    </TooltipProvider>
  );
}

function panelUiInBoxlessPaneAnchor() {
  return (
    <TooltipProvider>
      <LandingTerminalGestureProvider draftId="draft-a">
        <div className="flex" data-testid="landing-terminal-layout-row">
          <div
            data-testid="landing-terminal-pane-anchor"
            style={{ display: "contents" }}
          >
            <LandingTerminalPanel />
          </div>
        </div>
      </LandingTerminalGestureProvider>
    </TooltipProvider>
  );
}

function runningSession(sessionId: string): CanonicalTerminalSessionInfo {
  return {
    sessionId,
    scope: { kind: "independent" },
    sessionKind: "terminal",
    cwd: "/workspace/project",
    shellCommand: "zsh",
    shellArgs: [],
    cols: 80,
    rows: 24,
    status: "running",
    exitCode: null,
    exitReason: null,
    createdAt: 1,
    title: null,
    activeProcessName: null,
  };
}

function emptyList(homeCwd: string | null): TerminalListFixture {
  return { sessions: [], homeCwd };
}

function listWith(
  sessions: ReadonlyArray<CanonicalTerminalSessionInfo>,
  homeCwd: string | null,
): TerminalListFixture {
  return { sessions, homeCwd };
}

function plainTerminal(input: {
  readonly terminalId: string;
  readonly manualTitle: string | null;
  readonly runtime: "running" | "dormant" | "unknown";
}): PlainTerminalProjection {
  return {
    record: {
      terminalId: input.terminalId,
      hostId: "host-a",
      scope: { kind: "independent" },
      launch: {
        cwd: "/host/launch",
        shellCommand: "/bin/zsh",
        shellArgs: ["-l"],
      },
      manualTitle: input.manualTitle,
      revision: 3,
      createdAt: "2026-08-16T10:00:00.000Z",
      updatedAt: "2026-08-16T10:01:00.000Z",
    },
    runtime:
      input.runtime === "running"
        ? {
            status: "running",
            sessionId: input.terminalId,
            currentCwd: "/host/live",
            activeProcessName: "vitest",
            cols: 100,
            rows: 30,
          }
        : { status: input.runtime },
  };
}

function freshPlainCollection(terminals: readonly PlainTerminalProjection[]) {
  return {
    terminalsByIdentity: Object.fromEntries(
      terminals.map((terminal) => [
        JSON.stringify([terminal.record.hostId, terminal.record.terminalId]),
        terminal,
      ]),
    ),
    deletedRevisionByIdentity: {},
    pendingPresentationDeletionRevisionByIdentity: {},
    coverage: "complete-local" as const,
    scope: { kind: "independent" as const },
    servingHostId: null,
    projectionSequence: 1,
    snapshotEpoch: 1,
    lastStreamSequenceByIdentity: {},
    streamStatus: "open" as const,
    streamCompatibility: "compatible" as const,
    streamSnapshotFresh: true,
  };
}

function fakeKeybindingRouter(): KeybindingRouter {
  return {
    getPathname: () => "/",
    navigateHome: () => undefined,
    navigateSettings: () => undefined,
    navigateToEpic: () => undefined,
    navigateToEpicTab: () => undefined,
    navigateToEpicList: () => undefined,
    navigateSettingsSection: () => undefined,
    navigateToTabIntent: () => undefined,
    goBack: () => undefined,
    goForward: () => undefined,
    isHistoryNavAvailable: () => false,
    canGoBack: () => false,
    canGoForward: () => false,
  };
}

const openOverlayApi: SystemTabModalApi = {
  active: null,
  openSettings: () => undefined,
  openHistory: () => undefined,
  close: () => undefined,
  setSection: () => undefined,
  promoteToTab: () => undefined,
  isOverlayActive: () => true,
};

/** ⌘1-style event: `metaKey` counts as `mod` on every platform. */
function leaderDigitEvent(code: string): KeyboardEvent {
  return new KeyboardEvent("keydown", { code, metaKey: true });
}

/**
 * Resolves every deferred `fetchQuery` a reconciliation generation issues,
 * repeatedly: a generation only calls `fetchQuery` after an internal await, so
 * a single splice would race it and leave the live generation hanging. Each
 * pass yields a macrotask so continuations (including newly started
 * generations) run before the next drain.
 */
async function drainDeferredListFetches(
  resolvers: Array<(value: unknown) => void>,
): Promise<void> {
  await act(async () => {
    for (let pass = 0; pass < 10; pass += 1) {
      resolvers.splice(0).forEach((resolve) => {
        resolve(emptyList("/Users/dev"));
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

async function flushAnimationFrame(): Promise<void> {
  await act(
    () =>
      new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => resolve());
      }),
  );
}

function testRect(width: number, height: number, left: number): DOMRect {
  return {
    x: left,
    y: 0,
    width,
    height,
    top: 0,
    right: left + width,
    bottom: height,
    left,
    toJSON: () => ({}),
  };
}

/**
 * Stands in for MobileAppHeader: renders what the header would resolve for the
 * presented surface, so these cases exercise the same read path the real
 * header uses - registration alone puts nothing on screen.
 */
function MobileHeaderSlotProbe() {
  return <>{useMobileHeaderRightActions()}</>;
}

// The panel outlives its start page's activation, so several behaviors now
// depend on which top-level surface owns the screen. Default layout = a start
// page is active, which is what every other case in this file assumes.
const PANEL_DRAFT_TAB: TabStripItem = {
  kind: "tab",
  id: "item-draft-a",
  ref: { kind: "draft", id: TEST_LANDING_PAGE_ID },
};
const PANEL_EPIC_TAB: TabStripItem = {
  kind: "tab",
  id: "item-epic-a",
  ref: { kind: "epic", id: "epic-a" },
};
const INITIAL_TABS_LAYOUT = {
  items: useTabsStore.getState().items,
  activeItemId: useTabsStore.getState().activeItemId,
};

function seedTabsLayout(
  items: ReadonlyArray<StripItem>,
  activeItemId: string,
): void {
  useTabsStore.setState({ items, activeItemId });
}

describe("<LandingTerminalPanel />", () => {
  const focusCleanups: Array<() => void> = [];

  beforeEach(() => {
    resetPrimaryFocusCoordinatorForTests();
    resetTerminalFocusRegistryForTests();
    mocks.activeHostId = null;
    mocks.placementHostId = null;
    mocks.clientActiveHostId = null;
    mocks.onChangeListeners = [];
    mocks.rowChangedListeners = [];
    mocks.probeData = undefined;
    mocks.freshProbeData = undefined;
    mocks.probeError = null;
    mocks.dataUpdatedAt = 1;
    mocks.primaryWorkspacePath = null;
    mocks.isMobile = false;
    mocks.workspacePaths = [];
    mocks.mutableWorkspacePaths = [];
    mocks.kill.mockReset();
    mocks.killAsync.mockClear();
    mocks.plainAuthorityStatus = "legacy";
    mocks.plainCanMutate = false;
    mocks.plainAuthorityStatusByHost = {};
    mocks.plainCanMutateByHost = {};
    mocks.plainCollection = undefined;
    mocks.plainCreateAsync.mockReset();
    mocks.plainEnsureAsync.mockReset();
    mocks.plainRename.mockReset();
    mocks.plainCloseAsync.mockReset();
    mocks.plainImportAsync.mockReset();
    mocks.plainCreateAsync.mockImplementation(() => Promise.resolve());
    mocks.plainEnsureAsync.mockImplementation(() => Promise.resolve());
    mocks.plainCloseAsync.mockImplementation(() => Promise.resolve());
    mocks.plainImportAsync.mockImplementation(() =>
      Promise.reject(new Error("unexpected legacy import")),
    );
    // Reset (not just clear): a test may override the return with a fail-closed
    // `null`, and mockClear would leak that override into later tests. Restore
    // the default host-pinned client here.
    mocks.buildTransientHostClient.mockReset();
    mocks.buildTransientHostClient.mockImplementation(
      (_client: unknown, entry: { readonly hostId: string }) => ({
        getActiveHostId: () => entry.hostId,
        onChange: () => () => undefined,
      }),
    );
    mocks.reconcileXtermHostAfterLayoutTransition.mockClear();
    mocks.queryClient.cancelQueries.mockClear();
    mocks.queryClient.fetchQuery.mockReset();
    mocks.queryClient.getQueryData.mockClear();
    mocks.queryClient.fetchQuery.mockImplementation(() =>
      Promise.resolve(mocks.freshProbeData ?? mocks.probeData),
    );
    useLandingTerminalStore.getState().resetForTests();
  });

  afterEach(() => {
    cleanup();
    useMobileHeaderStore.setState({ rightActionEntries: new Map() });
    focusCleanups.forEach((unregister) => unregister());
    focusCleanups.length = 0;
    resetTerminalFocusRegistryForTests();
    resetPrimaryFocusCoordinatorForTests();
    useLandingTerminalStore.getState().resetForTests();
    setSystemTabModalApi(null);
    useTabsStore.setState(INITIAL_TABS_LAYOUT);
  });

  describe("at phone width", () => {
    beforeEach(() => {
      mocks.isMobile = true;
      mocks.activeHostId = "host-a";
      mocks.clientActiveHostId = "host-a";
      // The hosting start page is FOCUSED by default - resolution keys the
      // landing entry by the presented draft, so the probe (standing in for
      // the header) only renders the toggle while that page is on screen.
      seedTabsLayout([PANEL_DRAFT_TAB], PANEL_DRAFT_TAB.id);
      mocks.probeData = emptyList("/Users/dev");
    });

    it("registers the reveal toggle for the mobile header instead of floating it", async () => {
      render(panelUi());
      await waitFor(() => {
        expect(
          useMobileHeaderStore
            .getState()
            .rightActionEntries.get(
              landingTerminalRightActionsKey(TEST_LANDING_PAGE_ID),
            ),
        ).not.toBeUndefined();
      });

      // Nothing floating in the content area: the header slot owns it now.
      expect(screen.queryByTestId("landing-terminal-toggle")).toBeNull();
    });

    it("opens the panel from the slotted toggle", async () => {
      render(
        <>
          {panelUi()}
          <MobileHeaderSlotProbe />
        </>,
      );
      fireEvent.click(await screen.findByTestId("landing-terminal-toggle"));

      expect(testLayout().panelOpen).toBe(true);
    });

    // The overlay is absolute inside the PAGE container, so it never covers the
    // app header - collapse therefore belongs in the same slot rather than in a
    // panel bar stacked under a header that is still on screen.
    it("turns into collapse in the same slot while the panel is open", async () => {
      useLandingTerminalStore
        .getState()
        .setPanelOpen(TEST_LANDING_PAGE_ID, true);
      render(
        <>
          {panelUi()}
          <MobileHeaderSlotProbe />
        </>,
      );
      await screen.findByTestId("landing-terminal-panel");

      // One control, not two: the reveal icon is gone and the panel renders no
      // header row of its own at this width.
      expect(screen.queryByTestId("landing-terminal-toggle")).toBeNull();
      fireEvent.click(await screen.findByTestId("landing-terminal-collapse"));

      expect(testLayout().panelOpen).toBe(false);
    });

    it("renders no panel header row of its own", async () => {
      useLandingTerminalStore
        .getState()
        .setPanelOpen(TEST_LANDING_PAGE_ID, true);
      render(panelUi());
      await screen.findByTestId("landing-terminal-panel");

      // Collapse lives in the header slot, which this render does not mount.
      expect(screen.queryByTestId("landing-terminal-collapse")).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Maximize terminal panel" }),
      ).toBeNull();
    });

    it("unregisters its entry on unmount", async () => {
      const view = render(panelUi());
      await waitFor(() => {
        expect(
          useMobileHeaderStore
            .getState()
            .rightActionEntries.get(
              landingTerminalRightActionsKey(TEST_LANDING_PAGE_ID),
            ),
        ).not.toBeUndefined();
      });

      view.unmount();

      expect(useMobileHeaderStore.getState().rightActionEntries.size).toBe(0);
    });

    // The panel outlives its page's activation to keep its PTYs warm - it
    // stays mounted behind an epic tab, History or Settings - so being
    // mounted is not a claim on the header. The header belongs to the surface
    // on screen: the entry stays registered, and resolution keeps it off a
    // surface it does not act on.
    it("shows no toggle while another surface is presented", async () => {
      seedTabsLayout([PANEL_DRAFT_TAB, PANEL_EPIC_TAB], PANEL_EPIC_TAB.id);
      render(
        <>
          {panelUi()}
          <MobileHeaderSlotProbe />
        </>,
      );
      await screen.findByTestId("landing-terminal-panel");
      await waitFor(() => {
        expect(
          useMobileHeaderStore
            .getState()
            .rightActionEntries.get(
              landingTerminalRightActionsKey(TEST_LANDING_PAGE_ID),
            ),
        ).not.toBeUndefined();
      });

      expect(
        screen.queryByRole("button", { name: "Open terminal panel" }),
      ).toBeNull();
    });

    // The return leg of a launch round-trip: leaving for a task and coming
    // back re-presents a panel that never unmounted. Its long-lived
    // registration resolves again with no re-publish - the toggle must be
    // back on the start page.
    it("shows the toggle again when the landing surface is presented again", async () => {
      seedTabsLayout([PANEL_DRAFT_TAB, PANEL_EPIC_TAB], PANEL_DRAFT_TAB.id);
      render(
        <>
          {panelUi()}
          <MobileHeaderSlotProbe />
        </>,
      );
      await screen.findByRole("button", { name: "Open terminal panel" });

      act(() => {
        seedTabsLayout([PANEL_DRAFT_TAB, PANEL_EPIC_TAB], PANEL_EPIC_TAB.id);
      });
      expect(
        screen.queryByRole("button", { name: "Open terminal panel" }),
      ).toBeNull();

      act(() => {
        seedTabsLayout([PANEL_DRAFT_TAB, PANEL_EPIC_TAB], PANEL_DRAFT_TAB.id);
      });
      expect(
        await screen.findByRole("button", { name: "Open terminal panel" }),
      ).not.toBeNull();
    });

    // Launching a task from this page replaces it with the epic it created,
    // and this panel is torn down a commit later than the epic's surface
    // registers: its existence follows the pane ANCHOR. A late teardown can
    // only remove the panel's OWN entry - the epic's stays for the header to
    // resolve.
    it("leaves another surface's entry alone when torn down afterwards", async () => {
      const view = render(panelUi());
      await waitFor(() => {
        expect(
          useMobileHeaderStore
            .getState()
            .rightActionEntries.get(
              landingTerminalRightActionsKey(TEST_LANDING_PAGE_ID),
            ),
        ).not.toBeUndefined();
      });

      const epicTrigger = <button type="button" data-testid="epic-claim" />;
      useMobileHeaderStore
        .getState()
        .registerRightActions("epic-tab:t1", epicTrigger);

      view.unmount();

      const entries = useMobileHeaderStore.getState().rightActionEntries;
      expect(entries.get("epic-tab:t1")).toBe(epicTrigger);
      expect(
        entries.has(landingTerminalRightActionsKey(TEST_LANDING_PAGE_ID)),
      ).toBe(false);
    });
  });

  it("hides while no host is selected, preserving an open panel until selection", async () => {
    useLandingTerminalStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    const view = render(panelUi());
    expect(screen.queryByTestId("landing-terminal-panel")).toBeNull();
    expect(screen.queryByTestId("landing-terminal-toggle")).toBeNull();
    expect(testLayout().panelOpen).toBe(true);

    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.probeData = emptyList("/Users/dev");
    mocks.dataUpdatedAt += 1;
    view.rerender(panelUi());

    await waitFor(() => {
      expect(screen.getByTestId("landing-terminal-panel")).toBeTruthy();
      expect(testLayout().panelOpen).toBe(true);
    });
  });

  it("shows exactly one collapse affordance while open, and the reveal one while closed", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = emptyList("/Users/dev");
    useLandingTerminalStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    // Open: the header owns collapse; the floating reveal button must be gone
    // or the two stack in the same corner.
    const collapse = await screen.findByTestId("landing-terminal-collapse");
    expect(screen.queryByTestId("landing-terminal-toggle")).toBeNull();

    fireEvent.click(collapse);

    // Collapsed: the panel keeps its (hidden) header mounted, so the reveal
    // button coming back is what proves the two never coexist on screen.
    await waitFor(() => {
      expect(testLayout().panelOpen).toBe(false);
      expect(screen.getByTestId("landing-terminal-toggle")).toBeTruthy();
      expect(screen.getByTestId("landing-terminal-panel").dataset.open).toBe(
        "false",
      );
    });
  });

  it("isolates collapsed state between landing pages", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    const view = render(panelUiForDraft("draft-b"));

    fireEvent.click(screen.getByTestId("landing-terminal-toggle"));
    await waitFor(() => {
      expect(screen.getByTestId("landing-terminal-panel").dataset.open).toBe(
        "true",
      );
    });

    view.rerender(panelUiForDraft("draft-a"));
    fireEvent.click(screen.getByTestId("landing-terminal-toggle"));
    await waitFor(() => {
      expect(screen.getByTestId("landing-terminal-panel").dataset.open).toBe(
        "true",
      );
    });
    fireEvent.click(screen.getByTestId("landing-terminal-collapse"));
    await waitFor(() => {
      expect(screen.getByTestId("landing-terminal-panel").dataset.open).toBe(
        "false",
      );
    });

    view.rerender(panelUiForDraft("draft-b"));
    expect(screen.getByTestId("landing-terminal-panel").dataset.open).toBe(
      "true",
    );
  });

  it("isolates resized width between landing pages", () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    const view = render(panelUiForDraft("draft-b"));

    fireEvent.click(screen.getByTestId("landing-terminal-toggle"));
    const resizeHandle = screen.getByTestId("landing-terminal-resize-handle");
    fireEvent.keyDown(resizeHandle, { key: "ArrowLeft" });
    expect(screen.getByTestId("landing-terminal-panel").style.width).toBe(
      "39%",
    );

    view.rerender(panelUiForDraft("draft-a"));
    expect(screen.getByTestId("landing-terminal-panel").style.width).toBe("0%");
    fireEvent.click(screen.getByTestId("landing-terminal-toggle"));
    expect(screen.getByTestId("landing-terminal-panel").style.width).toBe(
      "36%",
    );

    view.rerender(panelUiForDraft("draft-b"));
    expect(screen.getByTestId("landing-terminal-panel").style.width).toBe(
      "39%",
    );
  });

  it("isolates fullscreen state between landing pages", () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    const view = render(panelUiForDraft("draft-b"));

    fireEvent.click(screen.getByTestId("landing-terminal-toggle"));
    fireEvent.click(
      screen.getByRole("button", { name: "Maximize terminal panel" }),
    );
    expect(
      screen.getByRole("button", { name: "Restore terminal panel" }),
    ).toBeTruthy();

    view.rerender(panelUiForDraft("draft-a"));
    expect(
      screen.queryByRole("button", { name: "Restore terminal panel" }),
    ).toBeNull();

    view.rerender(panelUiForDraft("draft-b"));
    expect(
      screen.getByRole("button", { name: "Restore terminal panel" }),
    ).toBeTruthy();
  });

  it("resizes through the boxless split-pane portal anchor", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    useLandingTerminalStore.getState().setPanelOpen("draft-a", true);
    render(panelUiInBoxlessPaneAnchor());

    const handle = await screen.findByTestId("landing-terminal-resize-handle");
    const panel = screen.getByTestId("landing-terminal-panel");
    const layoutRow = screen.getByTestId("landing-terminal-layout-row");
    const paneAnchor = screen.getByTestId("landing-terminal-pane-anchor");
    expect(window.getComputedStyle(paneAnchor).display).toBe("contents");
    vi.spyOn(paneAnchor, "getBoundingClientRect").mockReturnValue(
      testRect(0, 0, 0),
    );
    vi.spyOn(layoutRow, "getBoundingClientRect").mockReturnValue(
      testRect(1_000, 800, 0),
    );
    vi.spyOn(panel, "getBoundingClientRect").mockReturnValue(
      testRect(360, 800, 640),
    );

    fireEvent(
      handle,
      pointerEvent("pointerdown", {
        pointerId: 7,
        clientX: 640,
        clientY: 10,
        button: 0,
      }),
    );
    fireEvent(
      handle,
      pointerEvent("pointermove", {
        pointerId: 7,
        clientX: 540,
        clientY: 10,
        button: 0,
      }),
    );

    expect(panel.style.width).toBe("46%");
    expect(layoutFor("draft-a").panelWidthFraction).toBe(0.36);

    fireEvent(
      handle,
      pointerEvent("pointerup", {
        pointerId: 7,
        clientX: 540,
        clientY: 10,
        button: 0,
      }),
    );
    expect(layoutFor("draft-a").panelWidthFraction).toBe(0.46);
  });

  it("auto-spawns in the host home when nothing is pinned", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = null;
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = emptyList("/Users/dev");
    useLandingTerminalStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    });
    expect(useLandingTerminalStore.getState().tabs[0]?.cwd).toBe("/Users/dev");
    expect(screen.queryByTestId("landing-terminal-select-folder")).toBeNull();
  });

  it("creates on the COMPOSER's placement host, not the app-wide one, when the two differ", async () => {
    // The landing page's composer, hero and folder picker all resolve the
    // window's surface pin; the terminal panel used to read the app-wide host
    // (`useAddressableHostId` / `useHostClient`), so a page pinned to host-b
    // listed, dialed and CREATED terminals on host-a - bound for life - under
    // a chip that said host-b, and its folder picker staged under
    // `{landing, host-a, draft}` beside the composer's `{landing, host-b, draft}`.
    mocks.activeHostId = "host-a";
    mocks.placementHostId = "host-b";
    mocks.clientActiveHostId = "host-b";
    mocks.primaryWorkspacePath = null;
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = emptyList("/Users/dev");
    useLandingTerminalStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    });
    expect(useLandingTerminalStore.getState().tabs[0]?.hostId).toBe("host-b");
  });

  it("holds an auto-spawn that settles while the start page is backgrounded, then spawns on return", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = null;
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = emptyList("/Users/dev");
    // Open the panel, then switch to the epic tab before `terminal.list`
    // settles. The panel used to UNMOUNT here, which aborted the pass; now it
    // survives, so the settlement has to gate itself - a terminal spawned into
    // a `display:none` pane cannot be measured and lands at the 80x24 fallback,
    // and the focus grab would pull the keyboard off the epic canvas.
    seedTabsLayout([PANEL_DRAFT_TAB, PANEL_EPIC_TAB], PANEL_EPIC_TAB.id);
    useLandingTerminalStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    // The fresh list is the last step before settlement, so waiting on it makes
    // "nothing spawned" an ordering claim rather than a race the test won.
    await waitFor(() => {
      expect(mocks.queryClient.fetchQuery).toHaveBeenCalled();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(useLandingTerminalStore.getState().tabs).toHaveLength(0);

    // Returning must still open the terminal the user asked for: the
    // reconciliation key is unchanged on the way back, so a settlement that was
    // DROPPED rather than held would never be recomputed and the panel would
    // sit empty forever.
    await act(async () => {
      seedTabsLayout([PANEL_DRAFT_TAB, PANEL_EPIC_TAB], PANEL_DRAFT_TAB.id);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    });
    expect(useLandingTerminalStore.getState().tabs[0]?.cwd).toBe("/Users/dev");
  });

  it("shows host update guidance when homeCwd is null and nothing is pinned", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = null;
    mocks.probeData = emptyList(null);
    mocks.freshProbeData = emptyList(null);
    useLandingTerminalStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    expect(
      await screen.findByTestId("landing-terminal-host-update"),
    ).toBeTruthy();
    expect(useLandingTerminalStore.getState().tabs).toHaveLength(0);
    expect(screen.queryByTestId("landing-terminal-select-folder")).toBeNull();
  });

  it("shows only the host connection state while an existing terminal waits for the probe", () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    useLandingTerminalStore.getState().addTab({
      instanceId: "tab-1",
      sessionId: "session-1",
      hostId: "host-a",
      cwd: "/workspace/project",
      name: "project",
      titleSource: "default",
    });
    useLandingTerminalStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);

    render(panelUi());

    expect(screen.getByRole("status").textContent).toBe(
      "Connecting to the selected host…",
    );
    expect(screen.queryByText("Starting terminal…")).toBeNull();
  });

  it("opens a terminal when the empty tab-strip space is double-clicked", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = emptyList("/Users/dev");
    useLandingTerminalStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    // Opening an empty panel auto-spawns exactly one terminal.
    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    });
    expect(useLandingTerminalStore.getState().tabs[0]?.name).toBe(
      "project · New Terminal",
    );

    fireEvent.doubleClick(screen.getByTestId("landing-terminal-tab-strip"));
    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(2);
    });

    // A double-click that lands on a tab activates it; it must not spawn.
    fireEvent.doubleClick(screen.getAllByRole("tab")[0]);
    expect(useLandingTerminalStore.getState().tabs).toHaveLength(2);
  });

  it("scrolls a newly created tab into view when it overflows the strip", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = emptyList("/Users/dev");
    useLandingTerminalStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    });

    const scrollIntoView = vi.spyOn(
      window.HTMLElement.prototype,
      "scrollIntoView",
    );
    fireEvent.click(screen.getByTestId("landing-terminal-new-tab"));

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(2);
    });

    const created = useLandingTerminalStore.getState().tabs[1];
    const createdEl = screen.getByTestId(
      `landing-terminal-tab-${created.instanceId}`,
    );
    // The tab that got scrolled must be the new (now active) one, not whatever
    // happened to be active before.
    expect(scrollIntoView.mock.instances).toContain(createdEl);
    scrollIntoView.mockRestore();
  });

  it("focuses the rename input as soon as the context menu commits", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = emptyList("/Users/dev");
    useLandingTerminalStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    });
    const tab = useLandingTerminalStore.getState().tabs[0];

    fireEvent.contextMenu(
      screen.getByTestId(`landing-terminal-tab-${tab.instanceId}`),
    );
    fireEvent.click(await screen.findByText("Rename"));

    // The input must be live AND focused without a second click - focusing
    // naively races the closing menu's focus-restore.
    const input = await screen.findByTestId(
      `landing-terminal-tab-input-${tab.instanceId}`,
    );
    await waitFor(() => {
      expect(document.activeElement).toBe(input);
    });

    fireEvent.change(input, { target: { value: "build" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs[0]?.name).toBe("build");
    });
  });

  it("renders capable-host title, foreground process, cwd, and dormant state from projections", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    mocks.plainAuthorityStatus = "capable";
    mocks.plainCanMutate = true;
    const running = plainTerminal({
      terminalId: "terminal-running",
      manualTitle: "Host title",
      runtime: "running",
    });
    const dormant = plainTerminal({
      terminalId: "terminal-dormant",
      manualTitle: null,
      runtime: "dormant",
    });
    mocks.plainCollection = freshPlainCollection([running, dormant]);
    useLandingTerminalStore.getState().addTab({
      instanceId: "running-instance",
      sessionId: "terminal-running",
      hostId: "host-a",
      cwd: "/stale",
      name: "Stale name",
      titleSource: "default",
      hostAuthorityAcknowledged: true,
    });
    useLandingTerminalStore.getState().addTab({
      instanceId: "dormant-instance",
      sessionId: "terminal-dormant",
      hostId: "host-a",
      cwd: "/stale",
      name: "Stale dormant",
      titleSource: "default",
      hostAuthorityAcknowledged: true,
    });
    useLandingTerminalStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    expect(await screen.findByText("Host title")).toBeTruthy();
    expect(
      screen.getByTestId("landing-terminal-process-running-instance")
        .textContent,
    ).toContain("vitest");
    expect(
      screen
        .getByTestId("landing-terminal-tab-running-instance")
        .getAttribute("aria-label"),
    ).toBe("Host title, /host/live");
    expect(
      screen.getByTestId("landing-terminal-dormant-dormant-instance"),
    ).toBeTruthy();
  });

  it("renders unknown runtime state as unavailable, not dormant", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    mocks.plainAuthorityStatus = "capable";
    mocks.plainCanMutate = true;
    mocks.plainCollection = freshPlainCollection([
      plainTerminal({
        terminalId: "terminal-unknown",
        manualTitle: null,
        runtime: "unknown",
      }),
    ]);
    useLandingTerminalStore.getState().addTab({
      instanceId: "unknown-instance",
      sessionId: "terminal-unknown",
      hostId: "host-a",
      cwd: "/stale",
      name: "Unknown runtime",
      titleSource: "default",
      hostAuthorityAcknowledged: true,
    });
    useLandingTerminalStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    expect(
      await screen.findByTestId(
        "landing-terminal-unavailable-unknown-instance",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByTestId("landing-terminal-dormant-unknown-instance"),
    ).toBeNull();
  });

  it("routes capable rename and close through shared mutations", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    mocks.plainAuthorityStatus = "capable";
    mocks.plainCanMutate = true;
    const projection = plainTerminal({
      terminalId: "terminal-shared",
      manualTitle: "Shared title",
      runtime: "running",
    });
    mocks.plainCollection = freshPlainCollection([projection]);
    const local = {
      instanceId: "shared-instance",
      sessionId: "terminal-shared",
      hostId: "host-a",
      cwd: "/legacy",
      name: "Legacy title",
      titleSource: "manual" as const,
      hostAuthorityAcknowledged: true,
    };
    useLandingTerminalStore.getState().addTab(local);
    useLandingTerminalStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    fireEvent.contextMenu(
      await screen.findByTestId("landing-terminal-tab-shared-instance"),
    );
    fireEvent.click(await screen.findByText("Rename"));
    const input = await screen.findByTestId(
      "landing-terminal-tab-input-shared-instance",
    );
    fireEvent.change(input, { target: { value: "Renamed everywhere" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(mocks.plainRename).toHaveBeenCalledWith({
      hostId: "host-a",
      terminalId: "terminal-shared",
      manualTitle: "Renamed everywhere",
    });
    expect(useLandingTerminalStore.getState().tabs[0]?.name).not.toBe(
      "Renamed everywhere",
    );

    fireEvent.click(screen.getByRole("button", { name: "Close Shared title" }));
    await waitFor(() => {
      expect(mocks.plainCloseAsync).toHaveBeenCalledWith({
        hostId: "host-a",
        terminalId: "terminal-shared",
      });
      expect(useLandingTerminalStore.getState().pendingKills).toEqual([]);
    });
    expect(mocks.kill).not.toHaveBeenCalled();
  });

  it("leaves the tombstone to the owner when its close merely joins one", async () => {
    // The close coordinator keys by the terminal's LIFETIME, not by RPC, so
    // this close can join an in-flight `terminal.kill` the recovery bridge
    // already sent. A kill answers an already-gone session with `killed: false`
    // as data, and for a `pendingCreate` record the kill mutation deliberately
    // KEEPS the tombstone - so a joiner that retired it here would overrule the
    // owner and strand the PTY the create is about to produce.
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    mocks.plainAuthorityStatus = "capable";
    mocks.plainCanMutate = true;
    const projection = plainTerminal({
      terminalId: "terminal-owned",
      manualTitle: "Owned title",
      runtime: "running",
    });
    mocks.plainCollection = freshPlainCollection([projection]);
    useLandingTerminalStore.getState().addTab({
      instanceId: "owned-instance",
      sessionId: "terminal-owned",
      hostId: "host-a",
      cwd: "/legacy",
      name: "Legacy title",
      titleSource: "manual" as const,
      hostAuthorityAcknowledged: true,
    });
    useLandingTerminalStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);

    // Another surface's request is already in flight for this lifetime, and it
    // settles without retiring the record.
    let releaseOwner = (): void => undefined;
    const ownerClose = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseOwner = resolve;
        }),
    );
    void requestLandingTerminalClose({
      hostId: "host-a",
      sessionId: "terminal-owned",
      close: ownerClose,
    });
    await waitFor(() => expect(ownerClose).toHaveBeenCalledTimes(1));

    render(panelUi());
    fireEvent.click(screen.getByRole("button", { name: "Close Owned title" }));
    await waitFor(() => {
      expect(useLandingTerminalStore.getState().pendingKills).toHaveLength(1);
    });
    releaseOwner();
    await waitFor(() => expect(ownerClose).toHaveBeenCalledTimes(1));

    // It joined rather than sending its own, and left the record alone.
    expect(mocks.plainCloseAsync).not.toHaveBeenCalled();
    expect(useLandingTerminalStore.getState().pendingKills).toHaveLength(1);
  });

  it("blocks capable-host create and rename, but still tombstones a close without dispatching, while authority is stale", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    mocks.plainAuthorityStatus = "capable";
    mocks.plainCanMutate = false;
    const projection = plainTerminal({
      terminalId: "terminal-stale",
      manualTitle: "Cached title",
      runtime: "running",
    });
    mocks.plainCollection = freshPlainCollection([projection]);
    const local = {
      instanceId: "stale-instance",
      sessionId: "terminal-stale",
      hostId: "host-a",
      cwd: "/legacy",
      name: "Legacy title",
      titleSource: "manual" as const,
      hostAuthorityAcknowledged: true,
    };
    useLandingTerminalStore.getState().addTab(local);
    useLandingTerminalStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    const plus = await screen.findByRole("button", { name: "New terminal" });
    expect(plus.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(plus);
    expect(useLandingTerminalStore.getState().tabs).toEqual([local]);

    // Rename gates on the same authority readiness create does - unlike
    // close, it has no durable fallback.
    fireEvent.contextMenu(
      screen.getByTestId("landing-terminal-tab-stale-instance"),
    );
    fireEvent.click(await screen.findByText("Rename"));
    expect(
      screen.queryByTestId("landing-terminal-tab-input-stale-instance"),
    ).toBeNull();

    // Close is deliberately NOT gated on authority readiness: the ×
    // affordance stays enabled, and clicking it still tombstones and
    // removes the tab even though this host cannot be asked right now. The
    // fast-path RPC dispatch is skipped - the tombstone recovery bridge
    // drains it once the host's authority becomes ready.
    const closeButton = screen.getByRole("button", {
      name: "Close Cached title",
    });
    expect(
      closeButton instanceof HTMLButtonElement && closeButton.disabled,
    ).toBe(false);
    fireEvent.click(closeButton);

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toEqual([]);
    });
    expect(useLandingTerminalStore.getState().pendingKills).toEqual([
      {
        hostId: "host-a",
        sessionId: "terminal-stale",
        hostAuthorityAcknowledged: true,
        pendingCreate: false,
      },
    ]);
    expect(mocks.plainCloseAsync).not.toHaveBeenCalled();
    expect(mocks.kill).not.toHaveBeenCalled();
  });

  it("tombstones and removes a tab without dispatching when the host's capability probe has not answered", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    mocks.plainAuthorityStatus = "unknown";
    const local = {
      instanceId: "unresolved-instance",
      sessionId: "terminal-unresolved",
      hostId: "host-a",
      cwd: "/workspace/project",
      name: "Unresolved title",
      titleSource: "default" as const,
    };
    useLandingTerminalStore.getState().addTab(local);
    useLandingTerminalStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    const closeButton = await screen.findByRole("button", {
      name: "Close Unresolved title",
    });
    expect(
      closeButton instanceof HTMLButtonElement && closeButton.disabled,
    ).toBe(false);
    fireEvent.click(closeButton);

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toEqual([]);
    });
    expect(useLandingTerminalStore.getState().pendingKills).toEqual([
      {
        hostId: "host-a",
        sessionId: "terminal-unresolved",
        hostAuthorityAcknowledged: false,
        pendingCreate: false,
      },
    ]);
    expect(mocks.plainCloseAsync).not.toHaveBeenCalled();
    expect(mocks.kill).not.toHaveBeenCalled();
  });

  it("enables the close button once a capable host's authority is ready", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    mocks.plainAuthorityStatus = "capable";
    mocks.plainCanMutate = true;
    const projection = plainTerminal({
      terminalId: "terminal-ready",
      manualTitle: "Ready title",
      runtime: "running",
    });
    mocks.plainCollection = freshPlainCollection([projection]);
    const local = {
      instanceId: "ready-instance",
      sessionId: "terminal-ready",
      hostId: "host-a",
      cwd: "/legacy",
      name: "Legacy title",
      titleSource: "manual" as const,
      hostAuthorityAcknowledged: true,
    };
    useLandingTerminalStore.getState().addTab(local);
    useLandingTerminalStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    const closeButton = await screen.findByRole("button", {
      name: "Close Ready title",
    });
    expect(
      closeButton instanceof HTMLButtonElement && closeButton.disabled,
    ).toBe(false);
  });

  it("blocks terminal creation while the host's capability probe is unresolved", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    mocks.plainAuthorityStatus = "unknown";
    useLandingTerminalStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());
    const router = fakeKeybindingRouter();

    const plus = await screen.findByRole("button", { name: "New terminal" });
    expect(plus.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(plus);
    // Bypasses the disabled "+" affordance: before the fix, every creation
    // path funneled into `addTerminalTab` without consulting the host's
    // authority readiness, so a chord could still persist a tab that looked
    // exactly like legacy import evidence for a terminal never created on any
    // host.
    act(() => {
      dispatchAction("tab.new", router);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(useLandingTerminalStore.getState().tabs).toHaveLength(0);
  });

  it("closes every terminal from the context menu, tombstoning before killing", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = emptyList("/Users/dev");
    useLandingTerminalStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    });
    fireEvent.click(screen.getByTestId("landing-terminal-new-tab"));
    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(2);
    });
    const before = useLandingTerminalStore.getState().tabs;

    fireEvent.contextMenu(
      screen.getByTestId(`landing-terminal-tab-${before[0].instanceId}`),
    );
    fireEvent.click(await screen.findByText("Close All"));

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(0);
    });
    expect(testLayout().panelOpen).toBe(false);
    // Every closed shell gets its own kill. (The tombstones they were written
    // with are drained by the reconciliation that follows, once the host list
    // confirms the sessions are gone - the durable write itself is pinned in
    // the store test.)
    // Dispatched through the shared close boundary, which hops a microtask.
    await waitFor(() => {
      before.forEach((tab) => {
        expect(mocks.killAsync).toHaveBeenCalledWith({
          hostId: tab.hostId,
          sessionId: tab.sessionId,
        });
      });
    });
  });

  it("closes every tab across a mix of ready and not-ready hosts, dispatching only for the ready one", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    mocks.plainAuthorityStatus = "capable";
    mocks.plainCanMutate = true;
    mocks.plainAuthorityStatusByHost = { "host-b": "capable" };
    mocks.plainCanMutateByHost = { "host-b": false };
    // The ready host's close hangs until resolved below, so the assertions
    // in between observe the tombstone-first write before either RPC has
    // had a chance to settle and clear it.
    let resolveReadyClose: (() => void) | null = null;
    mocks.plainCloseAsync.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveReadyClose = resolve;
        }),
    );
    const readyTab = {
      instanceId: "ready-instance",
      sessionId: "terminal-ready",
      hostId: "host-a",
      cwd: "/workspace/project",
      name: "Ready title",
      titleSource: "default" as const,
      hostAuthorityAcknowledged: true,
    };
    const notReadyTab = {
      instanceId: "not-ready-instance",
      sessionId: "terminal-not-ready",
      hostId: "host-b",
      cwd: "/workspace/other",
      name: "Not ready title",
      titleSource: "default" as const,
      hostAuthorityAcknowledged: true,
    };
    useLandingTerminalStore.getState().addTab(readyTab);
    useLandingTerminalStore.getState().addTab(notReadyTab);
    useLandingTerminalStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    await screen.findByTestId(`landing-terminal-tab-${readyTab.instanceId}`);
    await screen.findByTestId(`landing-terminal-tab-${notReadyTab.instanceId}`);

    fireEvent.contextMenu(
      screen.getByTestId(`landing-terminal-tab-${readyTab.instanceId}`),
    );
    fireEvent.click(await screen.findByText("Close All"));

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toEqual([]);
    });
    // Tombstone-first, batched: both refs are durably recorded - the
    // not-ready host's tombstone is the recovery bridge's only record that a
    // shell needs killing once that host becomes dialable.
    expect(useLandingTerminalStore.getState().pendingKills).toEqual(
      expect.arrayContaining([
        {
          hostId: "host-a",
          sessionId: "terminal-ready",
          hostAuthorityAcknowledged: true,
          pendingCreate: false,
        },
        {
          hostId: "host-b",
          sessionId: "terminal-not-ready",
          hostAuthorityAcknowledged: true,
          pendingCreate: false,
        },
      ]),
    );
    await waitFor(() => {
      expect(mocks.plainCloseAsync).toHaveBeenCalledWith({
        hostId: "host-a",
        terminalId: "terminal-ready",
      });
    });
    expect(mocks.plainCloseAsync).not.toHaveBeenCalledWith(
      expect.objectContaining({ hostId: "host-b" }),
    );
    expect(mocks.kill).not.toHaveBeenCalled();

    await act(async () => {
      resolveReadyClose?.();
      await Promise.resolve();
    });

    // Only the dispatched (ready-host) tombstone clears on acknowledgement;
    // the not-ready host's stays until the recovery bridge can ask it.
    await waitFor(() => {
      expect(useLandingTerminalStore.getState().pendingKills).toEqual([
        {
          hostId: "host-b",
          sessionId: "terminal-not-ready",
          hostAuthorityAcknowledged: true,
          pendingCreate: false,
        },
      ]);
    });
  });

  it("adopts the probe result before considering an auto-spawn", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = listWith([runningSession("orphan")], "/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    useLandingTerminalStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
      expect(useLandingTerminalStore.getState().tabs[0]?.sessionId).toBe(
        "orphan",
      );
    });
    expect(mocks.kill).not.toHaveBeenCalled();
    expect(mocks.queryClient.fetchQuery).toHaveBeenCalledTimes(1);
  });

  it("uses the fresh list to adopt an orphan before auto-spawn", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = listWith(
      [runningSession("fresh-orphan")],
      "/Users/dev",
    );
    useLandingTerminalStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
      expect(useLandingTerminalStore.getState().tabs[0]?.sessionId).toBe(
        "fresh-orphan",
      );
    });
  });

  it("does not clear a close tombstone from a stale empty list", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = listWith(
      [runningSession("still-running")],
      "/Users/dev",
    );
    useLandingTerminalStore.getState().addTab({
      instanceId: "tab-1",
      sessionId: "still-running",
      hostId: "host-a",
      cwd: "/workspace/project",
      name: "project",
      titleSource: "default",
    });
    useLandingTerminalStore.getState().closeTab(TEST_LANDING_PAGE_ID, "tab-1");
    useLandingTerminalStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    await waitFor(() => {
      expect(mocks.killAsync).toHaveBeenCalledWith({
        hostId: "host-a",
        sessionId: "still-running",
      });
    });
    expect(useLandingTerminalStore.getState().pendingKills).toEqual([
      {
        hostId: "host-a",
        sessionId: "still-running",
        hostAuthorityAcknowledged: false,
        pendingCreate: false,
      },
    ]);
  });

  it("leaves a live home terminal alone when a workspace becomes available", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    useLandingTerminalStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    const view = render(panelUi());

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    });
    const homeTab = useLandingTerminalStore.getState().tabs[0];
    expect(homeTab.cwd).toBe("/Users/dev");
    expect(mocks.queryClient.fetchQuery).toHaveBeenCalledTimes(1);

    // Attaching a folder must not spawn, switch, restart, or rewrite the live
    // home terminal. Future manual creates use the primary folder instead.
    mocks.primaryWorkspacePath = "/workspace/project";
    view.rerender(panelUi());

    await waitFor(() => {
      expect(mocks.queryClient.fetchQuery).toHaveBeenCalledTimes(2);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(useLandingTerminalStore.getState().tabs).toEqual([homeTab]);
    expect(useLandingTerminalStore.getState().activeInstanceId).toBe(
      homeTab.instanceId,
    );

    fireEvent.click(screen.getByTestId("landing-terminal-new-tab"));
    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(2);
    });
    const created = useLandingTerminalStore
      .getState()
      .tabs.find((tab) => tab.instanceId !== homeTab.instanceId);
    expect(created?.cwd).toBe("/workspace/project");
  });

  it("answers the epic tab chords: new, prev/next, and close", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    useLandingTerminalStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());
    const router = fakeKeybindingRouter();

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    });

    act(() => {
      dispatchAction("tab.new", router);
    });
    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(2);
    });
    const [first, second] = useLandingTerminalStore.getState().tabs;
    expect(useLandingTerminalStore.getState().activeInstanceId).toBe(
      second.instanceId,
    );

    act(() => {
      dispatchAction("tab.prev", router);
    });
    expect(useLandingTerminalStore.getState().activeInstanceId).toBe(
      first.instanceId,
    );
    act(() => {
      dispatchAction("tab.next", router);
    });
    expect(useLandingTerminalStore.getState().activeInstanceId).toBe(
      second.instanceId,
    );

    act(() => {
      dispatchAction("tab.close", router);
    });
    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    });
    expect(useLandingTerminalStore.getState().tabs[0].instanceId).toBe(
      first.instanceId,
    );
    await waitFor(() => {
      expect(mocks.killAsync).toHaveBeenCalledWith({
        hostId: second.hostId,
        sessionId: second.sessionId,
      });
    });
  });

  it("switches terminal tabs with the leader digit chord", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    useLandingTerminalStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    });
    fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(2);
    });
    const [first, second] = useLandingTerminalStore.getState().tabs;
    expect(useLandingTerminalStore.getState().activeInstanceId).toBe(
      second.instanceId,
    );

    const match = matchDigitAction(leaderDigitEvent("Digit1"));
    expect(match?.actionId).toBe("tab.switch.byDigit");
    act(() => {
      expect(match?.run()).toBe(true);
    });
    expect(useLandingTerminalStore.getState().activeInstanceId).toBe(
      first.instanceId,
    );

    // A digit past the last tab falls through instead of claiming the chord.
    const outOfRange = matchDigitAction(leaderDigitEvent("Digit9"));
    expect(outOfRange?.run()).toBe(false);
  });

  it("maximizes and restores via app.terminal.maximize, revealing when collapsed", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    useLandingTerminalStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());
    const router = fakeKeybindingRouter();

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    });
    expect(
      screen.queryByRole("button", { name: "Restore terminal panel" }),
    ).toBeNull();

    act(() => {
      dispatchAction("app.terminal.maximize", router);
    });
    expect(
      screen.queryByRole("button", { name: "Restore terminal panel" }),
    ).not.toBeNull();

    act(() => {
      dispatchAction("app.terminal.maximize", router);
    });
    expect(
      screen.queryByRole("button", { name: "Restore terminal panel" }),
    ).toBeNull();

    // Collapsed panel: the chord reveals and maximizes in one stroke.
    fireEvent.click(
      screen.getByRole("button", { name: "Collapse terminal panel" }),
    );
    expect(screen.getByTestId("landing-terminal-panel").dataset.open).toBe(
      "false",
    );
    act(() => {
      dispatchAction("app.terminal.maximize", router);
    });
    expect(screen.getByTestId("landing-terminal-panel").dataset.open).toBe(
      "true",
    );
    expect(
      screen.queryByRole("button", { name: "Restore terminal panel" }),
    ).not.toBeNull();
  });

  it("explains the disabled + button when an old host cannot report homeCwd", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = null;
    mocks.probeData = emptyList(null);
    mocks.freshProbeData = mocks.probeData;
    useLandingTerminalStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    await screen.findByTestId("landing-terminal-host-update");
    const plus = screen.getByRole("button", { name: "New terminal" });
    expect(plus.getAttribute("aria-disabled")).toBe("true");
    // aria-disabled instead of the native attr keeps it inert but reachable.
    fireEvent.click(plus);
    expect(useLandingTerminalStore.getState().tabs).toHaveLength(0);

    fireEvent.focus(plus);
    const hints = await screen.findAllByText(
      "Update the selected host to open a terminal without a folder.",
    );
    // At least the tooltip copy beyond the empty-state paragraph.
    expect(hints.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps the + button live with no tooltip once a folder is pinned", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    useLandingTerminalStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    });
    const plus = screen.getByRole("button", { name: "New terminal" });
    expect(plus.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(plus);
    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(2);
    });
  });

  it("holds the tab chords while the system-tab modal occludes the page", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    useLandingTerminalStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());
    const router = fakeKeybindingRouter();

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    });

    setSystemTabModalApi(openOverlayApi);
    act(() => {
      dispatchAction("tab.new", router);
      dispatchAction("tab.close", router);
      dispatchAction("tab.close-all", router);
    });
    expect(matchDigitAction(leaderDigitEvent("Digit1"))).toBeNull();
    expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    expect(mocks.kill).not.toHaveBeenCalled();
  });

  it("moves focus into the active terminal on expand and back to the composer on collapse", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    useLandingTerminalStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());
    const router = fakeKeybindingRouter();

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    });
    const tab = useLandingTerminalStore.getState().tabs[0];
    const terminalFocus = vi.fn();
    const composerFocus = vi.fn();
    focusCleanups.push(
      registerTerminalFocus(
        tab.instanceId,
        terminalFocus,
        () => true,
        () => true,
      ),
    );
    focusCleanups.push(
      registerComposerFocus(
        "test-composer-close-last",
        {
          focus: composerFocus,
          containsActiveElement: () => true,
          isEligible: () => true,
        },
        true,
      ),
    );

    act(() => {
      dispatchAction("app.terminal.toggle", router);
    });
    expect(testLayout().panelOpen).toBe(false);
    await waitFor(() => {
      expect(composerFocus).toHaveBeenCalled();
    });
    expect(terminalFocus).not.toHaveBeenCalled();

    act(() => {
      dispatchAction("app.terminal.toggle", router);
    });
    await waitFor(() => {
      expect(terminalFocus).toHaveBeenCalled();
    });
  });

  it("refits the active terminal after reopening from zero width to the stored panel width", async () => {
    mocks.activeHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = listWith([runningSession("session-1")], "/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    useLandingTerminalStore.getState().addTab({
      instanceId: "tab-1",
      sessionId: "session-1",
      hostId: "host-a",
      cwd: "/workspace/project",
      name: "project",
      titleSource: "default",
    });
    useLandingTerminalStore
      .getState()
      .setPanelWidthFraction(TEST_LANDING_PAGE_ID, 0.42);
    useLandingTerminalStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    const panel = screen.getByTestId("landing-terminal-panel");
    expect(panel.style.width).toBe("42%");
    await flushAnimationFrame();
    mocks.reconcileXtermHostAfterLayoutTransition.mockClear();

    fireEvent.click(screen.getByTestId("landing-terminal-collapse"));
    await waitFor(() => {
      expect(panel.style.width).toBe("0%");
    });
    fireEvent.transitionEnd(panel, { propertyName: "width" });
    expect(
      mocks.reconcileXtermHostAfterLayoutTransition,
    ).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("landing-terminal-toggle"));
    await waitFor(() => {
      expect(panel.style.width).toBe("42%");
    });
    expect(
      mocks.reconcileXtermHostAfterLayoutTransition,
    ).not.toHaveBeenCalled();

    fireEvent.transitionEnd(panel, { propertyName: "width" });
    await flushAnimationFrame();
    expect(
      mocks.reconcileXtermHostAfterLayoutTransition,
    ).toHaveBeenCalledOnce();
    expect(mocks.reconcileXtermHostAfterLayoutTransition).toHaveBeenCalledWith(
      "tab-1",
    );
  });

  it("refits a terminal activated by delayed reconciliation after the reveal transition", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/other";
    mocks.probeData = undefined;
    const sessions = [
      runningSession("session-1"),
      { ...runningSession("session-2"), cwd: "/workspace/other" },
    ];
    useLandingTerminalStore.getState().addTab({
      instanceId: "tab-1",
      sessionId: "session-1",
      hostId: "host-a",
      cwd: "/workspace/project",
      name: "project",
      titleSource: "default",
    });
    useLandingTerminalStore.getState().addTab({
      instanceId: "tab-2",
      sessionId: "session-2",
      hostId: "host-a",
      cwd: "/workspace/other",
      name: "other",
      titleSource: "default",
    });
    useLandingTerminalStore.getState().activateTab("tab-1");
    const resolvers: Array<(value: unknown) => void> = [];
    mocks.queryClient.fetchQuery.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const view = render(panelUi());

    fireEvent.click(screen.getByTestId("landing-terminal-toggle"));
    const panel = screen.getByTestId("landing-terminal-panel");
    fireEvent.transitionEnd(panel, { propertyName: "width" });
    await flushAnimationFrame();
    expect(mocks.reconcileXtermHostAfterLayoutTransition).toHaveBeenCalledWith(
      "tab-1",
    );
    mocks.reconcileXtermHostAfterLayoutTransition.mockClear();

    mocks.probeData = listWith(sessions, "/Users/dev");
    mocks.dataUpdatedAt += 1;
    view.rerender(panelUi());
    await waitFor(() => {
      expect(resolvers).toHaveLength(1);
    });
    const resolveFreshList = resolvers.shift();
    if (resolveFreshList === undefined) {
      throw new Error("Expected a deferred terminal list fetch");
    }
    await act(async () => {
      resolveFreshList(listWith(sessions, "/Users/dev"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().activeInstanceId).toBe("tab-2");
    });
    await waitFor(() => {
      expect(
        mocks.reconcileXtermHostAfterLayoutTransition,
      ).toHaveBeenCalledWith("tab-2");
    });
  });

  it("waits for an interrupted reveal drag to commit before refitting", async () => {
    mocks.activeHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = listWith([runningSession("session-1")], "/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    useLandingTerminalStore.getState().addTab({
      instanceId: "tab-1",
      sessionId: "session-1",
      hostId: "host-a",
      cwd: "/workspace/project",
      name: "project",
      titleSource: "default",
    });
    useLandingTerminalStore
      .getState()
      .setPanelWidthFraction(TEST_LANDING_PAGE_ID, 0.42);
    render(panelUi());

    fireEvent.click(screen.getByTestId("landing-terminal-toggle"));
    const panel = screen.getByTestId("landing-terminal-panel");
    const resizeHandle = screen.getByTestId("landing-terminal-resize-handle");
    const container = resizeHandle.parentElement;
    if (container === null) throw new Error("Expected the panel container");
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue(
      testRect(1_000, 800, 0),
    );
    vi.spyOn(panel, "getBoundingClientRect").mockReturnValue(
      testRect(420, 800, 580),
    );
    mocks.reconcileXtermHostAfterLayoutTransition.mockClear();

    fireEvent.pointerDown(resizeHandle, {
      button: 0,
      pointerId: 7,
      clientX: 580,
    });
    fireEvent.transitionCancel(panel, { propertyName: "width" });
    await flushAnimationFrame();
    expect(
      mocks.reconcileXtermHostAfterLayoutTransition,
    ).not.toHaveBeenCalled();

    fireEvent.pointerMove(resizeHandle, { pointerId: 7, clientX: 530 });
    fireEvent.pointerUp(resizeHandle, { pointerId: 7, clientX: 530 });
    expect(panel.style.width).toBe("47%");
    await waitFor(() => {
      expect(
        mocks.reconcileXtermHostAfterLayoutTransition,
      ).toHaveBeenCalledWith("tab-1");
    });
  });

  it("does not steal focus from the composer when mounting with the panel already open", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    useLandingTerminalStore.getState().addTab({
      instanceId: "tab-1",
      sessionId: "session-1",
      hostId: "host-a",
      cwd: "/workspace/project",
      name: "project",
      titleSource: "default",
    });
    useLandingTerminalStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    const terminalFocus = vi.fn();
    focusCleanups.push(
      registerTerminalFocus(
        "tab-1",
        terminalFocus,
        () => true,
        () => true,
      ),
    );

    render(panelUi());

    // Let the mount-time reconciliation generation settle fully, including
    // any deferred focus fulfilment the registry might have scheduled.
    await waitFor(() => {
      expect(mocks.queryClient.fetchQuery).toHaveBeenCalledTimes(1);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(terminalFocus).not.toHaveBeenCalled();
  });

  it("parks the focus request for a terminal spawned by expanding an empty panel", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    render(panelUi());
    const router = fakeKeybindingRouter();

    act(() => {
      dispatchAction("app.terminal.toggle", router);
    });
    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    });
    const created = useLandingTerminalStore.getState().tabs[0];

    // The auto-spawned tile's engine registers after the create - the parked
    // request must fire exactly then, not get lost.
    const terminalFocus = vi.fn();
    focusCleanups.push(
      registerTerminalFocus(
        created.instanceId,
        terminalFocus,
        () => true,
        () => true,
      ),
    );
    await waitFor(() => {
      expect(terminalFocus).toHaveBeenCalledTimes(1);
    });
  });

  it("parks tab-activation focus until the endpoint becomes eligible", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    useLandingTerminalStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    });
    fireEvent.click(screen.getByTestId("landing-terminal-new-tab"));
    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(2);
    });
    const [first] = useLandingTerminalStore.getState().tabs;
    const firstFocus = vi.fn();
    let firstEligible = true;
    focusCleanups.push(
      registerTerminalFocus(
        first.instanceId,
        firstFocus,
        () => true,
        () => firstEligible,
      ),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    firstFocus.mockClear();

    firstEligible = false;
    fireEvent.click(
      screen.getByTestId(`landing-terminal-tab-${first.instanceId}`),
    );
    expect(firstFocus).not.toHaveBeenCalled();
    act(() => {
      firstEligible = true;
      reconcilePrimaryFocus();
    });
    expect(firstFocus).toHaveBeenCalledTimes(1);
  });

  it("keeps an opening gesture on draft A when focus switches to draft B before terminal.list settles", async () => {
    mocks.activeHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/draft-a";
    mocks.probeData = emptyList(null);
    const resolvers: Array<(value: unknown) => void> = [];
    mocks.queryClient.fetchQuery.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const view = render(panelUiForDraft("draft-a"));
    const router = fakeKeybindingRouter();

    // The top-level host projects the focused draft into its one terminal host.
    // Focus moves to B while A's terminal.list generation is pending.
    act(() => {
      dispatchAction("app.terminal.toggle", router);
    });
    mocks.primaryWorkspacePath = "/workspace/draft-b";
    view.rerender(panelUiForDraft("draft-b"));
    await drainDeferredListFetches(resolvers);

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    });
    const [spawned] = useLandingTerminalStore.getState().tabs;
    expect(spawned.cwd).toBe("/workspace/draft-a");
    expect(useLandingTerminalStore.getState().activeInstanceId).toBe(
      spawned.instanceId,
    );
  });

  it("reconciles an exited terminal against the captured page after focus moves", async () => {
    mocks.activeHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/draft-a";
    mocks.probeData = emptyList(null);
    useLandingTerminalStore.getState().addTab({
      instanceId: "exited-tab",
      sessionId: "exited-session",
      hostId: "host-a",
      cwd: "/workspace/draft-a",
      name: "draft-a",
      titleSource: "default",
    });
    const resolvers: Array<(value: unknown) => void> = [];
    mocks.queryClient.fetchQuery.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const view = render(panelUiForDraft("draft-a"));
    const router = fakeKeybindingRouter();

    act(() => {
      dispatchAction("app.terminal.toggle", router);
      useLandingTerminalStore.getState().setPanelOpen("draft-b", true);
    });
    mocks.primaryWorkspacePath = "/workspace/draft-b";
    view.rerender(panelUiForDraft("draft-b"));

    await act(async () => {
      for (let pass = 0; pass < 10; pass += 1) {
        resolvers.splice(0).forEach((resolve) => {
          resolve(
            listWith(
              [
                {
                  ...runningSession("exited-session"),
                  status: "exited",
                  exitCode: 0,
                  exitReason: "process-exit",
                },
              ],
              "/Users/dev",
            ),
          );
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(0);
    });
    expect(layoutFor("draft-a").panelOpen).toBe(false);
    expect(layoutFor("draft-b").panelOpen).toBe(false);
  });

  it("preserves a folderless opening gesture when focus switches to a foldered draft", async () => {
    mocks.activeHostId = "host-a";
    mocks.primaryWorkspacePath = null;
    mocks.probeData = emptyList(null);
    const resolvers: Array<(value: unknown) => void> = [];
    mocks.queryClient.fetchQuery.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const view = render(panelUiForDraft("draft-a"));
    const router = fakeKeybindingRouter();

    act(() => {
      dispatchAction("app.terminal.toggle", router);
    });
    mocks.primaryWorkspacePath = "/workspace/draft-b";
    view.rerender(panelUiForDraft("draft-b"));
    await drainDeferredListFetches(resolvers);

    // A folderless gesture resolves to the settled host home (#567), never to
    // draft-b's folder - that folder only became focused AFTER the capture.
    const tabs = useLandingTerminalStore.getState().tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.cwd).toBe("/Users/dev");
  });

  it("reconciles through the host client captured at the opening gesture", async () => {
    mocks.activeHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/draft-a";
    mocks.probeData = emptyList(null);
    const resolvers: Array<(value: unknown) => void> = [];
    mocks.queryClient.fetchQuery.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const view = render(panelUiForDraft("draft-a"));
    const router = fakeKeybindingRouter();

    act(() => {
      dispatchAction("app.terminal.toggle", router);
    });
    mocks.activeHostId = "host-b";
    view.rerender(panelUiForDraft("draft-b"));
    await drainDeferredListFetches(resolvers);

    expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    expect(useLandingTerminalStore.getState().tabs[0]).toMatchObject({
      hostId: "host-a",
      cwd: "/workspace/draft-a",
    });
  });

  it("disables the create action when the host client cannot be pinned, never falling back to the default client", async () => {
    mocks.activeHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList(null);
    mocks.freshProbeData = mocks.probeData;
    // Directory churn / missing ws url: the transient client cannot be pinned.
    mocks.buildTransientHostClient.mockReturnValue(null);
    render(panelUiForDraft("draft-a"));
    const router = fakeKeybindingRouter();

    // Opening captures a gesture whose pinned client is null -> fail-closed.
    act(() => {
      dispatchAction("app.terminal.toggle", router);
    });

    const plus = await screen.findByRole("button", { name: "New terminal" });
    // Fail-closed: disabled, and NOT silently reconciling on the default client
    // (which would auto-spawn a terminal into the empty panel).
    expect(plus.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(plus);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(useLandingTerminalStore.getState().tabs).toHaveLength(0);
    expect(mocks.queryClient.fetchQuery).not.toHaveBeenCalled();
  });

  it("creates from the captured host's supported verdict when the live host becomes unavailable before terminal.list settles", async () => {
    mocks.activeHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/draft-a";
    mocks.probeData = emptyList(null);
    const resolvers: Array<(value: unknown) => void> = [];
    mocks.queryClient.fetchQuery.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const view = render(panelUiForDraft("draft-a"));
    const router = fakeKeybindingRouter();

    // Capture the gesture while host-a is supported...
    act(() => {
      dispatchAction("app.terminal.toggle", router);
    });
    // ...then the default host switches to host-b whose probe has not resolved,
    // so the LIVE availability is "unknown". The captured supported verdict must
    // still drive creation on host-a; the live host's verdict must not gate it.
    mocks.activeHostId = "host-b";
    mocks.probeData = undefined;
    view.rerender(panelUiForDraft("draft-b"));
    await drainDeferredListFetches(resolvers);

    expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    expect(useLandingTerminalStore.getState().tabs[0]).toMatchObject({
      hostId: "host-a",
      cwd: "/workspace/draft-a",
    });
  });

  it("clears a settled opening gesture so the + button follows focus to a folderless draft", async () => {
    mocks.activeHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/draft-a";
    mocks.probeData = emptyList(null);
    mocks.freshProbeData = mocks.probeData;
    const view = render(panelUiForDraft("draft-a"));
    const router = fakeKeybindingRouter();

    // Open on foldered draft A: the gesture settles and auto-spawns A's terminal.
    act(() => {
      dispatchAction("app.terminal.toggle", router);
    });
    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    });
    expect(
      screen
        .getByRole("button", { name: "New terminal" })
        .getAttribute("aria-disabled"),
    ).toBeNull();

    // Focus moves to a folderless draft B AFTER the gesture settled. A stale A
    // snapshot would keep + enabled from A's pinned folder; the cleared gesture
    // makes + reflect the live folderless B instead.
    mocks.primaryWorkspacePath = null;
    view.rerender(panelUiForDraft("draft-b"));

    await waitFor(() => {
      expect(
        screen
          .getByRole("button", { name: "New terminal" })
          .getAttribute("aria-disabled"),
      ).toBe("true");
    });
    // The A terminal survives; focus-following must not have spawned in B.
    expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    expect(useLandingTerminalStore.getState().tabs[0]?.cwd).toBe(
      "/workspace/draft-a",
    );
  });

  it("creates a + terminal on the captured host and folder even after focus moved to a folderless draft", async () => {
    mocks.activeHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/draft-a";
    mocks.probeData = emptyList(null);
    const resolvers: Array<(value: unknown) => void> = [];
    mocks.queryClient.fetchQuery.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const view = render(panelUiForDraft("draft-a"));
    const router = fakeKeybindingRouter();

    // Open on draft A (the gesture pins host-a + /workspace/draft-a); the list
    // fetch is deferred, so the gesture is still pending.
    act(() => {
      dispatchAction("app.terminal.toggle", router);
    });
    // Focus moves to a folderless draft B before the list settles.
    mocks.primaryWorkspacePath = null;
    view.rerender(panelUiForDraft("draft-b"));

    // The + button must create against the pinned A gesture, not the folderless
    // B the panel now happens to be focused on. It must NOT re-capture.
    const plus = await screen.findByRole("button", { name: "New terminal" });
    fireEvent.click(plus);

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    });
    expect(useLandingTerminalStore.getState().tabs[0]).toMatchObject({
      hostId: "host-a",
      cwd: "/workspace/draft-a",
    });
  });

  it("honors fail-closed on the tab.new chord: an unpinnable host creates nothing via the default client", async () => {
    mocks.activeHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList(null);
    mocks.freshProbeData = mocks.probeData;
    // The transient client cannot be pinned to the host.
    mocks.buildTransientHostClient.mockReturnValue(null);
    render(panelUiForDraft("draft-a"));
    const router = fakeKeybindingRouter();

    // tab.new opens the panel (capturing a fail-closed gesture) and creates. It
    // must NOT fall back to the default client to spawn a terminal.
    act(() => {
      dispatchAction("tab.new", router);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(useLandingTerminalStore.getState().tabs).toHaveLength(0);
  });

  it("remembers a captured host's availability downgrade after focus switches away", async () => {
    mocks.activeHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/draft-a";
    mocks.probeData = emptyList(null);
    const resolvers: Array<(value: unknown) => void> = [];
    mocks.queryClient.fetchQuery.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const view = render(panelUiForDraft("draft-a"));
    const router = fakeKeybindingRouter();

    // Capture the gesture while host-a is supported.
    act(() => {
      dispatchAction("app.terminal.toggle", router);
    });
    // host-a's capability then downgrades while host-a is STILL selected.
    mocks.probeData = undefined;
    view.rerender(panelUiForDraft("draft-a"));
    // Focus then moves to draft B on a different host.
    mocks.activeHostId = "host-b";
    view.rerender(panelUiForDraft("draft-b"));

    // The + button must reflect host-a's LAST observed (downgraded) verdict, not
    // the initial captured "supported": a forgotten downgrade would leave it
    // enabled.
    await waitFor(() => {
      expect(
        screen
          .getByRole("button", { name: "New terminal" })
          .getAttribute("aria-disabled"),
      ).toBe("true");
    });
  });

  it("cancels the open intent once the user interacts with the panel", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    // Pinned folder has no matching terminal, so an uncancelled intent would
    // spawn there on settle.
    mocks.primaryWorkspacePath = "/workspace/other";
    mocks.probeData = emptyList("/Users/dev");
    useLandingTerminalStore.getState().addTab({
      instanceId: "tab-1",
      sessionId: "session-1",
      hostId: "host-a",
      cwd: "/workspace/project",
      name: "project",
      titleSource: "default",
    });
    const resolvers: Array<(value: unknown) => void> = [];
    mocks.queryClient.fetchQuery.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    render(panelUi());
    const router = fakeKeybindingRouter();

    act(() => {
      dispatchAction("app.terminal.toggle", router);
    });
    // The user picks a tab themselves while the list fetch is still pending -
    // a late-settling pass must not yank them off that choice or spawn.
    fireEvent.click(screen.getByTestId("landing-terminal-tab-tab-1"));
    await drainDeferredListFetches(resolvers);

    expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    expect(useLandingTerminalStore.getState().activeInstanceId).toBe("tab-1");
  });

  it("hands focus to the composer when closing the last tab collapses the panel", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    useLandingTerminalStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());
    const router = fakeKeybindingRouter();

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    });
    const composerFocus = vi.fn();
    focusCleanups.push(
      registerComposerFocus(
        "test-composer-new-tab",
        {
          focus: composerFocus,
          containsActiveElement: () => true,
          isEligible: () => true,
        },
        true,
      ),
    );

    act(() => {
      dispatchAction("tab.close", router);
    });
    await waitFor(() => {
      expect(testLayout().panelOpen).toBe(false);
      expect(composerFocus).toHaveBeenCalled();
    });
  });

  it("chooses a non-primary directory before opening a terminal", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.workspacePaths = ["/workspace/project", "/workspace/other"];
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    render(panelUi());
    const router = fakeKeybindingRouter();

    act(() => {
      dispatchAction("app.terminal.toggle", router);
    });

    expect(
      await screen.findByTestId("landing-terminal-directory-picker"),
    ).toBeTruthy();
    const panel = screen.getByTestId("landing-terminal-panel");
    expect(panel.className).toContain("transition-[width]");
    expect(panel.className).not.toContain("transition-[width,visibility]");
    const pickerInput = screen.getByRole("combobox", {
      name: "Create terminal in workspace",
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(pickerInput);
    });
    expect(useLandingTerminalStore.getState().tabs).toHaveLength(0);

    fireEvent.keyDown(pickerInput, { key: "ArrowDown" });
    fireEvent.keyDown(pickerInput, { key: "Enter" });

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    });
    expect(useLandingTerminalStore.getState().tabs[0]?.cwd).toBe(
      "/workspace/other",
    );
    expect(
      screen.queryByTestId("landing-terminal-directory-picker"),
    ).toBeNull();
  });

  it("focuses the terminal after a mouse directory selection", async () => {
    mocks.activeHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.workspacePaths = ["/workspace/project", "/workspace/other"];
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    const resolvers: Array<(value: unknown) => void> = [];
    mocks.queryClient.fetchQuery.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    render(panelUi());

    act(() => {
      dispatchAction("app.terminal.toggle", fakeKeybindingRouter());
    });
    await screen.findByRole("combobox", {
      name: "Create terminal in workspace",
    });
    setPrimaryFocusInteractionActive(true);
    fireEvent.click(screen.getByText("/workspace/other"));
    setPrimaryFocusInteractionActive(false);
    await drainDeferredListFetches(resolvers);
    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    });

    const terminalTarget = document.createElement("textarea");
    document.body.append(terminalTarget);
    const terminalFocus = vi.fn(() => terminalTarget.focus());
    const tab = useLandingTerminalStore.getState().tabs[0];
    focusCleanups.push(
      registerTerminalFocus(
        tab.instanceId,
        terminalFocus,
        (activeElement) => activeElement === terminalTarget,
        () => true,
      ),
    );

    await waitFor(() => expect(terminalFocus).toHaveBeenCalled());
    terminalTarget.remove();
  });

  it("does not refocus a selected directory after focus moves before settlement", async () => {
    mocks.activeHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.workspacePaths = ["/workspace/project", "/workspace/other"];
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    const resolvers: Array<(value: unknown) => void> = [];
    mocks.queryClient.fetchQuery.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    render(panelUi());

    act(() => {
      dispatchAction("app.terminal.toggle", fakeKeybindingRouter());
    });
    const pickerInput = await screen.findByRole("combobox", {
      name: "Create terminal in workspace",
    });
    fireEvent.keyDown(pickerInput, { key: "ArrowDown" });
    fireEvent.keyDown(pickerInput, { key: "Enter" });

    const composer = document.createElement("button");
    document.body.append(composer);
    composer.focus();
    handlePrimaryFocusIn(composer);
    await drainDeferredListFetches(resolvers);
    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    });

    const terminalTarget = document.createElement("textarea");
    document.body.append(terminalTarget);
    const terminalFocus = vi.fn(() => terminalTarget.focus());
    const tab = useLandingTerminalStore.getState().tabs[0];
    focusCleanups.push(
      registerTerminalFocus(
        tab.instanceId,
        terminalFocus,
        (activeElement) => activeElement === terminalTarget,
        () => true,
      ),
    );

    expect(terminalFocus).not.toHaveBeenCalled();
    terminalTarget.remove();
    composer.remove();
  });

  it("keeps the chooser open when its captured host is no longer active", async () => {
    mocks.activeHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.workspacePaths = ["/workspace/project", "/workspace/other"];
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    let pinnedHostId = "host-a";
    mocks.buildTransientHostClient.mockImplementation(() => ({
      getActiveHostId: () => pinnedHostId,
      onChange: () => () => undefined,
    }));
    render(panelUi());

    act(() => {
      dispatchAction("app.terminal.toggle", fakeKeybindingRouter());
    });
    const pickerInput = await screen.findByRole("combobox", {
      name: "Create terminal in workspace",
    });
    pinnedHostId = "host-b";
    fireEvent.keyDown(pickerInput, { key: "ArrowDown" });
    fireEvent.keyDown(pickerInput, { key: "Enter" });

    expect(
      await screen.findByText("The selected host is no longer available."),
    ).toBeTruthy();
    expect(
      screen.getByTestId("landing-terminal-directory-picker"),
    ).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(pickerInput));
  });

  it("keeps the chooser open when a directory is detached before selection", async () => {
    mocks.activeHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.mutableWorkspacePaths = ["/workspace/project", "/workspace/other"];
    mocks.workspacePaths = mocks.mutableWorkspacePaths;
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    render(panelUi());

    act(() => {
      dispatchAction("app.terminal.toggle", fakeKeybindingRouter());
    });
    const pickerInput = await screen.findByRole("combobox", {
      name: "Create terminal in workspace",
    });
    mocks.mutableWorkspacePaths.splice(1, 1);
    fireEvent.click(screen.getByText("/workspace/other"));

    expect(
      await screen.findByText("That directory is no longer attached."),
    ).toBeTruthy();
    expect(
      screen.getByTestId("landing-terminal-directory-picker"),
    ).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(pickerInput));
  });

  it("resets the chooser when opening the selected directory fails", async () => {
    mocks.activeHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.workspacePaths = ["/workspace/project", "/workspace/other"];
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    render(panelUi());

    act(() => {
      dispatchAction("app.terminal.toggle", fakeKeybindingRouter());
    });
    const pickerInput = await screen.findByRole("combobox", {
      name: "Create terminal in workspace",
    });
    mocks.queryClient.fetchQuery.mockRejectedValue(new Error("offline"));
    fireEvent.keyDown(pickerInput, { key: "ArrowDown" });
    fireEvent.keyDown(pickerInput, { key: "Enter" });

    expect(
      await screen.findByText("The terminal directory could not be opened."),
    ).toBeTruthy();
    expect(
      screen.getByTestId("landing-terminal-directory-picker"),
    ).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(pickerInput));
  });

  it("keeps intervening focus when opening the selected directory fails", async () => {
    mocks.activeHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.workspacePaths = ["/workspace/project", "/workspace/other"];
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    const rejecters: Array<(error: unknown) => void> = [];
    mocks.queryClient.fetchQuery.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejecters.push(reject);
        }),
    );
    render(panelUi());

    act(() => {
      dispatchAction("app.terminal.toggle", fakeKeybindingRouter());
    });
    const pickerInput = await screen.findByRole("combobox", {
      name: "Create terminal in workspace",
    });
    fireEvent.keyDown(pickerInput, { key: "ArrowDown" });
    fireEvent.keyDown(pickerInput, { key: "Enter" });

    const other = document.createElement("button");
    document.body.append(other);
    other.focus();
    handlePrimaryFocusIn(other);
    await act(async () => {
      for (let pass = 0; pass < 10; pass += 1) {
        rejecters.splice(0).forEach((reject) => reject(new Error("offline")));
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });

    expect(
      await screen.findByText("The terminal directory could not be opened."),
    ).toBeTruthy();
    expect(document.activeElement).toBe(other);
    other.remove();
  });

  it("updates an open chooser when the captured draft's primary changes", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.workspacePaths = ["/workspace/project", "/workspace/other"];
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    const view = render(panelUi());
    const router = fakeKeybindingRouter();

    act(() => {
      dispatchAction("app.terminal.toggle", router);
    });
    await screen.findByTestId("landing-terminal-directory-picker");

    mocks.primaryWorkspacePath = "/workspace/other";
    view.rerender(panelUi());

    const pickerInput = screen.getByRole("combobox", {
      name: "Create terminal in workspace",
    });
    await waitFor(() => {
      expect(
        screen.getByText("Primary").closest("[data-slot='command-item']")
          ?.textContent,
      ).toContain("other");
      expect(document.activeElement).toBe(pickerInput);
    });
    fireEvent.keyDown(pickerInput, { key: "Enter" });

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs[0]?.cwd).toBe(
        "/workspace/other",
      );
    });
  });

  it("reuses a matching terminal after choosing its directory on reopen", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.workspacePaths = ["/workspace/project", "/workspace/other"];
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    useLandingTerminalStore.getState().addTab({
      instanceId: "project-tab",
      sessionId: "project-session",
      hostId: "host-a",
      cwd: "/workspace/project",
      name: "project · New Terminal",
      titleSource: "default",
    });
    useLandingTerminalStore.getState().addTab({
      instanceId: "other-tab",
      sessionId: "other-session",
      hostId: "host-a",
      cwd: "/workspace/other",
      name: "other · New Terminal",
      titleSource: "default",
    });
    useLandingTerminalStore.getState().activateTab("project-tab");
    render(panelUi());
    const router = fakeKeybindingRouter();
    focusCleanups.push(
      registerTerminalFocus(
        "project-tab",
        () => {
          screen.getByTestId("landing-terminal-tab-project-tab").focus();
        },
        () => true,
        () => true,
      ),
    );
    focusCleanups.push(
      registerTerminalFocus(
        "other-tab",
        () => {
          screen.getByTestId("landing-terminal-tab-other-tab").focus();
        },
        () => true,
        () => true,
      ),
    );

    act(() => {
      dispatchAction("app.terminal.toggle", router);
    });
    const pickerInput = await screen.findByRole("combobox", {
      name: "Create terminal in workspace",
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(pickerInput);
    });
    fireEvent.keyDown(pickerInput, { key: "ArrowDown" });
    fireEvent.keyDown(pickerInput, { key: "Enter" });

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().activeInstanceId).toBe(
        "other-tab",
      );
      expect(document.activeElement).toBe(
        screen.getByTestId("landing-terminal-tab-other-tab"),
      );
    });
    expect(useLandingTerminalStore.getState().tabs).toHaveLength(2);
  });

  it("always creates for explicit new-terminal actions after directory selection", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.workspacePaths = ["/workspace/project", "/workspace/other"];
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    useLandingTerminalStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());
    const router = fakeKeybindingRouter();

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    });

    const createInOther = async (): Promise<void> => {
      const pickerInput = await screen.findByRole("combobox", {
        name: "Create terminal in workspace",
      });
      await waitFor(() => {
        expect(document.activeElement).toBe(pickerInput);
      });
      fireEvent.click(await screen.findByText("/workspace/other"));
      await waitFor(() => {
        expect(
          screen.queryByTestId("landing-terminal-directory-picker"),
        ).toBeNull();
      });
    };

    fireEvent.click(screen.getByTestId("landing-terminal-new-tab"));
    await createInOther();

    act(() => {
      dispatchAction("app.terminal.new", router);
    });
    await createInOther();

    act(() => {
      dispatchAction("tab.new", router);
    });
    await createInOther();

    fireEvent.doubleClick(screen.getByTestId("landing-terminal-tab-strip"));
    await createInOther();

    const otherTabs = useLandingTerminalStore
      .getState()
      .tabs.filter((tab) => tab.cwd === "/workspace/other");
    expect(otherTabs).toHaveLength(4);
  });

  it("cancels a chooser opened from a collapsed panel without spawning", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.workspacePaths = ["/workspace/project", "/workspace/other"];
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    render(panelUi());
    const router = fakeKeybindingRouter();
    const composerFocus = vi.fn();
    focusCleanups.push(
      registerComposerFocus(
        "test-composer-toggle",
        {
          focus: composerFocus,
          containsActiveElement: () => true,
          isEligible: () => true,
        },
        true,
      ),
    );

    act(() => {
      dispatchAction("app.terminal.toggle", router);
    });
    const pickerInput = await screen.findByRole("combobox", {
      name: "Create terminal in workspace",
    });
    fireEvent.keyDown(pickerInput, { key: "Escape" });

    await waitFor(() => {
      expect(testLayout().panelOpen).toBe(false);
      expect(composerFocus).toHaveBeenCalled();
    });
    expect(useLandingTerminalStore.getState().tabs).toHaveLength(0);
  });

  it("returns from the inline chooser to the active terminal", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.workspacePaths = ["/workspace/project", "/workspace/other"];
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    useLandingTerminalStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    });
    const newTerminalButton = screen.getByTestId("landing-terminal-new-tab");
    fireEvent.click(newTerminalButton);
    const pickerInput = await screen.findByRole("combobox", {
      name: "Create terminal in workspace",
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(pickerInput);
    });
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Cancel terminal creation",
      }),
    );

    await waitFor(() => {
      expect(
        screen.queryByTestId("landing-terminal-directory-picker"),
      ).toBeNull();
      expect(document.activeElement).toBe(newTerminalButton);
    });
    expect(testLayout().panelOpen).toBe(true);
    expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
  });

  it("clears an open chooser when the panel collapses through the store", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.workspacePaths = ["/workspace/project", "/workspace/other"];
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    useLandingTerminalStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    fireEvent.click(screen.getByTestId("landing-terminal-new-tab"));
    expect(
      await screen.findByTestId("landing-terminal-directory-picker"),
    ).toBeTruthy();

    act(() =>
      useLandingTerminalStore
        .getState()
        .setPanelOpen(TEST_LANDING_PAGE_ID, false),
    );

    await waitFor(() => {
      expect(
        screen.queryByTestId("landing-terminal-directory-picker"),
      ).toBeNull();
    });

    const router = fakeKeybindingRouter();
    act(() => {
      dispatchAction("tab.new", router);
    });
    expect(
      await screen.findByTestId("landing-terminal-directory-picker"),
    ).toBeTruthy();
  });

  it("reopens onto the pinned folder: spawns there when no terminal matches, reuses one that does", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    useLandingTerminalStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    const view = render(panelUi());
    const router = fakeKeybindingRouter();

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    });
    const first = useLandingTerminalStore.getState().tabs[0];
    expect(first.cwd).toBe("/workspace/project");

    // Collapse, repoint the composer's pinned folder, re-expand: the panel
    // must land on a terminal running in the new folder - here by spawning
    // one, since none matches - while the old terminal stays as a tab.
    act(() => {
      dispatchAction("app.terminal.toggle", router);
    });
    mocks.primaryWorkspacePath = "/workspace/other";
    view.rerender(panelUi());
    act(() => {
      dispatchAction("app.terminal.toggle", router);
    });
    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(2);
    });
    const second = useLandingTerminalStore
      .getState()
      .tabs.find((tab) => tab.instanceId !== first.instanceId);
    expect(second?.cwd).toBe("/workspace/other");
    expect(useLandingTerminalStore.getState().activeInstanceId).toBe(
      second?.instanceId,
    );

    // Collapse, repoint back to the original folder, re-expand: the still-
    // running matching terminal is reused instead of spawning a third.
    act(() => {
      dispatchAction("app.terminal.toggle", router);
    });
    mocks.primaryWorkspacePath = "/workspace/project";
    view.rerender(panelUi());
    act(() => {
      dispatchAction("app.terminal.toggle", router);
    });
    await waitFor(() => {
      expect(useLandingTerminalStore.getState().activeInstanceId).toBe(
        first.instanceId,
      );
    });
    expect(useLandingTerminalStore.getState().tabs).toHaveLength(2);
  });

  it("leaves the open panel alone when the pinned folder changes without a reopen", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    useLandingTerminalStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    const view = render(panelUi());

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    });
    const first = useLandingTerminalStore.getState().tabs[0];

    mocks.primaryWorkspacePath = "/workspace/other";
    view.rerender(panelUi());

    // The folder change re-runs reconciliation; it must not spawn or switch
    // while the panel stays open - only a reopen re-targets the pinned folder.
    await waitFor(() => {
      expect(mocks.queryClient.fetchQuery).toHaveBeenCalledTimes(2);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    expect(useLandingTerminalStore.getState().activeInstanceId).toBe(
      first.instanceId,
    );
  });

  it("expands folderless via app.terminal.toggle with home cwd and parks focus", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = null;
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = emptyList("/Users/dev");
    render(panelUi());
    const router = fakeKeybindingRouter();

    act(() => {
      dispatchAction("app.terminal.toggle", router);
    });
    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    });
    const created = useLandingTerminalStore.getState().tabs[0];
    expect(created.cwd).toBe("/Users/dev");
    expect(created.hostId).toBe("host-a");
    expect(screen.queryByTestId("landing-terminal-select-folder")).toBeNull();

    // Mirror the folder-backed expand-empty focus test: the parked request
    // fires when the auto-spawned tile engine registers after create.
    const terminalFocus = vi.fn();
    focusCleanups.push(
      registerTerminalFocus(
        created.instanceId,
        terminalFocus,
        () => true,
        () => true,
      ),
    );
    await waitFor(() => {
      expect(terminalFocus).toHaveBeenCalledTimes(1);
    });
  });

  it("add, double-click, and keyboard new paths use homeCwd when folderless", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = null;
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = emptyList("/Users/dev");
    useLandingTerminalStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());
    const router = fakeKeybindingRouter();

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    });
    expect(useLandingTerminalStore.getState().tabs[0]?.cwd).toBe("/Users/dev");

    fireEvent.click(screen.getByTestId("landing-terminal-new-tab"));
    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(2);
    });

    fireEvent.doubleClick(screen.getByTestId("landing-terminal-tab-strip"));
    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(3);
    });

    act(() => {
      dispatchAction("tab.new", router);
    });
    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(4);
    });

    act(() => {
      dispatchAction("app.terminal.new", router);
    });
    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(5);
    });

    const tabs = useLandingTerminalStore.getState().tabs;
    expect(tabs.every((tab) => tab.cwd === "/Users/dev")).toBe(true);
    expect(tabs.every((tab) => tab.hostId === "host-a")).toBe(true);
    expect(screen.queryByTestId("landing-terminal-select-folder")).toBeNull();
  });

  it("leaves existing tabs when the last folder is removed; later create uses home", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = emptyList("/Users/dev");
    useLandingTerminalStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    const view = render(panelUi());

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    });
    const folderTab = useLandingTerminalStore.getState().tabs[0];
    expect(folderTab.cwd).toBe("/workspace/project");
    expect(mocks.queryClient.fetchQuery).toHaveBeenCalledTimes(1);

    // Detach the last folder: live tabs stay put; no restart, no auto-spawn.
    mocks.primaryWorkspacePath = null;
    view.rerender(panelUi());
    await waitFor(() => {
      expect(mocks.queryClient.fetchQuery).toHaveBeenCalledTimes(2);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(useLandingTerminalStore.getState().tabs).toEqual([folderTab]);
    expect(useLandingTerminalStore.getState().activeInstanceId).toBe(
      folderTab.instanceId,
    );
    expect(screen.queryByTestId("landing-terminal-select-folder")).toBeNull();

    fireEvent.click(screen.getByTestId("landing-terminal-new-tab"));
    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(2);
    });
    const created = useLandingTerminalStore
      .getState()
      .tabs.find((tab) => tab.instanceId !== folderTab.instanceId);
    expect(created?.cwd).toBe("/Users/dev");
  });

  it("folder-backed create still works when homeCwd is null", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList(null);
    mocks.freshProbeData = emptyList(null);
    useLandingTerminalStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    });
    expect(useLandingTerminalStore.getState().tabs[0]?.cwd).toBe(
      "/workspace/project",
    );
    expect(screen.queryByTestId("landing-terminal-host-update")).toBeNull();
    expect(screen.queryByTestId("landing-terminal-select-folder")).toBeNull();

    fireEvent.click(screen.getByTestId("landing-terminal-new-tab"));
    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(2);
    });
    expect(
      useLandingTerminalStore
        .getState()
        .tabs.every((tab) => tab.cwd === "/workspace/project"),
    ).toBe(true);
  });

  it("blocks keyboard and double-click create when folderless and homeCwd is null", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = null;
    mocks.probeData = emptyList(null);
    mocks.freshProbeData = emptyList(null);
    useLandingTerminalStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());
    const router = fakeKeybindingRouter();

    expect(
      await screen.findByTestId("landing-terminal-host-update"),
    ).toBeTruthy();
    expect(useLandingTerminalStore.getState().tabs).toHaveLength(0);
    expect(screen.queryByTestId("landing-terminal-select-folder")).toBeNull();

    fireEvent.doubleClick(screen.getByTestId("landing-terminal-tab-strip"));
    act(() => {
      dispatchAction("tab.new", router);
      dispatchAction("app.terminal.new", router);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(useLandingTerminalStore.getState().tabs).toHaveLength(0);
    expect(screen.getByTestId("landing-terminal-host-update")).toBeTruthy();
    expect(screen.queryByTestId("landing-terminal-select-folder")).toBeNull();
  });

  it("rejects stale manual create and late Host A list when client host switches ahead of React", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = null;
    mocks.probeData = emptyList("/Users/host-a");
    mocks.freshProbeData = emptyList("/Users/host-a");
    useLandingTerminalStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);

    type PendingList = {
      readonly hostId: string | null;
      readonly resolve: (value: unknown) => void;
    };
    const pending: PendingList[] = [];
    let deferFetches = false;
    mocks.queryClient.fetchQuery.mockImplementation(() => {
      if (!deferFetches) {
        return Promise.resolve(mocks.freshProbeData ?? mocks.probeData);
      }
      return new Promise((resolve) => {
        pending.push({ hostId: mocks.activeHostId, resolve });
      });
    });

    const view = render(panelUi());

    // Host A settles folderless: reconciledContext + Host-A create callback.
    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    });
    const hostATab = useLandingTerminalStore.getState().tabs[0];
    expect(hostATab.hostId).toBe("host-a");
    expect(hostATab.cwd).toBe("/Users/host-a");
    // Subscribed BY HOST since P4.2: the panel is told "host-a's row moved",
    // not "the bound host changed". Asserted rather than assumed, because a
    // registry arm that never subscribed would make the drive below a no-op
    // and this whole case would pass without ever starting a generation.
    const hostARowListeners = mocks.rowChangedListeners.filter(
      (entry) => entry.hostId === "host-a",
    );
    expect(hostARowListeners.length).toBeGreaterThan(0);

    // Start a fresh Host-A list generation that stays pending (no React host change).
    deferFetches = true;
    act(() => {
      for (const entry of hostARowListeners) {
        entry.listener();
      }
    });
    await waitFor(() => {
      expect(pending.some((entry) => entry.hostId === "host-a")).toBe(true);
    });
    const hostAPending = pending.filter((entry) => entry.hostId === "host-a");

    // Client advances to B; React reactive host and Host-A create closure stay A.
    mocks.clientActiveHostId = "host-b";

    const tabsBeforeManualCreate = useLandingTerminalStore.getState().tabs;
    const router = fakeKeybindingRouter();
    act(() => {
      dispatchAction("app.terminal.new", router);
      dispatchAction("tab.new", router);
    });
    fireEvent.click(screen.getByTestId("landing-terminal-new-tab"));
    await act(async () => {
      await Promise.resolve();
    });

    // Manual create must not persist Host A's home after the client switched.
    expect(useLandingTerminalStore.getState().tabs).toEqual(
      tabsBeforeManualCreate,
    );
    expect(
      useLandingTerminalStore
        .getState()
        .tabs.filter(
          (tab) => tab.hostId === "host-a" && tab.cwd === "/Users/host-a",
        ),
    ).toHaveLength(1);

    // Late Host-A list resolves while client is already B (still no React rerender).
    await act(async () => {
      hostAPending.forEach((entry) => {
        entry.resolve(emptyList("/Users/host-a"));
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Stale publication/spawn rejected: no extra Host-A home tabs, nothing for B yet.
    expect(
      useLandingTerminalStore
        .getState()
        .tabs.filter((tab) => tab.cwd === "/Users/host-a"),
    ).toHaveLength(1);
    expect(
      useLandingTerminalStore
        .getState()
        .tabs.some((tab) => tab.hostId === "host-b"),
    ).toBe(false);
    expect(screen.queryByTestId("landing-terminal-select-folder")).toBeNull();

    // Advance React host + probe to B and let B settle. Existing Host-A tabs
    // stay (old-host degradation); auto-spawn only runs when the panel is empty.
    mocks.activeHostId = "host-b";
    mocks.clientActiveHostId = "host-b";
    mocks.probeData = emptyList("/Users/host-b");
    mocks.freshProbeData = emptyList("/Users/host-b");
    deferFetches = false;
    const fetchesBeforeB = mocks.queryClient.fetchQuery.mock.calls.length;
    view.rerender(panelUi());

    await waitFor(() => {
      expect(mocks.queryClient.fetchQuery.mock.calls.length).toBeGreaterThan(
        fetchesBeforeB,
      );
    });
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Once B is current, manual create may only use Host B's home.
    const tabCountBeforeBCreate =
      useLandingTerminalStore.getState().tabs.length;
    fireEvent.click(screen.getByTestId("landing-terminal-new-tab"));
    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs.length).toBe(
        tabCountBeforeBCreate + 1,
      );
    });
    const createdOnB = useLandingTerminalStore
      .getState()
      .tabs.find((tab) => tab.hostId === "host-b");
    expect(createdOnB?.cwd).toBe("/Users/host-b");
    expect(
      useLandingTerminalStore
        .getState()
        .tabs.some(
          (tab) => tab.hostId === "host-b" && tab.cwd === "/Users/host-a",
        ),
    ).toBe(false);
  });

  it("rejects a stale manual create with the old primary workspace when the client host switches ahead of React", async () => {
    // With a primary workspace, the cwd resolver returns the workspace path
    // before consulting the reconciled host context, so the render-vs-client
    // host identity comparison in createTerminalTab is the only guard in this
    // window. A stale Host-A closure must not persist Host A's workspace path
    // onto a tab once the client host has moved to B.
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/host-a-project";
    mocks.probeData = emptyList("/Users/host-a");
    mocks.freshProbeData = emptyList("/Users/host-a");
    useLandingTerminalStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    });
    expect(useLandingTerminalStore.getState().tabs[0]?.cwd).toBe(
      "/workspace/host-a-project",
    );

    // Client advances to B; the reactive host and every installed handler
    // still come from Host A's render.
    mocks.clientActiveHostId = "host-b";

    const tabsBeforeManualCreate = useLandingTerminalStore.getState().tabs;
    const router = fakeKeybindingRouter();
    act(() => {
      dispatchAction("app.terminal.new", router);
      dispatchAction("tab.new", router);
    });
    fireEvent.click(screen.getByTestId("landing-terminal-new-tab"));
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(useLandingTerminalStore.getState().tabs).toEqual(
      tabsBeforeManualCreate,
    );
    expect(
      useLandingTerminalStore
        .getState()
        .tabs.filter((tab) => tab.cwd === "/workspace/host-a-project"),
    ).toHaveLength(1);
    expect(
      useLandingTerminalStore
        .getState()
        .tabs.some((tab) => tab.hostId === "host-b"),
    ).toBe(false);
  });
});
