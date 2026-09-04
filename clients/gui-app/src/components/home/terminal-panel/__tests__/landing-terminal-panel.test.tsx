import { useMemo, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { CanonicalTerminalSessionInfo } from "@traycer/protocol/host/terminal/unary-schemas";
import type { PlainTerminalProjection } from "@traycer/protocol/host/terminal/plain-schemas";
import type { PlainTerminalCollection } from "@/lib/terminals/plain-terminal-authority";
import type { BrowserTabIdentity } from "@traycer/protocol/host/browser/contracts";
import type { BrowserSessionsState } from "@/lib/browser-view/sessions/browser-sessions-coordinator";
import { useLandingBrowserTombstoneDrain } from "@/providers/landing-browser-tombstone-drain";
import {
  independentScope,
  sessionInfo,
  tabInfo,
} from "@/lib/browser-view/sessions/__tests__/browser-session-test-kit";
import {
  landingBrowserPendingKills,
  landingPanelLayoutFor,
  landingTerminalTabs,
  useLandingPanelStore,
  type LandingTerminalTabRef,
} from "@/stores/home/landing-panel-store";
import {
  landingTerminalRightActionsKey,
  useMobileHeaderStore,
} from "@/stores/layout/mobile-header-store";
import { useMobileHeaderRightActions } from "@/stores/layout/mobile-header-right-actions";
import { registerComposerFocus } from "@/lib/composer/composer-focus-registry";
import {
  handlePrimaryFocusIn,
  hasPrimaryFocusIntent,
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
  // What the fleet's BROWSER arm reports per device. Empty by default, so the
  // panel sees `null` for every host and its browser closes fall back to the
  // tombstone alone - which is what every terminal-only case here wants.
  const browserSessionsByHost: Partial<Record<string, BrowserSessionsState>> =
    {};
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
    probeError: null as HostRpcError | null,
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
    browserSessionsByHost,
    browserCloseTab: vi.fn(() => Promise.resolve()),
    browserStreamHostIds: [] as readonly string[],
    // Whether the SHELL has native browser capability. True is a desktop, the
    // shell every browser scenario here is about; false is the web / mobile
    // shell that can only watch a tab.
    runnerHostHasBrowserView: true,
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
    buildDialableHostClient: vi.fn<
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

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHostOrNull: () => ({
    browserView: mocks.runnerHostHasBrowserView ? {} : null,
  }),
}));

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
  buildDialableHostClient: mocks.buildDialableHostClient,
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
        readonly browserHostIds: readonly string[];
        readonly onEntry: (hostId: string, entry: unknown) => void;
        readonly onBrowserSessions: (
          hostId: string,
          sessions: BrowserSessionsState | null,
        ) => void;
      }) => {
        const { onBrowserSessions, onEntry } = props;
        const hostKey = props.hostIds.join("\u0000");
        // Joined so the effect depends on the LIST rather than on the array
        // identity the panel re-memoizes each render, same as the arm above.
        const browserHostKey = props.browserHostIds.join("\u0000");
        // Which devices have published one, so a test that fills the map
        // mid-run re-publishes on the next render rather than staying silent.
        const browserSessionsKey = Object.keys(mocks.browserSessionsByHost)
          .sort()
          .join("\u0000");
        useEffect(() => {
          const browserHostIds =
            browserHostKey.length === 0 ? [] : browserHostKey.split("\u0000");
          // The devices the panel is asking to be put on a stream. Recorded
          // because each one costs a capped per-window browser stream.
          mocks.browserStreamHostIds = browserHostIds;
          browserHostIds.forEach((hostId) => {
            onBrowserSessions(
              hostId,
              mocks.browserSessionsByHost[hostId] ?? null,
            );
          });
          return () => {
            browserHostIds.forEach((hostId) => onBrowserSessions(hostId, null));
          };
        }, [browserHostKey, browserSessionsKey, onBrowserSessions]);
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
// Stood in for the same reason the terminal tile is: the real one mounts a
// coordinator provider off the host binding, which this suite does not stand
// up. Its own behavior is covered in `landing-browser-tile.test.tsx`.
vi.mock("@/components/home/terminal-panel/landing-browser-tile", () => ({
  // Renders the two props the panel DECIDES, because a browser tile's pixels
  // are a native view the desktop paints over the window: no DOM assertion can
  // see whether it is on screen, and `invisible` on an ancestor does not hide
  // it. Visibility there is this prop, so this is where it has to be asserted.
  LandingBrowserTile: (props: {
    readonly tab: { readonly instanceId: string };
    readonly active: boolean;
    readonly panelOpen: boolean;
    readonly watched: boolean;
  }) => (
    <div
      data-testid={`landing-browser-tile-${props.tab.instanceId}`}
      data-active={String(props.active)}
      data-panel-open={String(props.panelOpen)}
      data-watched={String(props.watched)}
    >
      Browser
    </div>
  ),
}));
vi.mock("@/components/epic-canvas/renderers/xterm-host-registry", () => ({
  reconcileXtermHostAfterLayoutTransition:
    mocks.reconcileXtermHostAfterLayoutTransition,
}));

import { LandingTerminalPanel } from "@/components/home/terminal-panel/landing-terminal-panel";
import { LANDING_BROWSER_WATCHED_HOST_CAP } from "@/components/home/terminal-panel/landing-browser-presentation";
import { LandingTerminalGestureProvider } from "@/components/home/terminal-panel/landing-terminal-gesture-provider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { requestLandingTerminalClose } from "@/lib/terminals/landing-terminal-close-coordinator";

const TEST_LANDING_PAGE_ID = "test-landing-page";

function testLayout() {
  return landingPanelLayoutFor(
    useLandingPanelStore.getState(),
    TEST_LANDING_PAGE_ID,
  );
}

function layoutFor(landingPageId: string) {
  return landingPanelLayoutFor(useLandingPanelStore.getState(), landingPageId);
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

/**
 * A REAL client, unlike the hand-rolled `mocks.queryClient` the panel's own
 * `useQueryClient()` reads. The panel opens browser tabs through `useMutation`
 * / `useIsMutating`, and those resolve the client through react-query's own
 * internal reference rather than through this suite's mocked export - so the
 * fake never reaches them and they need a provider. Re-made per test, because
 * `useIsMutating` counts across the whole client.
 */
let testQueryClient = new QueryClient();

function panelUiForDraft(draftId: string | null) {
  return (
    <QueryClientProvider client={testQueryClient}>
      <TooltipProvider>
        <LandingTerminalGestureProvider draftId={draftId}>
          <LandingTerminalPanel />
        </LandingTerminalGestureProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

function panelUiInBoxlessPaneAnchor() {
  return (
    <QueryClientProvider client={testQueryClient}>
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
    </QueryClientProvider>
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

/**
 * Picks Terminal in the placeholder's chooser.
 *
 * An empty panel opens onto the chooser instead of spawning, so a case that
 * used to reach a terminal (or its directory picker) straight off the opening
 * gesture now says "terminal" first. `revealAndCreateTerminal` runs from the
 * click exactly as it did from the auto-spawn, picker round trip included.
 */
async function pickTerminalFromChooser(): Promise<void> {
  const terminalCard = await screen.findByTestId(
    "landing-new-tab-card-terminal",
  );
  await waitFor(() => {
    expect(terminalCard.getAttribute("aria-disabled")).toBeNull();
  });
  fireEvent.click(terminalCard);
}

/** A device whose browser stream is live and has published an inventory. */
function browserSessionsState(
  overrides: Partial<BrowserSessionsState>,
): BrowserSessionsState {
  return {
    hostId: "host-a",
    lifecycle: "live",
    inventoryReady: true,
    canMaterializeElectron: false,
    items: [],
    errorMessage: null,
    retry: () => undefined,
    openTab: () => Promise.reject(new Error("not used in this test")),
    closeTab: () => Promise.reject(new Error("not used in this test")),
    attachTab: () => Promise.reject(new Error("not used in this test")),
    ...overrides,
  };
}

/** One browser tab on `hostId`, added to the store in strip order. */
function addBrowserTab(hostId: string, instanceId: string): void {
  useLandingPanelStore.getState().addTab({
    kind: "browser",
    instanceId,
    hostId,
    sessionId: `session-${instanceId}`,
    tabId: `tab-${instanceId}`,
    name: `${hostId}.example`,
    titleSource: "default",
  });
}

/**
 * The always-mounted drain, standing in for the recovery bridge that carries it
 * app-wide. Rendered beside the panel so a close is observed with BOTH watchers
 * of the tombstone set present, which is the only arrangement in which a second
 * sender can show up at all.
 */
function BrowserTombstoneDrainProbe(): ReactNode {
  const pendingKills = useLandingPanelStore((state) => state.pendingKills);
  const browserPendingKills = useMemo(
    () => landingBrowserPendingKills(pendingKills),
    [pendingKills],
  );
  useLandingBrowserTombstoneDrain({
    pendingKills: browserPendingKills,
    browserSessions: mocks.browserSessionsByHost,
  });
  return null;
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
    mocks.browserSessionsByHost = {};
    mocks.browserStreamHostIds = [];
    mocks.runnerHostHasBrowserView = true;
    mocks.browserCloseTab.mockClear();
    // `mockClear` keeps an implementation a test installed, so restore the
    // declared default here - a test that defers its close must not leak that
    // into every test after it.
    mocks.browserCloseTab.mockImplementation(() => Promise.resolve());
    // Reset (not just clear): a test may override the return with a fail-closed
    // `null`, and mockClear would leak that override into later tests. Restore
    // the default host-pinned client here.
    mocks.buildDialableHostClient.mockReset();
    mocks.buildDialableHostClient.mockImplementation(
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
    useLandingPanelStore.getState().resetForTests();
    testQueryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
  });

  afterEach(() => {
    cleanup();
    useMobileHeaderStore.setState({ rightActionEntries: new Map() });
    focusCleanups.forEach((unregister) => unregister());
    focusCleanups.length = 0;
    resetTerminalFocusRegistryForTests();
    resetPrimaryFocusCoordinatorForTests();
    useLandingPanelStore.getState().resetForTests();
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

    // The key bar sends terminal chords to one instance id. Over a browser row
    // its keys have nowhere to land, and on a phone it would cover the surface
    // the reader is actually on.
    it("mounts the key bar for a terminal row and not for a browser row", async () => {
      mocks.browserSessionsByHost = {
        "host-a": browserSessionsState({}),
      };
      useLandingPanelStore.getState().addTab({
        kind: "terminal",
        instanceId: "terminal-instance",
        sessionId: "terminal-session",
        hostId: "host-a",
        cwd: "/workspace/project",
        name: "project",
        titleSource: "default",
      });
      useLandingPanelStore.getState().addTab({
        kind: "browser",
        instanceId: "browser-instance",
        hostId: "host-a",
        sessionId: "browser-session",
        tabId: "browser-tab",
        name: "example.com",
        titleSource: "default",
      });
      useLandingPanelStore.getState().activateTab("terminal-instance");
      useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
      render(panelUi());

      expect(await screen.findByTestId("mobile-terminal-key-bar")).toBeTruthy();

      act(() => {
        useLandingPanelStore.getState().activateTab("browser-instance");
      });

      await waitFor(() => {
        expect(screen.queryByTestId("mobile-terminal-key-bar")).toBeNull();
      });
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
      useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
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
      useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
      render(panelUi());
      await screen.findByTestId("landing-terminal-panel");

      // Collapse lives in the header slot, which this render does not mount.
      expect(screen.queryByTestId("landing-terminal-collapse")).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Maximize panel" }),
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

      expect(screen.queryByRole("button", { name: "Open panel" })).toBeNull();
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
      await screen.findByRole("button", { name: "Open panel" });

      act(() => {
        seedTabsLayout([PANEL_DRAFT_TAB, PANEL_EPIC_TAB], PANEL_EPIC_TAB.id);
      });
      expect(screen.queryByRole("button", { name: "Open panel" })).toBeNull();

      act(() => {
        seedTabsLayout([PANEL_DRAFT_TAB, PANEL_EPIC_TAB], PANEL_DRAFT_TAB.id);
      });
      expect(
        await screen.findByRole("button", { name: "Open panel" }),
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
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
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
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
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
    fireEvent.click(screen.getByRole("button", { name: "Maximize panel" }));
    expect(screen.getByRole("button", { name: "Restore panel" })).toBeTruthy();

    view.rerender(panelUiForDraft("draft-a"));
    expect(screen.queryByRole("button", { name: "Restore panel" })).toBeNull();

    view.rerender(panelUiForDraft("draft-b"));
    expect(screen.getByRole("button", { name: "Restore panel" })).toBeTruthy();
  });

  it("resizes through the boxless split-pane portal anchor", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    useLandingPanelStore.getState().setPanelOpen("draft-a", true);
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

  it("opens onto the chooser, then creates in the host home once picked, when nothing is pinned", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = null;
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = emptyList("/Users/dev");
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    // No auto-spawn: an empty open panel shows the chooser, not a terminal.
    expect(await screen.findByTestId("landing-new-tab-chooser")).toBeTruthy();
    expect(
      landingTerminalTabs(useLandingPanelStore.getState().tabs),
    ).toHaveLength(0);

    const terminalCard = screen.getByTestId("landing-new-tab-card-terminal");
    await waitFor(() => {
      expect(terminalCard.getAttribute("aria-disabled")).toBeNull();
    });
    fireEvent.click(terminalCard);

    await waitFor(() => {
      expect(
        landingTerminalTabs(useLandingPanelStore.getState().tabs),
      ).toHaveLength(1);
    });
    expect(
      landingTerminalTabs(useLandingPanelStore.getState().tabs)[0]?.cwd,
    ).toBe("/Users/dev");
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
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    const terminalCard = await screen.findByTestId(
      "landing-new-tab-card-terminal",
    );
    await waitFor(() => {
      expect(terminalCard.getAttribute("aria-disabled")).toBeNull();
    });
    fireEvent.click(terminalCard);

    await waitFor(() => {
      expect(
        landingTerminalTabs(useLandingPanelStore.getState().tabs),
      ).toHaveLength(1);
    });
    expect(
      landingTerminalTabs(useLandingPanelStore.getState().tabs)[0]?.hostId,
    ).toBe("host-b");
  });

  it("holds a pending reopen that settles while the start page is backgrounded, then completes on return", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = emptyList("/Users/dev");
    useLandingPanelStore.getState().addTab({
      kind: "terminal",
      instanceId: "tab-1",
      sessionId: "session-1",
      hostId: "host-a",
      cwd: "/workspace/project",
      name: "project",
      titleSource: "default",
    });
    seedTabsLayout([PANEL_DRAFT_TAB, PANEL_EPIC_TAB], PANEL_DRAFT_TAB.id);
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    const view = render(panelUi());
    const router = fakeKeybindingRouter();

    // Collapse, repoint to a folder with no matching terminal, then reopen -
    // the reopen captures a gesture that reconciliation would spawn into. Then
    // switch to the epic tab before `terminal.list` settles. The panel used to
    // UNMOUNT here, which aborted the pass; now it survives, so the settlement
    // has to gate itself - a terminal spawned into a `display:none` pane
    // cannot be measured and lands at the 80x24 fallback grid, and the focus
    // grab would pull the keyboard off the epic canvas.
    act(() => {
      dispatchAction("app.terminal.toggle", router);
    });
    mocks.primaryWorkspacePath = "/workspace/other";
    view.rerender(panelUi());
    act(() => {
      dispatchAction("app.terminal.toggle", router);
    });
    act(() => {
      seedTabsLayout([PANEL_DRAFT_TAB, PANEL_EPIC_TAB], PANEL_EPIC_TAB.id);
    });

    // The fresh list is the last step before settlement, so waiting on it makes
    // "nothing spawned" an ordering claim rather than a race the test won.
    await waitFor(() => {
      expect(mocks.queryClient.fetchQuery).toHaveBeenCalled();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      landingTerminalTabs(useLandingPanelStore.getState().tabs),
    ).toHaveLength(1);

    // Returning must still open the terminal the user asked for: the
    // reconciliation key is unchanged on the way back, so a settlement that was
    // DROPPED rather than held would never be recomputed and the panel would
    // sit empty forever.
    await act(async () => {
      seedTabsLayout([PANEL_DRAFT_TAB, PANEL_EPIC_TAB], PANEL_DRAFT_TAB.id);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(
        landingTerminalTabs(useLandingPanelStore.getState().tabs),
      ).toHaveLength(2);
    });
    const second = landingTerminalTabs(
      useLandingPanelStore.getState().tabs,
    ).find((tab) => tab.instanceId !== "tab-1");
    expect(second?.cwd).toBe("/workspace/other");
  });

  it("shows host update guidance on the chooser's Terminal card when homeCwd is null and nothing is pinned", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = null;
    mocks.probeData = emptyList(null);
    mocks.freshProbeData = emptyList(null);
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    // The empty state is displaced by the chooser; the guidance now lives on
    // the Terminal card's disabled reason.
    const terminalCard = await screen.findByTestId(
      "landing-new-tab-card-terminal",
    );
    await waitFor(() => {
      expect(terminalCard.getAttribute("aria-disabled")).toBe("true");
    });
    expect(
      screen.getByTestId("landing-new-tab-card-terminal-reason").textContent,
    ).toBe("Update the selected host to open a terminal without a folder.");
    expect(
      landingTerminalTabs(useLandingPanelStore.getState().tabs),
    ).toHaveLength(0);
    expect(screen.queryByTestId("landing-terminal-select-folder")).toBeNull();
  });

  it("shows only the host connection state while an existing terminal waits for the probe", () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    useLandingPanelStore.getState().addTab({
      kind: "terminal",
      instanceId: "tab-1",
      sessionId: "session-1",
      hostId: "host-a",
      cwd: "/workspace/project",
      name: "project",
      titleSource: "default",
    });
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);

    render(panelUi());

    expect(screen.getByRole("status").textContent).toBe(
      "Connecting to the selected host…",
    );
    expect(screen.queryByText("Starting terminal…")).toBeNull();
  });

  it("opens the chooser when the empty tab-strip space is double-clicked", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = emptyList("/Users/dev");
    render(panelUi());
    const router = fakeKeybindingRouter();

    // No auto-spawn: create the first terminal directly (a folder is pinned,
    // so ⇧⌘J creates synchronously without depending on the chooser). The
    // double-click behavior under test does not care how it got there.
    act(() => {
      dispatchAction("app.terminal.new", router);
    });
    await waitFor(() => {
      expect(
        landingTerminalTabs(useLandingPanelStore.getState().tabs),
      ).toHaveLength(1);
    });
    expect(
      landingTerminalTabs(useLandingPanelStore.getState().tabs)[0]?.name,
    ).toBe("project · New Terminal");

    // The empty-strip double-click now opens the chooser rather than
    // spawning directly; picking Terminal fills it in place.
    fireEvent.doubleClick(screen.getByTestId("landing-terminal-tab-strip"));
    expect(screen.getByTestId("landing-new-tab-chooser")).toBeTruthy();
    fireEvent.click(screen.getByTestId("landing-new-tab-card-terminal"));
    await waitFor(() => {
      expect(
        landingTerminalTabs(useLandingPanelStore.getState().tabs),
      ).toHaveLength(2);
    });

    // A double-click that lands on a tab activates it; it must not spawn.
    fireEvent.doubleClick(screen.getAllByRole("tab")[0]);
    expect(
      landingTerminalTabs(useLandingPanelStore.getState().tabs),
    ).toHaveLength(2);
  });

  it("scrolls a newly created tab into view when it overflows the strip", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = emptyList("/Users/dev");
    render(panelUi());
    const router = fakeKeybindingRouter();

    // No auto-spawn: create the first terminal directly (a folder is pinned,
    // so ⇧⌘J creates synchronously, without depending on the chooser).
    act(() => {
      dispatchAction("app.terminal.new", router);
    });
    await waitFor(() => {
      expect(
        landingTerminalTabs(useLandingPanelStore.getState().tabs),
      ).toHaveLength(1);
    });

    const scrollIntoView = vi.spyOn(
      window.HTMLElement.prototype,
      "scrollIntoView",
    );
    // The "+" opens the chooser now; picking Terminal fills it in place.
    fireEvent.click(screen.getByTestId("landing-terminal-new-tab"));
    fireEvent.click(screen.getByTestId("landing-new-tab-card-terminal"));

    await waitFor(() => {
      expect(
        landingTerminalTabs(useLandingPanelStore.getState().tabs),
      ).toHaveLength(2);
    });

    const created = landingTerminalTabs(
      useLandingPanelStore.getState().tabs,
    )[1];
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
    render(panelUi());
    const router = fakeKeybindingRouter();

    // No auto-spawn: create the first terminal directly (a folder is pinned,
    // so ⇧⌘J creates synchronously, without depending on the chooser).
    act(() => {
      dispatchAction("app.terminal.new", router);
    });
    await waitFor(() => {
      expect(
        landingTerminalTabs(useLandingPanelStore.getState().tabs),
      ).toHaveLength(1);
    });
    const tab = landingTerminalTabs(useLandingPanelStore.getState().tabs)[0];

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
      expect(
        landingTerminalTabs(useLandingPanelStore.getState().tabs)[0]?.name,
      ).toBe("build");
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
    useLandingPanelStore.getState().addTab({
      kind: "terminal",
      instanceId: "running-instance",
      sessionId: "terminal-running",
      hostId: "host-a",
      cwd: "/stale",
      name: "Stale name",
      titleSource: "default",
      hostAuthorityAcknowledged: true,
    });
    useLandingPanelStore.getState().addTab({
      kind: "terminal",
      instanceId: "dormant-instance",
      sessionId: "terminal-dormant",
      hostId: "host-a",
      cwd: "/stale",
      name: "Stale dormant",
      titleSource: "default",
      hostAuthorityAcknowledged: true,
    });
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
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
    useLandingPanelStore.getState().addTab({
      kind: "terminal",
      instanceId: "unknown-instance",
      sessionId: "terminal-unknown",
      hostId: "host-a",
      cwd: "/stale",
      name: "Unknown runtime",
      titleSource: "default",
      hostAuthorityAcknowledged: true,
    });
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
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
      kind: "terminal" as const,
      instanceId: "shared-instance",
      sessionId: "terminal-shared",
      hostId: "host-a",
      cwd: "/legacy",
      name: "Legacy title",
      titleSource: "manual" as const,
      hostAuthorityAcknowledged: true,
    };
    useLandingPanelStore.getState().addTab(local);
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
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
    expect(
      landingTerminalTabs(useLandingPanelStore.getState().tabs)[0]?.name,
    ).not.toBe("Renamed everywhere");

    fireEvent.click(screen.getByRole("button", { name: "Close Shared title" }));
    await waitFor(() => {
      expect(mocks.plainCloseAsync).toHaveBeenCalledWith({
        hostId: "host-a",
        terminalId: "terminal-shared",
      });
      expect(useLandingPanelStore.getState().pendingKills).toEqual([]);
    });
    expect(mocks.kill).not.toHaveBeenCalled();
  });

  it("blocks rename and routes close through the kill path (not mutations.close) for a provider-login tab, even on a capable host", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    mocks.plainAuthorityStatus = "capable";
    mocks.plainCanMutate = true;
    const signInTab: LandingTerminalTabRef = {
      kind: "terminal",
      instanceId: "sign-in-instance",
      sessionId: "term-sign-in",
      hostId: "host-a",
      cwd: "~",
      name: "Reasonix sign-in",
      titleSource: "manual",
      origin: "provider-login",
      originProviderId: "reasonix",
    };
    useLandingPanelStore.getState().addTab(signInTab);
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    // Rename is disabled - the tab strip does not even attempt an inline
    // edit, since `terminal.plain.rename` would reject a manager-owned
    // session with no plain-terminal row.
    fireEvent.contextMenu(
      await screen.findByTestId("landing-terminal-tab-sign-in-instance"),
    );
    const renameItem = await screen.findByRole("menuitem", { name: "Rename" });
    expect(renameItem.getAttribute("data-disabled")).not.toBeNull();

    // `fireEvent.click` targets the node directly (no pointer hit-testing),
    // and the strip's `ContextMenu` is `modal={false}` (see
    // `landing-terminal-tab-strip.tsx`), so the still-open menu blocks
    // nothing here - closing it first would only add noise.
    fireEvent.click(
      screen.getByRole("button", { name: "Close Reasonix sign-in" }),
    );
    await waitFor(() => {
      expect(mocks.killAsync).toHaveBeenCalledWith({
        hostId: "host-a",
        sessionId: "term-sign-in",
      });
    });
    // The capable arm's shared mutation never sees a provider-login close -
    // it has no plain-terminal row to require, and would reject.
    expect(mocks.plainCloseAsync).not.toHaveBeenCalled();
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
    useLandingPanelStore.getState().addTab({
      kind: "terminal",
      instanceId: "owned-instance",
      sessionId: "terminal-owned",
      hostId: "host-a",
      cwd: "/legacy",
      name: "Legacy title",
      titleSource: "manual" as const,
      hostAuthorityAcknowledged: true,
    });
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);

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
      expect(useLandingPanelStore.getState().pendingKills).toHaveLength(1);
    });
    releaseOwner();
    await waitFor(() => expect(ownerClose).toHaveBeenCalledTimes(1));

    // It joined rather than sending its own, and left the record alone.
    expect(mocks.plainCloseAsync).not.toHaveBeenCalled();
    expect(useLandingPanelStore.getState().pendingKills).toHaveLength(1);
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
      kind: "terminal" as const,
      instanceId: "stale-instance",
      sessionId: "terminal-stale",
      hostId: "host-a",
      cwd: "/legacy",
      name: "Legacy title",
      titleSource: "manual" as const,
      hostAuthorityAcknowledged: true,
    };
    useLandingPanelStore.getState().addTab(local);
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    // The "+" is never disabled now - it opens the chooser, and the stale-
    // authority refusal is surfaced on the chooser's Terminal card instead.
    fireEvent.click(await screen.findByTestId("landing-terminal-new-tab"));
    const terminalCard = await screen.findByTestId(
      "landing-new-tab-card-terminal",
    );
    expect(terminalCard.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(terminalCard);
    expect(landingTerminalTabs(useLandingPanelStore.getState().tabs)).toEqual([
      local,
    ]);

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
      expect(landingTerminalTabs(useLandingPanelStore.getState().tabs)).toEqual(
        [],
      );
    });
    expect(useLandingPanelStore.getState().pendingKills).toEqual([
      {
        kind: "terminal",
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
      kind: "terminal" as const,
      instanceId: "unresolved-instance",
      sessionId: "terminal-unresolved",
      hostId: "host-a",
      cwd: "/workspace/project",
      name: "Unresolved title",
      titleSource: "default" as const,
    };
    useLandingPanelStore.getState().addTab(local);
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    const closeButton = await screen.findByRole("button", {
      name: "Close Unresolved title",
    });
    expect(
      closeButton instanceof HTMLButtonElement && closeButton.disabled,
    ).toBe(false);
    fireEvent.click(closeButton);

    await waitFor(() => {
      expect(landingTerminalTabs(useLandingPanelStore.getState().tabs)).toEqual(
        [],
      );
    });
    expect(useLandingPanelStore.getState().pendingKills).toEqual([
      {
        kind: "terminal",
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
      kind: "terminal" as const,
      instanceId: "ready-instance",
      sessionId: "terminal-ready",
      hostId: "host-a",
      cwd: "/legacy",
      name: "Legacy title",
      titleSource: "manual" as const,
      hostAuthorityAcknowledged: true,
    };
    useLandingPanelStore.getState().addTab(local);
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
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
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());
    const router = fakeKeybindingRouter();

    // The "+" is never disabled now; the refusal is on the chooser's Terminal
    // card, which the empty open panel shows immediately.
    const terminalCard = await screen.findByTestId(
      "landing-new-tab-card-terminal",
    );
    expect(terminalCard.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(terminalCard);
    // Bypasses the chooser entirely: before the fix, every creation path
    // funneled into `addTerminalTab` without consulting the host's authority
    // readiness, so a chord could still persist a tab that looked exactly
    // like legacy import evidence for a terminal never created on any host.
    act(() => {
      dispatchAction("app.terminal.new", router);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(
      landingTerminalTabs(useLandingPanelStore.getState().tabs),
    ).toHaveLength(0);
  });

  // Each card answers for its own half of the connection: the Terminal card
  // waits on the host's capability probe, the Browser card on the device
  // publishing an inventory. Neither blanks the panel - a body that says
  // nothing never explains what it is waiting to offer.
  it("says the device is still connecting on the card that is waiting for it", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    mocks.plainAuthorityStatus = "unknown";
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    const view = render(panelUi());

    await screen.findByTestId("landing-new-tab-chooser");
    await waitFor(() => {
      expect(
        screen.getByTestId("landing-new-tab-card-terminal-reason").textContent,
      ).toBe("Connecting to the selected host…");
      expect(
        screen.getByTestId("landing-new-tab-card-browser-reason").textContent,
      ).toBe("Connecting to the selected host…");
    });
    expect(
      screen
        .getByTestId("landing-new-tab-card-browser")
        .getAttribute("aria-disabled"),
    ).toBe("true");

    // The device answers for browsers first: its card goes live on its own,
    // without waiting for the terminal probe it has nothing to do with.
    mocks.browserSessionsByHost = {
      "host-a": browserSessionsState({}),
    };
    view.rerender(panelUi());

    await waitFor(() => {
      expect(
        screen.queryByTestId("landing-new-tab-card-browser-reason"),
      ).toBeNull();
    });
    expect(
      screen.getByTestId("landing-new-tab-card-terminal-reason").textContent,
    ).toBe("Connecting to the selected host…");
  });

  // The other end of the chooser's Browser card: the device answers, the card
  // comes alive, and picking it fills the placeholder IN PLACE from the ids the
  // device minted - never optimistically, which a reconciliation pass would
  // reconcile straight back out.
  it("opens a browser tab into the placeholder once the device has published an inventory", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    mocks.plainAuthorityStatus = "capable";
    mocks.plainCanMutate = true;
    const openTab = vi.fn(() =>
      Promise.resolve({ sessionId: "device-session", tabId: "device-tab" }),
    );
    mocks.browserSessionsByHost = {
      "host-a": browserSessionsState({ openTab }),
    };
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    const browserCard = await screen.findByTestId(
      "landing-new-tab-card-browser",
    );
    await waitFor(() => {
      expect(browserCard.getAttribute("aria-disabled")).toBeNull();
    });
    fireEvent.click(browserCard);

    await waitFor(() => {
      expect(useLandingPanelStore.getState().tabs).toHaveLength(1);
    });
    expect(openTab).toHaveBeenCalledWith(null, "about:blank");
    const [opened] = useLandingPanelStore.getState().tabs;
    expect(opened.kind).toBe("browser");
    expect(opened.sessionId).toBe("device-session");
    // Filled, not stacked beside: the placeholder is gone and the new tab is
    // the active row.
    expect(useLandingPanelStore.getState().placeholder).toBe(null);
    expect(useLandingPanelStore.getState().activeInstanceId).toBe(
      opened.instanceId,
    );
  });

  // The opener's in-flight state has to REACH the card. Without it the chooser
  // shows an enabled Browser card while a tab is already on its way, which is
  // the one place a second click is easiest to make.
  it("marks the chooser's browser card pending while the device is answering", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    mocks.plainAuthorityStatus = "capable";
    mocks.plainCanMutate = true;
    let settle: ((identity: BrowserTabIdentity) => void) | null = null;
    const openTab = vi.fn(
      () =>
        new Promise<BrowserTabIdentity>((resolve) => {
          settle = resolve;
        }),
    );
    mocks.browserSessionsByHost = {
      "host-a": browserSessionsState({ openTab }),
    };
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    const browserCard = await screen.findByTestId(
      "landing-new-tab-card-browser",
    );
    await waitFor(() => {
      expect(browserCard.getAttribute("aria-disabled")).toBeNull();
    });
    fireEvent.click(browserCard);

    await waitFor(() => {
      expect(
        screen.getByTestId("landing-new-tab-card-browser-pending"),
      ).toBeTruthy();
    });
    expect(browserCard.getAttribute("aria-disabled")).toBe("true");
    // A second click while the first is unanswered reaches nothing.
    fireEvent.click(browserCard);
    expect(openTab).toHaveBeenCalledTimes(1);

    await act(async () => {
      settle?.({ sessionId: "device-session", tabId: "device-tab" });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(useLandingPanelStore.getState().tabs).toHaveLength(1);
    });
  });

  // A browser stream costs a socket, a relay attach, an identity attestation
  // and a contributed-set replay, and the desktop caps a window at twelve of
  // them and refuses whichever is asked for LAST. So a panel holding streams
  // for devices it is showing nothing of can cost the reader the very tab they
  // just opened.
  it("drops every tab host's stream when the panel is collapsed", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    useLandingPanelStore.getState().addTab({
      kind: "browser",
      instanceId: "browser-a",
      hostId: "host-a",
      sessionId: "session-a",
      tabId: "tab-a",
      name: "a.example",
      titleSource: "default",
    });
    useLandingPanelStore.getState().addTab({
      kind: "browser",
      instanceId: "browser-b",
      hostId: "host-b",
      sessionId: "session-b",
      tabId: "tab-b",
      name: "b.example",
      titleSource: "default",
    });
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    // Open: every tab host, because the strip is rendering a row for each and
    // those rows read their title and dormancy from that device's inventory.
    await waitFor(() => {
      expect([...mocks.browserStreamHostIds].sort()).toEqual([
        "host-a",
        "host-b",
      ]);
    });

    act(() => {
      useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, false);
    });

    // Collapsed: nothing of those devices is on screen, so nothing holds their
    // streams. The TARGET host stays - `app.browser.new` reveals the panel and
    // opens through that device's coordinator, and the chooser's cap count
    // reads the same one.
    await waitFor(() => {
      expect(mocks.browserStreamHostIds).toEqual(["host-a"]);
    });
  });

  // The other half of the ruling this restores: the target device is on a
  // stream before any browser tab exists, which is what the chord and the
  // chooser's count both need.
  it("keeps the target host's stream with no browser tab open", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    mocks.browserSessionsByHost = {
      "host-a": browserSessionsState({
        items: [
          sessionInfo({
            sessionId: "independent-session",
            hostId: "host-a",
            scope: independentScope(),
            tabs: [tabInfo({ tabId: "existing", url: "https://example.com/" })],
          }),
        ],
      }),
    };
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    await waitFor(() => {
      expect(mocks.browserStreamHostIds).toEqual(["host-a"]);
    });
    // And the count that stream carries reaches the card, which is the whole
    // reason the ruling held it unconditionally.
    const browserCard = await screen.findByTestId(
      "landing-new-tab-card-browser",
    );
    await waitFor(() => {
      expect(browserCard.getAttribute("aria-disabled")).toBeNull();
    });
    expect(
      screen.queryByTestId("landing-new-tab-card-browser-reason"),
    ).toBeNull();
  });

  // The chooser's cap count and `app.browser.new` both read the TARGET host's
  // coordinator, which the panel pins unconditionally - so both must still
  // work while the panel itself is collapsed and showing nothing.
  it("opens a browser tab via app.browser.new with the panel collapsed", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    const openTab = vi.fn(() =>
      Promise.resolve({ sessionId: "device-session", tabId: "device-tab" }),
    );
    mocks.browserSessionsByHost = {
      "host-a": browserSessionsState({ openTab }),
    };
    render(panelUi());
    const router = fakeKeybindingRouter();

    expect(testLayout().panelOpen).toBe(false);
    await waitFor(() => {
      expect(mocks.browserStreamHostIds).toEqual(["host-a"]);
    });

    act(() => {
      dispatchAction("app.browser.new", router);
    });

    await waitFor(() => {
      expect(testLayout().panelOpen).toBe(true);
    });
    // Redden: if the target host were not mounted while collapsed, its
    // sessions state would still be `null` here and the open would never
    // reach the device's `openTab`.
    await waitFor(() => {
      expect(openTab).toHaveBeenCalledWith(null, "about:blank");
    });
  });

  // A browser stream is a socket, a relay attach, an identity attestation and
  // a contributed-set replay, and the desktop refuses whichever window stream
  // is asked for LAST past its cap - so a strip with tabs on many devices must
  // not exhaust it with rows nobody is looking at.
  it("mounts at most LANDING_BROWSER_WATCHED_HOST_CAP hosts, with the target and the active tab's host always among them, across tabs on six devices", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    for (const hostId of [
      "host-a",
      "host-b",
      "host-c",
      "host-d",
      "host-e",
      "host-f",
    ]) {
      addBrowserTab(hostId, `browser-${hostId}`);
    }
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    // Redden: without the bound, all six tab hosts would be mounted.
    await waitFor(() => {
      expect(mocks.browserStreamHostIds).toHaveLength(
        LANDING_BROWSER_WATCHED_HOST_CAP,
      );
    });
    expect(mocks.browserStreamHostIds).toContain("host-a");
    // `host-f` is the last tab added, so `addTab` left it active.
    expect(mocks.browserStreamHostIds).toContain("host-f");
  });

  // The other half of the LRU: an activation past the bound brings its device
  // in and must make room by evicting the least recently activated one that
  // is not pinned - never the target, never the newly active host.
  it("activating a row of an unwatched host mounts it and evicts the least recently activated non-pinned host", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    // Strip order e, a, b, c, d; `d` ends active (last added). With the
    // target (a) and active (d) pinned, the two-slot budget fills from strip
    // order and lands on e and b - c is left unwatched.
    for (const [hostId, instanceId] of [
      ["host-e", "browser-e"],
      ["host-a", "browser-a"],
      ["host-b", "browser-b"],
      ["host-c", "browser-c"],
      ["host-d", "browser-d"],
    ] as const) {
      addBrowserTab(hostId, instanceId);
    }
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    await waitFor(() => {
      expect(mocks.browserStreamHostIds).toHaveLength(
        LANDING_BROWSER_WATCHED_HOST_CAP,
      );
    });
    expect(mocks.browserStreamHostIds).not.toContain("host-c");

    fireEvent.click(screen.getByTestId("landing-terminal-tab-browser-c"));

    await waitFor(() => {
      expect(mocks.browserStreamHostIds).toContain("host-c");
    });
    // Redden: without eviction the set would grow to five instead of holding
    // at the cap, and the previously-idle `host-b` (recency's tiebreak loser
    // against untouched `host-c`) would survive alongside it.
    expect(mocks.browserStreamHostIds).toHaveLength(
      LANDING_BROWSER_WATCHED_HOST_CAP,
    );
    expect(mocks.browserStreamHostIds).not.toContain("host-b");
    // The target and the newly active host both survive the eviction.
    expect(mocks.browserStreamHostIds).toContain("host-a");
  });

  // A row past the bound is rendered from the store alone: no dormancy claim
  // and no outage claim, even when the store already has (or would have) an
  // answer for that device - this window just isn't watching it.
  it("shows `· not watched` on an unwatched row and neither `dormant` nor `status unavailable`, even where the store would otherwise report unavailable", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    for (const [hostId, instanceId] of [
      ["host-e", "browser-e"],
      ["host-a", "browser-a"],
      ["host-b", "browser-b"],
      ["host-c", "browser-c"],
      ["host-d", "browser-d"],
    ] as const) {
      addBrowserTab(hostId, instanceId);
    }
    // What the store would report for the unwatched host if it were watched -
    // still no inventory, the same shape a healthy-but-quiet device leaves.
    mocks.browserSessionsByHost = {
      "host-c": browserSessionsState({ inventoryReady: false }),
    };
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    await waitFor(() => {
      expect(mocks.browserStreamHostIds).not.toContain("host-c");
    });
    // Redden: without the unwatched branch this row would read `sessions` as
    // absent and render `status unavailable` instead.
    expect(
      screen.getByTestId("landing-terminal-unwatched-browser-c"),
    ).toBeTruthy();
    expect(
      screen.queryByTestId("landing-terminal-dormant-browser-c"),
    ).toBeNull();
    expect(
      screen.queryByTestId("landing-terminal-unavailable-browser-c"),
    ).toBeNull();
  });

  // The bound is on DEVICES, not tabs - a device costs one stream however
  // many rows it holds in the strip.
  it("counts hosts, not tabs: eight tabs on two devices mount exactly two streams", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    for (let index = 0; index < 4; index += 1) {
      addBrowserTab("host-a", `browser-a-${index}`);
      addBrowserTab("host-b", `browser-b-${index}`);
    }
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    // Redden: counting by tab rather than by host would either exceed two
    // streams or under/over-count relative to the eight rows in the strip.
    await waitFor(() => {
      expect([...mocks.browserStreamHostIds].sort()).toEqual([
        "host-a",
        "host-b",
      ]);
    });
  });

  // Two provider seams acquire the SAME refcounted coordinator - the fleet's
  // arm above, and each tile's own `BrowserSessionsHostProvider`. If the
  // panel computed the bound but never handed it to the tile, the tile would
  // mount every tab host's stream on its own and the bound would hold nothing
  // back.
  it("hands each tile a watched prop matching the bound", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    for (const [hostId, instanceId] of [
      ["host-e", "browser-e"],
      ["host-a", "browser-a"],
      ["host-b", "browser-b"],
      ["host-c", "browser-c"],
      ["host-d", "browser-d"],
    ] as const) {
      addBrowserTab(hostId, instanceId);
    }
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    await waitFor(() => {
      expect(mocks.browserStreamHostIds).not.toContain("host-c");
    });
    // Redden: a tile that always reports itself watched (or whose `watched`
    // prop was never threaded through) would read "true" here too.
    expect(
      screen
        .getByTestId("landing-browser-tile-browser-c")
        .getAttribute("data-watched"),
    ).toBe("false");
    expect(
      screen
        .getByTestId("landing-browser-tile-browser-a")
        .getAttribute("data-watched"),
    ).toBe("true");
  });

  // A shell with no native browser capability can only WATCH a browser tab -
  // the tile renders "View only" and an independent session has no agent
  // driving it either - so the card would open a blank page nobody can
  // navigate. Unlike the cap or the connecting wait, this does not resolve.
  it("refuses the browser card on a shell that could only watch the tab", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    mocks.plainAuthorityStatus = "capable";
    mocks.plainCanMutate = true;
    // Web / mobile: no native browser capability.
    mocks.runnerHostHasBrowserView = false;
    const openTab = vi.fn(() =>
      Promise.resolve({ sessionId: "device-session", tabId: "device-tab" }),
    );
    mocks.browserSessionsByHost = {
      "host-a": browserSessionsState({ openTab }),
    };
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    const browserCard = await screen.findByTestId(
      "landing-new-tab-card-browser",
    );
    // Disabled with a reason, the same shape the cap and the connecting wait
    // use - and it stays that way, because a device answering changes nothing.
    await waitFor(() => {
      expect(browserCard.getAttribute("aria-disabled")).toBe("true");
    });
    expect(
      screen.getByTestId("landing-new-tab-card-browser-reason").textContent,
    ).toBe("Browser tabs need the desktop app");

    fireEvent.click(browserCard);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(openTab).not.toHaveBeenCalled();
    // The chooser is still there to pick a terminal from.
    expect(useLandingPanelStore.getState().placeholder).not.toBe(null);

    // The Terminal card is untouched: a shell that cannot drive a browser can
    // still open a shell.
    expect(
      screen
        .getByTestId("landing-new-tab-card-terminal")
        .getAttribute("aria-disabled"),
    ).toBeNull();
  });

  // The chooser's two cards are two answers to ONE row, and the device takes
  // time over the browser one. A reader who changes their mind mid-flight is
  // looking at the terminal they picked second; the browser answer arriving
  // afterwards must not pull the keyboard onto a row they moved away from.
  it("keeps the keyboard with the pick the reader made last", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    mocks.plainAuthorityStatus = "capable";
    mocks.plainCanMutate = true;
    let settle: ((identity: BrowserTabIdentity) => void) | null = null;
    const openTab = vi.fn(
      () =>
        new Promise<BrowserTabIdentity>((resolve) => {
          settle = resolve;
        }),
    );
    mocks.browserSessionsByHost = {
      "host-a": browserSessionsState({ openTab }),
    };
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    const browserCard = await screen.findByTestId(
      "landing-new-tab-card-browser",
    );
    await waitFor(() => {
      expect(browserCard.getAttribute("aria-disabled")).toBeNull();
    });
    fireEvent.click(browserCard);
    await waitFor(() => {
      expect(openTab).toHaveBeenCalledTimes(1);
    });

    // Second thoughts, while the device is still answering the first pick.
    fireEvent.click(screen.getByTestId("landing-new-tab-card-terminal"));
    await waitFor(() => {
      expect(useLandingPanelStore.getState().tabs).toHaveLength(1);
    });
    const terminal = useLandingPanelStore.getState().tabs[0];
    expect(terminal.kind).toBe("terminal");
    expect(useLandingPanelStore.getState().activeInstanceId).toBe(
      terminal.instanceId,
    );

    await act(async () => {
      settle?.({ sessionId: "device-session", tabId: "device-tab" });
      await Promise.resolve();
    });

    // The browser tab landed - the device opened it, and dropping it would
    // leave a tab on the device with no row here.
    await waitFor(() => {
      expect(useLandingPanelStore.getState().tabs).toHaveLength(2);
    });
    expect(useLandingPanelStore.getState().tabs[1].kind).toBe("browser");
    // ...  and the terminal the reader actually chose still has the keyboard.
    expect(useLandingPanelStore.getState().activeInstanceId).toBe(
      terminal.instanceId,
    );
  });

  it("closes every terminal from the context menu, tombstoning before killing", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = emptyList("/Users/dev");
    render(panelUi());
    const router = fakeKeybindingRouter();

    // No auto-spawn: create the first terminal directly (a folder is pinned,
    // so ⇧⌘J creates synchronously, without depending on the chooser).
    act(() => {
      dispatchAction("app.terminal.new", router);
    });
    await waitFor(() => {
      expect(
        landingTerminalTabs(useLandingPanelStore.getState().tabs),
      ).toHaveLength(1);
    });
    fireEvent.click(screen.getByTestId("landing-terminal-new-tab"));
    fireEvent.click(screen.getByTestId("landing-new-tab-card-terminal"));
    await waitFor(() => {
      expect(
        landingTerminalTabs(useLandingPanelStore.getState().tabs),
      ).toHaveLength(2);
    });
    const before = landingTerminalTabs(useLandingPanelStore.getState().tabs);

    fireEvent.contextMenu(
      screen.getByTestId(`landing-terminal-tab-${before[0].instanceId}`),
    );
    fireEvent.click(await screen.findByText("Close All"));

    await waitFor(() => {
      expect(
        landingTerminalTabs(useLandingPanelStore.getState().tabs),
      ).toHaveLength(0);
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

  // The two senders, mounted together for the first time. The panel had a fast
  // path AND the always-mounted drain watches the same tombstone set, so one
  // gesture sent two closes - the second racing a tab the host had already
  // removed.
  it("sends exactly one host close for one panel close", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    // The device answers LATE, which is the only timing in which a second
    // sender is visible: a `Promise.resolve()` close clears the tombstone in a
    // microtask, before the drain's effect ever reads it, so an instant mock
    // hides the very collision this pins. A real device takes milliseconds.
    let settleClose: (() => void) | null = null;
    mocks.browserCloseTab.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          settleClose = resolve;
        }),
    );
    // The inventory still LISTS the tab, which is the whole point: the device
    // has been asked and has not answered, so its published snapshot is
    // unchanged. An empty inventory makes the drain decide `clear` and retire
    // the tombstone without sending - a second vacuum on top of the first.
    mocks.browserSessionsByHost = {
      "host-a": browserSessionsState({
        closeTab: mocks.browserCloseTab,
        items: [
          sessionInfo({
            sessionId: "browser-session",
            hostId: "host-a",
            scope: independentScope(),
            // Titled, because reconciliation renames an untitled tab to its
            // URL and the close control is labelled from the name.
            tabs: [
              tabInfo({
                tabId: "browser-tab",
                url: "https://example.com/",
                title: "example.com",
              }),
            ],
          }),
        ],
      }),
    };
    useLandingPanelStore.getState().addTab({
      kind: "browser",
      instanceId: "browser-instance",
      hostId: "host-a",
      sessionId: "browser-session",
      tabId: "browser-tab",
      name: "example.com",
      titleSource: "default",
    });
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(
      <>
        {panelUi()}
        <BrowserTombstoneDrainProbe />
      </>,
    );

    fireEvent.click(screen.getByLabelText("Close example.com"));

    // The tombstone is written and the tab is gone from the strip; the device
    // has not answered, and the inventory still lists the tab.
    await waitFor(() => {
      expect(useLandingPanelStore.getState().pendingKills).toHaveLength(1);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mocks.browserCloseTab).toHaveBeenCalledTimes(1);
    expect(mocks.browserCloseTab).toHaveBeenCalledWith(
      "browser-session",
      "browser-tab",
    );

    await act(async () => {
      settleClose?.();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(useLandingPanelStore.getState().pendingKills).toEqual([]);
    });
    expect(mocks.browserCloseTab).toHaveBeenCalledTimes(1);
  });

  // "Close All" over a MIXED list: one strip, two kinds, two different close
  // boundaries. Routing per tab is the whole point - a partition by list would
  // send a browser tab's ids to the terminal kill, which the host answers by
  // killing nothing and the panel by never clearing the tombstone.
  it("routes close-all to each kind's own boundary, and takes the placeholder with it", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    mocks.plainAuthorityStatus = "capable";
    mocks.plainCanMutate = true;
    mocks.browserSessionsByHost = {
      "host-a": browserSessionsState({
        closeTab: mocks.browserCloseTab,
        items: [
          sessionInfo({
            sessionId: "browser-session",
            hostId: "host-a",
            scope: independentScope(),
            tabs: [
              tabInfo({
                tabId: "browser-tab",
                url: "https://example.com/",
                title: "example.com",
              }),
            ],
          }),
        ],
      }),
    };
    const terminalTab = {
      kind: "terminal" as const,
      instanceId: "terminal-instance",
      sessionId: "terminal-session",
      hostId: "host-a",
      cwd: "/workspace/project",
      name: "project",
      titleSource: "default" as const,
      hostAuthorityAcknowledged: true,
    };
    const browserTab = {
      kind: "browser" as const,
      instanceId: "browser-instance",
      hostId: "host-a",
      sessionId: "browser-session",
      tabId: "browser-tab",
      name: "example.com",
      titleSource: "default" as const,
    };
    useLandingPanelStore.getState().addTab(terminalTab);
    useLandingPanelStore.getState().addTab(browserTab);
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    // The browser half of "its own boundary" is the drain, so the drain has to
    // be here for the boundary to be observable at all.
    render(
      <>
        {panelUi()}
        <BrowserTombstoneDrainProbe />
      </>,
    );

    // A third strip row that is neither kind: an unpicked placeholder.
    fireEvent.click(screen.getByTestId("landing-terminal-new-tab"));
    await screen.findByTestId("landing-new-tab-chooser");

    fireEvent.contextMenu(
      screen.getByTestId(`landing-terminal-tab-${terminalTab.instanceId}`),
    );
    fireEvent.click(await screen.findByText("Close All"));

    await waitFor(() => {
      expect(useLandingPanelStore.getState().tabs).toHaveLength(0);
    });
    expect(useLandingPanelStore.getState().placeholder).toBe(null);
    expect(testLayout().panelOpen).toBe(false);

    // Each kind reached its own boundary, with its own ids: the terminal
    // through its dispatch, the browser through the tombstone the drain sends.
    await waitFor(() => {
      expect(mocks.plainCloseAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          hostId: "host-a",
          terminalId: terminalTab.sessionId,
        }),
      );
      expect(mocks.browserCloseTab).toHaveBeenCalledWith(
        browserTab.sessionId,
        browserTab.tabId,
      );
    });
    expect(mocks.plainCloseAsync).toHaveBeenCalledTimes(1);
    expect(mocks.browserCloseTab).toHaveBeenCalledTimes(1);
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
      kind: "terminal" as const,
      instanceId: "ready-instance",
      sessionId: "terminal-ready",
      hostId: "host-a",
      cwd: "/workspace/project",
      name: "Ready title",
      titleSource: "default" as const,
      hostAuthorityAcknowledged: true,
    };
    const notReadyTab = {
      kind: "terminal" as const,
      instanceId: "not-ready-instance",
      sessionId: "terminal-not-ready",
      hostId: "host-b",
      cwd: "/workspace/other",
      name: "Not ready title",
      titleSource: "default" as const,
      hostAuthorityAcknowledged: true,
    };
    useLandingPanelStore.getState().addTab(readyTab);
    useLandingPanelStore.getState().addTab(notReadyTab);
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    await screen.findByTestId(`landing-terminal-tab-${readyTab.instanceId}`);
    await screen.findByTestId(`landing-terminal-tab-${notReadyTab.instanceId}`);

    fireEvent.contextMenu(
      screen.getByTestId(`landing-terminal-tab-${readyTab.instanceId}`),
    );
    fireEvent.click(await screen.findByText("Close All"));

    await waitFor(() => {
      expect(landingTerminalTabs(useLandingPanelStore.getState().tabs)).toEqual(
        [],
      );
    });
    // Tombstone-first, batched: both refs are durably recorded - the
    // not-ready host's tombstone is the recovery bridge's only record that a
    // shell needs killing once that host becomes dialable.
    expect(useLandingPanelStore.getState().pendingKills).toEqual(
      expect.arrayContaining([
        {
          kind: "terminal",
          hostId: "host-a",
          sessionId: "terminal-ready",
          hostAuthorityAcknowledged: true,
          pendingCreate: false,
        },
        {
          kind: "terminal",
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
      expect(useLandingPanelStore.getState().pendingKills).toEqual([
        {
          kind: "terminal",
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
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    await waitFor(() => {
      expect(
        landingTerminalTabs(useLandingPanelStore.getState().tabs),
      ).toHaveLength(1);
      expect(
        landingTerminalTabs(useLandingPanelStore.getState().tabs)[0]?.sessionId,
      ).toBe("orphan");
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
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    await waitFor(() => {
      expect(
        landingTerminalTabs(useLandingPanelStore.getState().tabs),
      ).toHaveLength(1);
      expect(
        landingTerminalTabs(useLandingPanelStore.getState().tabs)[0]?.sessionId,
      ).toBe("fresh-orphan");
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
    useLandingPanelStore.getState().addTab({
      kind: "terminal",
      instanceId: "tab-1",
      sessionId: "still-running",
      hostId: "host-a",
      cwd: "/workspace/project",
      name: "project",
      titleSource: "default",
    });
    useLandingPanelStore.getState().closeTab(TEST_LANDING_PAGE_ID, "tab-1");
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    await waitFor(() => {
      expect(mocks.killAsync).toHaveBeenCalledWith({
        hostId: "host-a",
        sessionId: "still-running",
      });
    });
    expect(useLandingPanelStore.getState().pendingKills).toEqual([
      {
        kind: "terminal",
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
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    const view = render(panelUi());

    // No auto-spawn: the empty panel opens onto the chooser; pick Terminal
    // once the host's home resolves to get the "home" terminal this test is
    // about.
    const terminalCard = await screen.findByTestId(
      "landing-new-tab-card-terminal",
    );
    await waitFor(() => {
      expect(terminalCard.getAttribute("aria-disabled")).toBeNull();
    });
    fireEvent.click(terminalCard);
    await waitFor(() => {
      expect(
        landingTerminalTabs(useLandingPanelStore.getState().tabs),
      ).toHaveLength(1);
    });
    const homeTab = landingTerminalTabs(
      useLandingPanelStore.getState().tabs,
    )[0];
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
    expect(landingTerminalTabs(useLandingPanelStore.getState().tabs)).toEqual([
      homeTab,
    ]);
    expect(useLandingPanelStore.getState().activeInstanceId).toBe(
      homeTab.instanceId,
    );

    fireEvent.click(screen.getByTestId("landing-terminal-new-tab"));
    fireEvent.click(screen.getByTestId("landing-new-tab-card-terminal"));
    await waitFor(() => {
      expect(
        landingTerminalTabs(useLandingPanelStore.getState().tabs),
      ).toHaveLength(2);
    });
    const created = landingTerminalTabs(
      useLandingPanelStore.getState().tabs,
    ).find((tab) => tab.instanceId !== homeTab.instanceId);
    expect(created?.cwd).toBe("/workspace/project");
  });

  it("answers the epic tab chords: new, prev/next, and close", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    render(panelUi());
    const router = fakeKeybindingRouter();

    // No auto-spawn: create the first terminal directly.
    act(() => {
      dispatchAction("app.terminal.new", router);
    });
    await waitFor(() => {
      expect(
        landingTerminalTabs(useLandingPanelStore.getState().tabs),
      ).toHaveLength(1);
    });

    // tab.new (⌘T) opens the chooser rather than creating directly; picking
    // Terminal fills the placeholder in place.
    act(() => {
      dispatchAction("tab.new", router);
    });
    expect(screen.getByTestId("landing-new-tab-chooser")).toBeTruthy();
    expect(
      landingTerminalTabs(useLandingPanelStore.getState().tabs),
    ).toHaveLength(1);
    fireEvent.click(screen.getByTestId("landing-new-tab-card-terminal"));
    await waitFor(() => {
      expect(
        landingTerminalTabs(useLandingPanelStore.getState().tabs),
      ).toHaveLength(2);
    });
    const [first, second] = landingTerminalTabs(
      useLandingPanelStore.getState().tabs,
    );
    expect(useLandingPanelStore.getState().activeInstanceId).toBe(
      second.instanceId,
    );

    act(() => {
      dispatchAction("tab.prev", router);
    });
    expect(useLandingPanelStore.getState().activeInstanceId).toBe(
      first.instanceId,
    );
    act(() => {
      dispatchAction("tab.next", router);
    });
    expect(useLandingPanelStore.getState().activeInstanceId).toBe(
      second.instanceId,
    );

    act(() => {
      dispatchAction("tab.close", router);
    });
    await waitFor(() => {
      expect(
        landingTerminalTabs(useLandingPanelStore.getState().tabs),
      ).toHaveLength(1);
    });
    expect(
      landingTerminalTabs(useLandingPanelStore.getState().tabs)[0].instanceId,
    ).toBe(first.instanceId);
    await waitFor(() => {
      expect(mocks.killAsync).toHaveBeenCalledWith({
        hostId: second.hostId,
        sessionId: second.sessionId,
      });
    });
  });

  it("switches terminal tabs with the leader digit chord", () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    useLandingPanelStore.getState().addTab({
      kind: "terminal",
      instanceId: "tab-1",
      sessionId: "session-1",
      hostId: "host-a",
      cwd: "/workspace/project",
      name: "project",
      titleSource: "default",
    });
    useLandingPanelStore.getState().addTab({
      kind: "terminal",
      instanceId: "tab-2",
      sessionId: "session-2",
      hostId: "host-a",
      cwd: "/workspace/project",
      name: "project 2",
      titleSource: "default",
    });
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    const [first, second] = landingTerminalTabs(
      useLandingPanelStore.getState().tabs,
    );
    expect(useLandingPanelStore.getState().activeInstanceId).toBe(
      second.instanceId,
    );

    const match = matchDigitAction(leaderDigitEvent("Digit1"));
    expect(match?.actionId).toBe("tab.switch.byDigit");
    act(() => {
      expect(match?.run()).toBe(true);
    });
    expect(useLandingPanelStore.getState().activeInstanceId).toBe(
      first.instanceId,
    );

    // A digit past the last tab falls through instead of claiming the chord.
    const outOfRange = matchDigitAction(leaderDigitEvent("Digit9"));
    expect(outOfRange?.run()).toBe(false);
  });

  // The strip renders `landingStripRows`, which splices the placeholder in at
  // its own index; the chords used to index `state.tabs`. Two projections are
  // two orders the moment the placeholder is not last - and it need not be,
  // since a reconciliation adoption appends past it.
  function seedStripFixture(
    count: number,
    placeholderIndex: number | null,
  ): void {
    const store = useLandingPanelStore.getState();
    for (let index = 1; index <= count; index += 1) {
      store.addTab({
        kind: "terminal",
        instanceId: `tab-${index}`,
        sessionId: `session-${index}`,
        hostId: "host-a",
        cwd: "/workspace/project",
        name: `project ${index}`,
        titleSource: "default",
      });
    }
    store.setPanelOpen(TEST_LANDING_PAGE_ID, true);
    if (placeholderIndex !== null) {
      useLandingPanelStore
        .getState()
        .openPlaceholder("placeholder-1", placeholderIndex);
    }
  }

  function seedStripHost(): void {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
  }

  it("steps tab.next and tab.prev OVER the placeholder row, from either side", () => {
    seedStripHost();
    // Rows: [tab-1, placeholder, tab-2, tab-3].
    seedStripFixture(3, 1);
    render(panelUi());
    const router = fakeKeybindingRouter();

    act(() => {
      useLandingPanelStore.getState().activateTab("tab-1");
    });
    act(() => {
      dispatchAction("tab.next", router);
    });
    expect(useLandingPanelStore.getState().activeInstanceId).toBe("tab-2");

    // From the placeholder itself: forward is the first real tab AFTER it,
    // backward the one before. Before this, `findIndex` returned -1 and
    // `Math.max(index, 0)` turned it into 0, so next skipped tab-1 entirely.
    act(() => {
      useLandingPanelStore.getState().activateTab("placeholder-1");
    });
    act(() => {
      dispatchAction("tab.next", router);
    });
    expect(useLandingPanelStore.getState().activeInstanceId).toBe("tab-2");

    act(() => {
      useLandingPanelStore.getState().activateTab("placeholder-1");
    });
    act(() => {
      dispatchAction("tab.prev", router);
    });
    expect(useLandingPanelStore.getState().activeInstanceId).toBe("tab-1");
  });

  it("wraps around the placeholder when it sits at either end", () => {
    seedStripHost();
    // Rows: [placeholder, tab-1, tab-2].
    seedStripFixture(2, 0);
    render(panelUi());
    const router = fakeKeybindingRouter();

    act(() => {
      dispatchAction("tab.prev", router);
    });
    expect(useLandingPanelStore.getState().activeInstanceId).toBe("tab-2");

    act(() => {
      useLandingPanelStore.getState().activateTab("tab-2");
    });
    act(() => {
      dispatchAction("tab.next", router);
    });
    expect(useLandingPanelStore.getState().activeInstanceId).toBe("tab-1");
  });

  it("counts REAL tabs in the move guard, so one tab beside the chooser is reachable", () => {
    seedStripHost();
    // Rows: [tab-1, placeholder], with the placeholder active.
    seedStripFixture(1, 1);
    render(panelUi());
    const router = fakeKeybindingRouter();

    // `state.tabs.length < 2` made this a no-op, so with the chooser open
    // beside a single terminal the chord could not reach that terminal at all.
    act(() => {
      dispatchAction("tab.next", router);
    });
    expect(useLandingPanelStore.getState().activeInstanceId).toBe("tab-1");
  });

  it("still refuses to move with one tab and no placeholder", () => {
    seedStripHost();
    seedStripFixture(1, null);
    render(panelUi());
    const router = fakeKeybindingRouter();

    act(() => {
      dispatchAction("tab.next", router);
    });
    expect(useLandingPanelStore.getState().activeInstanceId).toBe("tab-1");
  });

  it("counts digits over the REAL rows in display order, with the placeholder first", () => {
    seedStripHost();
    // Rows: [placeholder, tab-1, tab-2].
    seedStripFixture(2, 0);
    render(panelUi());

    act(() => {
      expect(matchDigitAction(leaderDigitEvent("Digit1"))?.run()).toBe(true);
    });
    expect(useLandingPanelStore.getState().activeInstanceId).toBe("tab-1");

    act(() => {
      expect(matchDigitAction(leaderDigitEvent("Digit2"))?.run()).toBe(true);
    });
    expect(useLandingPanelStore.getState().activeInstanceId).toBe("tab-2");

    // Three rows are on screen, but only two are reachable by digit - the
    // placeholder is never a destination.
    act(() => {
      expect(matchDigitAction(leaderDigitEvent("Digit3"))?.run()).toBe(false);
    });
    expect(useLandingPanelStore.getState().activeInstanceId).toBe("tab-2");
  });

  it("counts digits over the REAL rows in display order, with the placeholder in the middle", () => {
    seedStripHost();
    // Rows: [tab-1, placeholder, tab-2, tab-3].
    seedStripFixture(3, 1);
    render(panelUi());

    act(() => {
      expect(matchDigitAction(leaderDigitEvent("Digit2"))?.run()).toBe(true);
    });
    expect(useLandingPanelStore.getState().activeInstanceId).toBe("tab-2");

    act(() => {
      expect(matchDigitAction(leaderDigitEvent("Digit3"))?.run()).toBe(true);
    });
    expect(useLandingPanelStore.getState().activeInstanceId).toBe("tab-3");
  });

  it("maximizes and restores via app.terminal.maximize, revealing when collapsed", () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    useLandingPanelStore.getState().addTab({
      kind: "terminal",
      instanceId: "tab-1",
      sessionId: "session-1",
      hostId: "host-a",
      cwd: "/workspace/project",
      name: "project",
      titleSource: "default",
    });
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());
    const router = fakeKeybindingRouter();

    expect(screen.queryByRole("button", { name: "Restore panel" })).toBeNull();

    act(() => {
      dispatchAction("app.terminal.maximize", router);
    });
    expect(
      screen.queryByRole("button", { name: "Restore panel" }),
    ).not.toBeNull();

    act(() => {
      dispatchAction("app.terminal.maximize", router);
    });
    expect(screen.queryByRole("button", { name: "Restore panel" })).toBeNull();

    // Collapsed panel: the chord reveals and maximizes in one stroke.
    fireEvent.click(screen.getByRole("button", { name: "Collapse panel" }));
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
      screen.queryByRole("button", { name: "Restore panel" }),
    ).not.toBeNull();
  });

  it("explains the disabled Terminal card when an old host cannot report homeCwd", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = null;
    mocks.probeData = emptyList(null);
    mocks.freshProbeData = mocks.probeData;
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    // The empty state is displaced by the chooser; the "+" is never disabled
    // now, and the old-host guidance lives on the chooser's Terminal card.
    expect(screen.queryByTestId("landing-terminal-host-update")).toBeNull();
    const plus = await screen.findByTestId("landing-terminal-new-tab");
    expect(plus.getAttribute("aria-disabled")).toBeNull();

    const terminalCard = await screen.findByTestId(
      "landing-new-tab-card-terminal",
    );
    await waitFor(() => {
      expect(terminalCard.getAttribute("aria-disabled")).toBe("true");
    });
    // aria-disabled instead of the native attr keeps it inert but reachable.
    fireEvent.click(terminalCard);
    expect(
      landingTerminalTabs(useLandingPanelStore.getState().tabs),
    ).toHaveLength(0);
    expect(
      screen.getByTestId("landing-new-tab-card-terminal-reason").textContent,
    ).toBe("Update the selected host to open a terminal without a folder.");
  });

  it("keeps the chooser's Terminal card live with no tooltip once a folder is pinned", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    render(panelUi());
    const router = fakeKeybindingRouter();

    // No auto-spawn: create the first terminal directly (a folder is pinned,
    // so ⇧⌘J creates synchronously, without depending on the chooser).
    act(() => {
      dispatchAction("app.terminal.new", router);
    });
    await waitFor(() => {
      expect(
        landingTerminalTabs(useLandingPanelStore.getState().tabs),
      ).toHaveLength(1);
    });
    // The "+" is never disabled, and the chooser it opens carries no refusal
    // once a folder is pinned.
    const plus = screen.getByTestId("landing-terminal-new-tab");
    expect(plus.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(plus);
    const terminalCard = await screen.findByTestId(
      "landing-new-tab-card-terminal",
    );
    expect(terminalCard.getAttribute("aria-disabled")).toBeNull();
    expect(
      screen.queryByTestId("landing-new-tab-card-terminal-reason"),
    ).toBeNull();
    fireEvent.click(terminalCard);
    await waitFor(() => {
      expect(
        landingTerminalTabs(useLandingPanelStore.getState().tabs),
      ).toHaveLength(2);
    });
  });

  it("holds the tab chords while the system-tab modal occludes the page", () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    useLandingPanelStore.getState().addTab({
      kind: "terminal",
      instanceId: "tab-1",
      sessionId: "session-1",
      hostId: "host-a",
      cwd: "/workspace/project",
      name: "project",
      titleSource: "default",
    });
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());
    const router = fakeKeybindingRouter();

    setSystemTabModalApi(openOverlayApi);
    act(() => {
      dispatchAction("tab.new", router);
      dispatchAction("tab.close", router);
      dispatchAction("tab.close-all", router);
    });
    expect(matchDigitAction(leaderDigitEvent("Digit1"))).toBeNull();
    expect(
      landingTerminalTabs(useLandingPanelStore.getState().tabs),
    ).toHaveLength(1);
    expect(mocks.kill).not.toHaveBeenCalled();
  });

  it("moves focus into the active terminal on expand and back to the composer on collapse", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    useLandingPanelStore.getState().addTab({
      kind: "terminal",
      instanceId: "tab-1",
      sessionId: "session-1",
      hostId: "host-a",
      cwd: "/workspace/project",
      name: "project",
      titleSource: "default",
    });
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());
    const router = fakeKeybindingRouter();

    const tab = landingTerminalTabs(useLandingPanelStore.getState().tabs)[0];
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

  // The three tests below pin one class: `activeInstanceId` is no longer
  // always a terminal. A terminal focus request is fulfilled by a REGISTERED
  // terminal endpoint and otherwise PARKS, so aiming one at a browser row or
  // the chooser leaves an intent nothing can ever claim - it outlives the row
  // and swallows the next terminal's focus. Each asserts on the parked intent,
  // because the harm is the request existing, not a call that never happened.
  // `availability` is the TERMINAL TARGET host's, and the panel's rows name
  // several devices. Replacing the whole body with its status line therefore
  // takes a working page off screen and puts a sentence about an unrelated
  // machine in its place.
  it("keeps a live device's browser row on screen while the target host resolves", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    // No probe answer for the target host: availability is "unknown".
    mocks.probeData = undefined;
    mocks.freshProbeData = undefined;
    mocks.browserSessionsByHost = {
      "host-b": browserSessionsState({ hostId: "host-b" }),
    };
    useLandingPanelStore.getState().addTab({
      kind: "browser",
      instanceId: "browser-instance",
      hostId: "host-b",
      sessionId: "browser-session",
      tabId: "browser-tab",
      name: "example.com",
      titleSource: "default",
    });
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    const tile = await screen.findByTestId(
      "landing-browser-tile-browser-instance",
    );
    // Mounted is not enough - the native view is only on screen when the panel
    // says so.
    expect(tile.getAttribute("data-active")).toBe("true");
    expect(tile.getAttribute("data-panel-open")).toBe("true");
    expect(screen.queryByText("Connecting to the selected host…")).toBeNull();
  });

  // The other half, unchanged: with nothing else to show, the connecting line
  // is still what a resolving target puts in the body.
  it("still shows the connecting status when there is no row to keep", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = undefined;
    mocks.freshProbeData = undefined;
    useLandingPanelStore.getState().addTab({
      kind: "terminal",
      instanceId: "terminal-instance",
      sessionId: "terminal-session",
      hostId: "host-a",
      cwd: "/workspace/project",
      name: "project",
      titleSource: "default",
    });
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    expect(
      await screen.findByText("Connecting to the selected host…"),
    ).toBeTruthy();
  });

  /**
   * The same class as the three above, one level UP. `availability` also gates
   * whether the panel MOUNTS, and an `unsupported` / `no-active-host` verdict
   * about the terminal target unmounted every row - including a browser row on
   * a device that verdict says nothing about. Fixing it only inside the body
   * left the harm reachable through the branch above it.
   *
   * Asserted on the tile's PROPS, as the visibility work established: a native
   * `WebContentsView` is painted over the window, so its presence and its
   * on-screen state are the props the panel decides, not DOM the test can see.
   */
  it("keeps a live device's browser row when the target host is unsupported", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = undefined;
    mocks.freshProbeData = undefined;
    // The terminal target is an old host that cannot serve `terminal.list`.
    mocks.probeError = new HostRpcError({
      code: "DOWNGRADE_UNSUPPORTED",
      message: "terminal.list is not supported by this host",
      requestId: "req-unsupported",
      method: "terminal.list",
      fatalDetails: null,
    });
    mocks.browserSessionsByHost = {
      "host-b": browserSessionsState({ hostId: "host-b" }),
    };
    useLandingPanelStore.getState().addTab({
      kind: "browser",
      instanceId: "browser-instance",
      hostId: "host-b",
      sessionId: "browser-session",
      tabId: "browser-tab",
      name: "example.com",
      titleSource: "default",
    });
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    const tile = await screen.findByTestId(
      "landing-browser-tile-browser-instance",
    );
    expect(tile.getAttribute("data-active")).toBe("true");
    expect(tile.getAttribute("data-panel-open")).toBe("true");
  });

  it("keeps a live device's browser row when no host is selected", async () => {
    // `activeHostId: null` is `no-active-host` - the panel has no terminal
    // target at all. The browser row still names a device that is serving it.
    mocks.activeHostId = null;
    mocks.clientActiveHostId = null;
    mocks.primaryWorkspacePath = null;
    mocks.probeData = undefined;
    mocks.freshProbeData = undefined;
    mocks.browserSessionsByHost = {
      "host-b": browserSessionsState({ hostId: "host-b" }),
    };
    useLandingPanelStore.getState().addTab({
      kind: "browser",
      instanceId: "browser-instance",
      hostId: "host-b",
      sessionId: "browser-session",
      tabId: "browser-tab",
      name: "example.com",
      titleSource: "default",
    });
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    const tile = await screen.findByTestId(
      "landing-browser-tile-browser-instance",
    );
    expect(tile.getAttribute("data-active")).toBe("true");
    expect(tile.getAttribute("data-panel-open")).toBe("true");
  });

  // The other half, unchanged: with only terminal rows, every row IS served by
  // the target host, so the verdict speaks for all of them and the panel still
  // goes away exactly as it does today.
  it("still unmounts a terminal-only panel when no host is selected", async () => {
    mocks.activeHostId = null;
    mocks.clientActiveHostId = null;
    mocks.primaryWorkspacePath = null;
    mocks.probeData = undefined;
    mocks.freshProbeData = undefined;
    useLandingPanelStore.getState().addTab({
      kind: "terminal",
      instanceId: "terminal-instance",
      sessionId: "terminal-session",
      hostId: "host-a",
      cwd: "/workspace/project",
      name: "project",
      titleSource: "default",
    });
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    await waitFor(() => {
      expect(screen.queryByTestId("landing-terminal-panel")).toBeNull();
    });
    expect(screen.queryByTestId("landing-terminal-tile")).toBeNull();
  });

  // CSS cannot hide a `WebContentsView`: it is painted over the window by the
  // desktop, so the picker's `invisible` wrapper leaves it on top of the DOM
  // dialog, taking input. The assertion is on the visibility PROP for exactly
  // that reason - a DOM-only assertion cannot see this class of bug.
  it("takes the native browser view off screen while the directory picker is up", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.workspacePaths = ["/workspace/project", "/workspace/other"];
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    mocks.browserSessionsByHost = {
      "host-a": browserSessionsState({}),
    };
    useLandingPanelStore.getState().addTab({
      kind: "browser",
      instanceId: "browser-instance",
      hostId: "host-a",
      sessionId: "browser-session",
      tabId: "browser-tab",
      name: "example.com",
      titleSource: "default",
    });
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());
    const router = fakeKeybindingRouter();

    const tile = await screen.findByTestId(
      "landing-browser-tile-browser-instance",
    );
    expect(tile.getAttribute("data-active")).toBe("true");

    // ⇧⌘J with two folders raises the picker OVER the body, and cancelling it
    // from an already-open panel leaves the panel open.
    act(() => {
      dispatchAction("app.terminal.new", router);
    });
    expect(
      await screen.findByTestId("landing-terminal-directory-picker"),
    ).toBeTruthy();
    await waitFor(() => {
      expect(
        screen
          .getByTestId("landing-browser-tile-browser-instance")
          .getAttribute("data-active"),
      ).toBe("false");
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Cancel terminal creation" }),
    );

    await waitFor(() => {
      expect(
        screen.queryByTestId("landing-terminal-directory-picker"),
      ).toBeNull();
      expect(
        screen
          .getByTestId("landing-browser-tile-browser-instance")
          .getAttribute("data-active"),
      ).toBe("true");
    });
  });

  // Reveal is not create. `⇧⌘J` still asks for a terminal in as many words;
  // this chord asks for the panel, and a strip holding only browser tabs has
  // nothing to reuse - which used to mean "spawn one".
  it("reveals a browser-only panel without spawning a terminal", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    mocks.browserSessionsByHost = {
      "host-a": browserSessionsState({}),
    };
    useLandingPanelStore.getState().addTab({
      kind: "browser",
      instanceId: "browser-instance",
      hostId: "host-a",
      sessionId: "browser-session",
      tabId: "browser-tab",
      name: "example.com",
      titleSource: "default",
    });
    render(panelUi());
    const router = fakeKeybindingRouter();

    act(() => {
      dispatchAction("app.terminal.toggle", router);
    });

    await waitFor(() => {
      expect(testLayout().panelOpen).toBe(true);
    });
    // Settle every reconciliation generation the reveal armed - the spawn this
    // pins against was never synchronous.
    await act(async () => {
      for (let pass = 0; pass < 5; pass += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
    expect(landingTerminalTabs(useLandingPanelStore.getState().tabs)).toEqual(
      [],
    );
    expect(
      screen.getByTestId("landing-browser-tile-browser-instance"),
    ).toBeTruthy();
  });

  it("does not park a terminal focus request when a browser tab is activated", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    mocks.browserSessionsByHost = {
      "host-a": browserSessionsState({}),
    };
    useLandingPanelStore.getState().addTab({
      kind: "terminal",
      instanceId: "terminal-instance",
      sessionId: "terminal-session",
      hostId: "host-a",
      cwd: "/workspace/project",
      name: "project",
      titleSource: "default",
    });
    useLandingPanelStore.getState().addTab({
      kind: "browser",
      instanceId: "browser-instance",
      hostId: "host-a",
      sessionId: "browser-session",
      tabId: "browser-tab",
      name: "example.com",
      titleSource: "default",
    });
    useLandingPanelStore.getState().activateTab("terminal-instance");
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    fireEvent.click(
      screen.getByTestId("landing-terminal-tab-browser-instance"),
    );

    await waitFor(() => {
      expect(useLandingPanelStore.getState().activeInstanceId).toBe(
        "browser-instance",
      );
    });
    expect(
      hasPrimaryFocusIntent(
        (target) =>
          target.kind === "terminal" &&
          target.instanceId === "browser-instance",
      ),
    ).toBe(false);
  });

  it("leaves the keyboard alone when the panel opens on a browser row", () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    mocks.browserSessionsByHost = {
      "host-a": browserSessionsState({}),
    };
    useLandingPanelStore.getState().addTab({
      kind: "browser",
      instanceId: "browser-instance",
      hostId: "host-a",
      sessionId: "browser-session",
      tabId: "browser-tab",
      name: "example.com",
      titleSource: "default",
    });
    // Reconciliation never settles, so the reveal gesture the open transition
    // captures cannot resolve into a terminal that supersedes what this effect
    // requested. That is also the state an offline host leaves behind, and the
    // one where a misaimed request stays parked for good.
    mocks.queryClient.fetchQuery.mockImplementation(
      () => new Promise(() => undefined),
    );
    render(panelUi());

    // The phone header's route: `setPanelOpen` written on the store directly.
    // `app.terminal.toggle` would not reach this effect - its own capture can
    // raise a directory request the effect defers to.
    act(() => {
      useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    });

    expect(testLayout().panelOpen).toBe(true);
    expect(useLandingPanelStore.getState().activeInstanceId).toBe(
      "browser-instance",
    );
    expect(
      hasPrimaryFocusIntent(
        (target) =>
          target.kind === "terminal" &&
          target.instanceId === "browser-instance",
      ),
    ).toBe(false);
  });

  it("does not aim the reveal gesture's eager focus at a browser row", () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    mocks.browserSessionsByHost = {
      "host-a": browserSessionsState({}),
    };
    // Reconciliation never settles, so the captured reveal gesture cannot
    // create the terminal it will eventually focus - which leaves the toggle's
    // own EAGER hand-off as the only focus request in play. That is exactly
    // the state an offline host leaves behind, and the reason the eager
    // request must not be aimed at a row no terminal will ever back.
    mocks.queryClient.fetchQuery.mockImplementation(
      () => new Promise(() => undefined),
    );
    useLandingPanelStore.getState().addTab({
      kind: "browser",
      instanceId: "browser-instance",
      hostId: "host-a",
      sessionId: "browser-session",
      tabId: "browser-tab",
      name: "example.com",
      titleSource: "default",
    });
    render(panelUi());
    const router = fakeKeybindingRouter();

    act(() => {
      dispatchAction("app.terminal.toggle", router);
    });

    expect(testLayout().panelOpen).toBe(true);
    expect(
      hasPrimaryFocusIntent(
        (target) =>
          target.kind === "terminal" &&
          target.instanceId === "browser-instance",
      ),
    ).toBe(false);
  });

  it("hands focus back to the composer when closing a terminal promotes a browser neighbour", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    mocks.plainAuthorityStatus = "capable";
    mocks.plainCanMutate = true;
    mocks.browserSessionsByHost = {
      "host-a": browserSessionsState({ closeTab: mocks.browserCloseTab }),
    };
    useLandingPanelStore.getState().addTab({
      kind: "terminal",
      instanceId: "terminal-instance",
      sessionId: "terminal-session",
      hostId: "host-a",
      cwd: "/workspace/project",
      name: "project",
      titleSource: "default",
    });
    useLandingPanelStore.getState().addTab({
      kind: "browser",
      instanceId: "browser-instance",
      hostId: "host-a",
      sessionId: "browser-session",
      tabId: "browser-tab",
      name: "example.com",
      titleSource: "default",
    });
    useLandingPanelStore.getState().activateTab("terminal-instance");
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    const composerFocus = vi.fn();
    focusCleanups.push(
      registerComposerFocus(
        "test-composer-promote-browser",
        {
          focus: composerFocus,
          containsActiveElement: () => true,
          isEligible: () => true,
        },
        true,
      ),
    );
    render(panelUi());

    fireEvent.click(screen.getByLabelText("Close project"));

    await waitFor(() => {
      expect(useLandingPanelStore.getState().activeInstanceId).toBe(
        "browser-instance",
      );
    });
    // The panel stayed open, so the open-transition effect never runs - this
    // fallback is the only thing that can hand the keyboard back.
    expect(testLayout().panelOpen).toBe(true);
    await waitFor(() => {
      expect(composerFocus).toHaveBeenCalled();
    });
    expect(
      hasPrimaryFocusIntent(
        (target) =>
          target.kind === "terminal" &&
          target.instanceId === "browser-instance",
      ),
    ).toBe(false);
  });

  it("refits the active terminal after reopening from zero width to the stored panel width", async () => {
    mocks.activeHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = listWith([runningSession("session-1")], "/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    useLandingPanelStore.getState().addTab({
      kind: "terminal",
      instanceId: "tab-1",
      sessionId: "session-1",
      hostId: "host-a",
      cwd: "/workspace/project",
      name: "project",
      titleSource: "default",
    });
    useLandingPanelStore
      .getState()
      .setPanelWidthFraction(TEST_LANDING_PAGE_ID, 0.42);
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
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
    useLandingPanelStore.getState().addTab({
      kind: "terminal",
      instanceId: "tab-1",
      sessionId: "session-1",
      hostId: "host-a",
      cwd: "/workspace/project",
      name: "project",
      titleSource: "default",
    });
    useLandingPanelStore.getState().addTab({
      kind: "terminal",
      instanceId: "tab-2",
      sessionId: "session-2",
      hostId: "host-a",
      cwd: "/workspace/other",
      name: "other",
      titleSource: "default",
    });
    useLandingPanelStore.getState().activateTab("tab-1");
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
      expect(useLandingPanelStore.getState().activeInstanceId).toBe("tab-2");
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
    useLandingPanelStore.getState().addTab({
      kind: "terminal",
      instanceId: "tab-1",
      sessionId: "session-1",
      hostId: "host-a",
      cwd: "/workspace/project",
      name: "project",
      titleSource: "default",
    });
    useLandingPanelStore
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
    useLandingPanelStore.getState().addTab({
      kind: "terminal",
      instanceId: "tab-1",
      sessionId: "session-1",
      hostId: "host-a",
      cwd: "/workspace/project",
      name: "project",
      titleSource: "default",
    });
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
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
    const terminalCard = await screen.findByTestId(
      "landing-new-tab-card-terminal",
    );
    fireEvent.click(terminalCard);
    await waitFor(() => {
      expect(
        landingTerminalTabs(useLandingPanelStore.getState().tabs),
      ).toHaveLength(1);
    });
    const created = landingTerminalTabs(
      useLandingPanelStore.getState().tabs,
    )[0];

    // The spawned tile's engine registers after the create - the parked
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
    render(panelUi());
    const router = fakeKeybindingRouter();

    // No auto-spawn: create the first terminal directly (a folder is pinned,
    // so ⇧⌘J creates synchronously, without depending on the chooser).
    act(() => {
      dispatchAction("app.terminal.new", router);
    });
    await waitFor(() => {
      expect(
        landingTerminalTabs(useLandingPanelStore.getState().tabs),
      ).toHaveLength(1);
    });
    fireEvent.click(screen.getByTestId("landing-terminal-new-tab"));
    fireEvent.click(screen.getByTestId("landing-new-tab-card-terminal"));
    await waitFor(() => {
      expect(
        landingTerminalTabs(useLandingPanelStore.getState().tabs),
      ).toHaveLength(2);
    });
    const [first] = landingTerminalTabs(useLandingPanelStore.getState().tabs);
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
    // An existing tab, so the toggle below is a REOPEN that captures the
    // gesture and defers to reconciliation settlement - an empty panel's
    // plain toggle no longer captures anything (it shows the chooser
    // instead).
    useLandingPanelStore.getState().addTab({
      kind: "terminal",
      instanceId: "seed-tab",
      sessionId: "seed-session",
      hostId: "host-a",
      cwd: "/workspace/seed",
      name: "seed",
      titleSource: "default",
    });
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
      expect(
        landingTerminalTabs(useLandingPanelStore.getState().tabs),
      ).toHaveLength(2);
    });
    const spawned = landingTerminalTabs(
      useLandingPanelStore.getState().tabs,
    ).find((tab) => tab.instanceId !== "seed-tab");
    expect(spawned?.cwd).toBe("/workspace/draft-a");
    expect(useLandingPanelStore.getState().activeInstanceId).toBe(
      spawned?.instanceId,
    );
  });

  it("reconciles an exited terminal against the captured page after focus moves", async () => {
    mocks.activeHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/draft-a";
    mocks.probeData = emptyList(null);
    useLandingPanelStore.getState().addTab({
      kind: "terminal",
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
      useLandingPanelStore.getState().setPanelOpen("draft-b", true);
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
      expect(
        landingTerminalTabs(useLandingPanelStore.getState().tabs),
      ).toHaveLength(0);
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
    // An existing tab, so the toggle below is a REOPEN that captures the
    // gesture and defers to reconciliation settlement - an empty panel's
    // plain toggle no longer captures anything (it shows the chooser
    // instead).
    useLandingPanelStore.getState().addTab({
      kind: "terminal",
      instanceId: "seed-tab",
      sessionId: "seed-session",
      hostId: "host-a",
      cwd: "/workspace/seed",
      name: "seed",
      titleSource: "default",
    });
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
    await waitFor(() => {
      expect(
        landingTerminalTabs(useLandingPanelStore.getState().tabs),
      ).toHaveLength(2);
    });
    const created = landingTerminalTabs(
      useLandingPanelStore.getState().tabs,
    ).find((tab) => tab.instanceId !== "seed-tab");
    expect(created?.cwd).toBe("/Users/dev");
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
    // An existing tab, so the toggle below is a REOPEN: it captures the
    // gesture and defers to reconciliation settlement to spawn-or-reuse at
    // the resolved cwd, same as before - an empty panel no longer captures
    // anything on a plain toggle (it shows the chooser instead).
    useLandingPanelStore.getState().addTab({
      kind: "terminal",
      instanceId: "seed-tab",
      sessionId: "seed-session",
      hostId: "host-a",
      cwd: "/workspace/seed",
      name: "seed",
      titleSource: "default",
    });
    const view = render(panelUiForDraft("draft-a"));
    const router = fakeKeybindingRouter();

    act(() => {
      dispatchAction("app.terminal.toggle", router);
    });
    mocks.activeHostId = "host-b";
    view.rerender(panelUiForDraft("draft-b"));
    await drainDeferredListFetches(resolvers);

    await waitFor(() => {
      expect(
        landingTerminalTabs(useLandingPanelStore.getState().tabs),
      ).toHaveLength(2);
    });
    const created = landingTerminalTabs(
      useLandingPanelStore.getState().tabs,
    ).find((tab) => tab.instanceId !== "seed-tab");
    expect(created).toMatchObject({
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
    mocks.buildDialableHostClient.mockReturnValue(null);
    render(panelUiForDraft("draft-a"));
    const router = fakeKeybindingRouter();

    // The chord captures a gesture whose pinned client is null -> fail-closed.
    // The synchronous create attempt fails, the panel opens empty, and the
    // chooser's Terminal card is what now carries the refusal (the "+" is
    // never disabled).
    act(() => {
      dispatchAction("app.terminal.new", router);
    });

    const terminalCard = await screen.findByTestId(
      "landing-new-tab-card-terminal",
    );
    // Fail-closed: disabled, and NOT silently reconciling on the default client
    // (which would spawn a terminal into the empty panel).
    expect(terminalCard.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(terminalCard);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(
      landingTerminalTabs(useLandingPanelStore.getState().tabs),
    ).toHaveLength(0);
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
    // An existing tab, so the toggle below is a REOPEN: it captures the
    // gesture and defers to reconciliation settlement to spawn-or-reuse at
    // the resolved cwd, same as before - an empty panel no longer captures
    // anything on a plain toggle (it shows the chooser instead).
    useLandingPanelStore.getState().addTab({
      kind: "terminal",
      instanceId: "seed-tab",
      sessionId: "seed-session",
      hostId: "host-a",
      cwd: "/workspace/seed",
      name: "seed",
      titleSource: "default",
    });
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

    await waitFor(() => {
      expect(
        landingTerminalTabs(useLandingPanelStore.getState().tabs),
      ).toHaveLength(2);
    });
    const created = landingTerminalTabs(
      useLandingPanelStore.getState().tabs,
    ).find((tab) => tab.instanceId !== "seed-tab");
    expect(created).toMatchObject({
      hostId: "host-a",
      cwd: "/workspace/draft-a",
    });
  });

  it("clears a settled opening gesture so the chooser follows focus to a folderless draft", async () => {
    mocks.activeHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/draft-a";
    mocks.probeData = emptyList(null);
    mocks.freshProbeData = mocks.probeData;
    // An existing tab, so the toggle below is a REOPEN that captures the
    // gesture and settles through reconciliation, same mechanism as before -
    // an empty panel's plain toggle no longer captures anything.
    useLandingPanelStore.getState().addTab({
      kind: "terminal",
      instanceId: "seed-tab",
      sessionId: "seed-session",
      hostId: "host-a",
      cwd: "/workspace/seed",
      name: "seed",
      titleSource: "default",
    });
    const view = render(panelUiForDraft("draft-a"));
    const router = fakeKeybindingRouter();

    // Reopen on foldered draft A: the gesture settles and spawns A's terminal.
    act(() => {
      dispatchAction("app.terminal.toggle", router);
    });
    await waitFor(() => {
      expect(
        landingTerminalTabs(useLandingPanelStore.getState().tabs),
      ).toHaveLength(2);
    });

    // The "+" is never disabled; the chooser it opens carries the refusal on
    // its Terminal card instead.
    fireEvent.click(screen.getByTestId("landing-terminal-new-tab"));
    const terminalCard = await screen.findByTestId(
      "landing-new-tab-card-terminal",
    );
    expect(terminalCard.getAttribute("aria-disabled")).toBeNull();

    // Focus moves to a folderless draft B AFTER the gesture settled. A stale A
    // snapshot would keep the card enabled from A's pinned folder; the cleared
    // gesture makes it reflect the live folderless B instead.
    mocks.primaryWorkspacePath = null;
    view.rerender(panelUiForDraft("draft-b"));

    await waitFor(() => {
      expect(terminalCard.getAttribute("aria-disabled")).toBe("true");
    });
    // The A terminal survives; focus-following must not have spawned in B.
    expect(
      landingTerminalTabs(useLandingPanelStore.getState().tabs),
    ).toHaveLength(2);
    expect(
      landingTerminalTabs(useLandingPanelStore.getState().tabs).find(
        (tab) => tab.instanceId !== "seed-tab",
      )?.cwd,
    ).toBe("/workspace/draft-a");
  });

  it("creates a terminal on the captured host and folder even after focus moved to a folderless draft", async () => {
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
    // An existing tab, so the toggle below is a REOPEN that captures the
    // gesture without creating yet (single workspace path, so it only
    // focuses the existing active tab) - same capture mechanism as before.
    useLandingPanelStore.getState().addTab({
      kind: "terminal",
      instanceId: "seed-tab",
      sessionId: "seed-session",
      hostId: "host-a",
      cwd: "/workspace/seed",
      name: "seed",
      titleSource: "default",
    });
    const view = render(panelUiForDraft("draft-a"));
    const router = fakeKeybindingRouter();

    // Reopen on draft A (the gesture pins host-a + /workspace/draft-a); the
    // list fetch is deferred, so the gesture is still pending.
    act(() => {
      dispatchAction("app.terminal.toggle", router);
    });
    // Focus moves to a folderless draft B before the list settles.
    mocks.primaryWorkspacePath = null;
    view.rerender(panelUiForDraft("draft-b"));

    // The chooser's Terminal card must create against the pinned A gesture,
    // not the folderless B the panel now happens to be focused on. It must
    // NOT re-capture.
    fireEvent.click(screen.getByTestId("landing-terminal-new-tab"));
    const terminalCard = await screen.findByTestId(
      "landing-new-tab-card-terminal",
    );
    expect(terminalCard.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(terminalCard);

    await waitFor(() => {
      expect(
        landingTerminalTabs(useLandingPanelStore.getState().tabs),
      ).toHaveLength(2);
    });
    const created = landingTerminalTabs(
      useLandingPanelStore.getState().tabs,
    ).find((tab) => tab.instanceId !== "seed-tab");
    expect(created).toMatchObject({
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
    mocks.buildDialableHostClient.mockReturnValue(null);
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

    expect(
      landingTerminalTabs(useLandingPanelStore.getState().tabs),
    ).toHaveLength(0);
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
    // An existing tab, so the toggle below is a REOPEN that captures the
    // gesture without creating yet (single workspace path, so it only
    // focuses the existing active tab) - same capture mechanism as before.
    useLandingPanelStore.getState().addTab({
      kind: "terminal",
      instanceId: "seed-tab",
      sessionId: "seed-session",
      hostId: "host-a",
      cwd: "/workspace/seed",
      name: "seed",
      titleSource: "default",
    });
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

    // The chooser's Terminal card must reflect host-a's LAST observed
    // (downgraded) verdict, not the initial captured "supported": a
    // forgotten downgrade would leave it enabled. The "+" is never disabled
    // itself; the card it opens carries the refusal.
    fireEvent.click(screen.getByTestId("landing-terminal-new-tab"));
    const terminalCard = await screen.findByTestId(
      "landing-new-tab-card-terminal",
    );
    await waitFor(() => {
      expect(terminalCard.getAttribute("aria-disabled")).toBe("true");
    });
  });

  it("cancels the open intent once the user interacts with the panel", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    // Pinned folder has no matching terminal, so an uncancelled intent would
    // spawn there on settle.
    mocks.primaryWorkspacePath = "/workspace/other";
    mocks.probeData = emptyList("/Users/dev");
    useLandingPanelStore.getState().addTab({
      kind: "terminal",
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

    expect(
      landingTerminalTabs(useLandingPanelStore.getState().tabs),
    ).toHaveLength(1);
    expect(useLandingPanelStore.getState().activeInstanceId).toBe("tab-1");
  });

  it("hands focus to the composer when closing the last tab collapses the panel", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    useLandingPanelStore.getState().addTab({
      kind: "terminal",
      instanceId: "tab-1",
      sessionId: "session-1",
      hostId: "host-a",
      cwd: "/workspace/project",
      name: "project",
      titleSource: "default",
    });
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());
    const router = fakeKeybindingRouter();

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
    // An existing tab, so the panel is never empty: reaching the picker on a
    // truly empty panel races the chooser's own placeholder, which also opens
    // there and steals focus from the picker's input onto its (hidden)
    // Terminal card. Seeding a tab keeps this test on the picker mechanics it
    // is actually about.
    useLandingPanelStore.getState().addTab({
      kind: "terminal",
      instanceId: "existing-tab",
      sessionId: "existing-session",
      hostId: "host-a",
      cwd: "/workspace/existing",
      name: "existing",
      titleSource: "default",
    });
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
    expect(
      landingTerminalTabs(useLandingPanelStore.getState().tabs),
    ).toHaveLength(1);

    fireEvent.keyDown(pickerInput, { key: "ArrowDown" });
    fireEvent.keyDown(pickerInput, { key: "Enter" });

    await waitFor(() => {
      expect(
        landingTerminalTabs(useLandingPanelStore.getState().tabs),
      ).toHaveLength(2);
    });
    const created = landingTerminalTabs(
      useLandingPanelStore.getState().tabs,
    ).find((tab) => tab.instanceId !== "existing-tab");
    expect(created?.cwd).toBe("/workspace/other");
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
      dispatchAction("app.terminal.new", fakeKeybindingRouter());
    });
    await screen.findByRole("combobox", {
      name: "Create terminal in workspace",
    });
    setPrimaryFocusInteractionActive(true);
    fireEvent.click(screen.getByText("/workspace/other"));
    setPrimaryFocusInteractionActive(false);
    await drainDeferredListFetches(resolvers);
    await waitFor(() => {
      expect(
        landingTerminalTabs(useLandingPanelStore.getState().tabs),
      ).toHaveLength(1);
    });

    const terminalTarget = document.createElement("textarea");
    document.body.append(terminalTarget);
    const terminalFocus = vi.fn(() => terminalTarget.focus());
    const tab = landingTerminalTabs(useLandingPanelStore.getState().tabs)[0];
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
      dispatchAction("app.terminal.new", fakeKeybindingRouter());
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
      expect(
        landingTerminalTabs(useLandingPanelStore.getState().tabs),
      ).toHaveLength(1);
    });

    const terminalTarget = document.createElement("textarea");
    document.body.append(terminalTarget);
    const terminalFocus = vi.fn(() => terminalTarget.focus());
    const tab = landingTerminalTabs(useLandingPanelStore.getState().tabs)[0];
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
    mocks.buildDialableHostClient.mockImplementation(() => ({
      getActiveHostId: () => pinnedHostId,
      onChange: () => () => undefined,
    }));
    render(panelUi());

    act(() => {
      dispatchAction("app.terminal.toggle", fakeKeybindingRouter());
    });
    await pickTerminalFromChooser();
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
    await pickTerminalFromChooser();
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
    await pickTerminalFromChooser();
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
    await pickTerminalFromChooser();
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
    await pickTerminalFromChooser();
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
      expect(
        landingTerminalTabs(useLandingPanelStore.getState().tabs)[0]?.cwd,
      ).toBe("/workspace/other");
    });
  });

  it("reuses a matching terminal after choosing its directory on reopen", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.workspacePaths = ["/workspace/project", "/workspace/other"];
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    useLandingPanelStore.getState().addTab({
      kind: "terminal",
      instanceId: "project-tab",
      sessionId: "project-session",
      hostId: "host-a",
      cwd: "/workspace/project",
      name: "project · New Terminal",
      titleSource: "default",
    });
    useLandingPanelStore.getState().addTab({
      kind: "terminal",
      instanceId: "other-tab",
      sessionId: "other-session",
      hostId: "host-a",
      cwd: "/workspace/other",
      name: "other · New Terminal",
      titleSource: "default",
    });
    useLandingPanelStore.getState().activateTab("project-tab");
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
      expect(useLandingPanelStore.getState().activeInstanceId).toBe(
        "other-tab",
      );
      expect(document.activeElement).toBe(
        screen.getByTestId("landing-terminal-tab-other-tab"),
      );
    });
    expect(
      landingTerminalTabs(useLandingPanelStore.getState().tabs),
    ).toHaveLength(2);
  });

  it("always creates for explicit new-terminal actions after directory selection", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.workspacePaths = ["/workspace/project", "/workspace/other"];
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    render(panelUi());
    const router = fakeKeybindingRouter();

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

    // No auto-spawn: ⇧⌘J on the collapsed panel creates directly and raises
    // the picker immediately, since several workspace paths are attached.
    act(() => {
      dispatchAction("app.terminal.new", router);
    });
    await createInOther();

    // "+" opens the chooser now (the panel is already open); picking
    // Terminal raises the same picker.
    fireEvent.click(screen.getByTestId("landing-terminal-new-tab"));
    fireEvent.click(screen.getByTestId("landing-new-tab-card-terminal"));
    await createInOther();

    // tab.new (⌘T) opens the chooser too.
    act(() => {
      dispatchAction("tab.new", router);
    });
    fireEvent.click(screen.getByTestId("landing-new-tab-card-terminal"));
    await createInOther();

    // The empty-strip double-click also opens the chooser rather than
    // spawning directly.
    fireEvent.doubleClick(screen.getByTestId("landing-terminal-tab-strip"));
    fireEvent.click(screen.getByTestId("landing-new-tab-card-terminal"));
    await createInOther();

    const otherTabs = landingTerminalTabs(
      useLandingPanelStore.getState().tabs,
    ).filter((tab) => tab.cwd === "/workspace/other");
    expect(otherTabs).toHaveLength(4);
  });

  it("cancels a directory picker opened from a collapsed panel without spawning", async () => {
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

    // app.terminal.toggle on an empty panel only opens the chooser now (no
    // directory request). ⇧⌘J is what still creates directly on a collapsed
    // panel and raises the picker immediately - with `closePanelOnCancel`
    // true, since the gesture is the one that opened the panel.
    act(() => {
      dispatchAction("app.terminal.new", router);
    });
    const pickerInput = await screen.findByRole("combobox", {
      name: "Create terminal in workspace",
    });
    fireEvent.keyDown(pickerInput, { key: "Escape" });

    await waitFor(() => {
      expect(testLayout().panelOpen).toBe(false);
      expect(composerFocus).toHaveBeenCalled();
    });
    expect(
      landingTerminalTabs(useLandingPanelStore.getState().tabs),
    ).toHaveLength(0);
  });

  it("returns from the inline chooser to the active terminal", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.workspacePaths = ["/workspace/project", "/workspace/other"];
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    render(panelUi());
    const router = fakeKeybindingRouter();

    // No auto-spawn: create the first terminal with ⇧⌘J, which bypasses the
    // chooser. Two folders are attached, so it raises the directory picker;
    // Enter takes the primary one.
    act(() => {
      dispatchAction("app.terminal.new", router);
    });
    fireEvent.keyDown(
      await screen.findByRole("combobox", {
        name: "Create terminal in workspace",
      }),
      { key: "Enter" },
    );
    await waitFor(() => {
      expect(
        landingTerminalTabs(useLandingPanelStore.getState().tabs),
      ).toHaveLength(1);
    });
    const newTerminalButton = screen.getByTestId("landing-terminal-new-tab");
    // ⇧⌘J again, on the now-open panel: it raises the picker directly, with no
    // placeholder behind it, which is the arrangement whose cancel hands the
    // keyboard back to the "+". (Through the chooser it goes back to the
    // chooser instead - the case below.)
    act(() => {
      dispatchAction("app.terminal.new", router);
    });
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
    expect(
      landingTerminalTabs(useLandingPanelStore.getState().tabs),
    ).toHaveLength(1);
  });

  it("returns to the chooser when a picker raised from it is cancelled", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.workspacePaths = ["/workspace/project", "/workspace/other"];
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    await pickTerminalFromChooser();
    const pickerInput = await screen.findByRole("combobox", {
      name: "Create terminal in workspace",
    });
    // The chooser is still mounted UNDER the picker, hidden. It must not pull
    // the keyboard back out of the picker while it is up.
    await waitFor(() => {
      expect(document.activeElement).toBe(pickerInput);
    });

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Cancel terminal creation",
      }),
    );

    // Cancelling leaves the placeholder standing, so the chooser is the
    // topmost surface again and takes the keyboard back - not the "+", which
    // is not what the user is looking at.
    await waitFor(() => {
      expect(
        screen.queryByTestId("landing-terminal-directory-picker"),
      ).toBeNull();
      expect(document.activeElement).toBe(
        screen.getByTestId("landing-new-tab-card-terminal"),
      );
    });
    expect(useLandingPanelStore.getState().placeholder).not.toBeNull();
    expect(
      landingTerminalTabs(useLandingPanelStore.getState().tabs),
    ).toHaveLength(0);
  });

  it("clears an open chooser when the panel collapses through the store", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.workspacePaths = ["/workspace/project", "/workspace/other"];
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());

    // "+" opens the placeholder's chooser; picking Terminal raises the picker.
    fireEvent.click(screen.getByTestId("landing-terminal-new-tab"));
    await pickTerminalFromChooser();
    expect(
      await screen.findByTestId("landing-terminal-directory-picker"),
    ).toBeTruthy();

    act(() =>
      useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, false),
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
    await pickTerminalFromChooser();
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
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    const view = render(panelUi());
    const router = fakeKeybindingRouter();

    // No auto-spawn: the open empty panel shows the chooser. One folder is
    // pinned, so picking Terminal creates there without a directory picker.
    await pickTerminalFromChooser();
    await waitFor(() => {
      expect(
        landingTerminalTabs(useLandingPanelStore.getState().tabs),
      ).toHaveLength(1);
    });
    const first = landingTerminalTabs(useLandingPanelStore.getState().tabs)[0];
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
      expect(
        landingTerminalTabs(useLandingPanelStore.getState().tabs),
      ).toHaveLength(2);
    });
    const second = landingTerminalTabs(
      useLandingPanelStore.getState().tabs,
    ).find((tab) => tab.instanceId !== first.instanceId);
    expect(second?.cwd).toBe("/workspace/other");
    expect(useLandingPanelStore.getState().activeInstanceId).toBe(
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
      expect(useLandingPanelStore.getState().activeInstanceId).toBe(
        first.instanceId,
      );
    });
    expect(
      landingTerminalTabs(useLandingPanelStore.getState().tabs),
    ).toHaveLength(2);
  });

  it("leaves the open panel alone when the pinned folder changes without a reopen", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList("/Users/dev");
    mocks.freshProbeData = mocks.probeData;
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    const view = render(panelUi());

    // No auto-spawn: seed the one terminal through the chooser instead.
    await pickTerminalFromChooser();
    await waitFor(() => {
      expect(
        landingTerminalTabs(useLandingPanelStore.getState().tabs),
      ).toHaveLength(1);
    });
    const first = landingTerminalTabs(useLandingPanelStore.getState().tabs)[0];
    const beforeDetach = mocks.queryClient.fetchQuery.mock.calls.length;

    mocks.primaryWorkspacePath = "/workspace/other";
    view.rerender(panelUi());

    // The folder change re-runs reconciliation; it must not spawn or switch
    // while the panel stays open - only a reopen re-targets the pinned folder.
    // What is pinned is that the change runs a further generation, not how
    // many the create left behind: opening onto the chooser and filling it is
    // itself a pass, so an absolute count would measure the seeding.
    await waitFor(() => {
      expect(mocks.queryClient.fetchQuery.mock.calls.length).toBeGreaterThan(
        beforeDetach,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      landingTerminalTabs(useLandingPanelStore.getState().tabs),
    ).toHaveLength(1);
    expect(useLandingPanelStore.getState().activeInstanceId).toBe(
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
    // The expand shows the chooser rather than spawning; picking Terminal is
    // what resolves the folderless launch cwd to the host's home.
    await pickTerminalFromChooser();
    await waitFor(() => {
      expect(
        landingTerminalTabs(useLandingPanelStore.getState().tabs),
      ).toHaveLength(1);
    });
    const created = landingTerminalTabs(
      useLandingPanelStore.getState().tabs,
    )[0];
    expect(created.cwd).toBe("/Users/dev");
    expect(created.hostId).toBe("host-a");
    expect(screen.queryByTestId("landing-terminal-select-folder")).toBeNull();

    // Mirror the folder-backed expand-empty focus test: the parked request
    // fires when the created tile's engine registers.
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
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());
    const router = fakeKeybindingRouter();

    // No auto-spawn: the empty panel opens onto the chooser; pick Terminal
    // once the host's home resolves.
    const terminalCard = await screen.findByTestId(
      "landing-new-tab-card-terminal",
    );
    await waitFor(() => {
      expect(terminalCard.getAttribute("aria-disabled")).toBeNull();
    });
    fireEvent.click(terminalCard);
    await waitFor(() => {
      expect(
        landingTerminalTabs(useLandingPanelStore.getState().tabs),
      ).toHaveLength(1);
    });
    expect(
      landingTerminalTabs(useLandingPanelStore.getState().tabs)[0]?.cwd,
    ).toBe("/Users/dev");

    // "+" opens the chooser; picking Terminal fills it in place.
    fireEvent.click(screen.getByTestId("landing-terminal-new-tab"));
    fireEvent.click(screen.getByTestId("landing-new-tab-card-terminal"));
    await waitFor(() => {
      expect(
        landingTerminalTabs(useLandingPanelStore.getState().tabs),
      ).toHaveLength(2);
    });

    // The empty-strip double-click also opens the chooser rather than
    // spawning directly.
    fireEvent.doubleClick(screen.getByTestId("landing-terminal-tab-strip"));
    fireEvent.click(screen.getByTestId("landing-new-tab-card-terminal"));
    await waitFor(() => {
      expect(
        landingTerminalTabs(useLandingPanelStore.getState().tabs),
      ).toHaveLength(3);
    });

    // tab.new (⌘T) opens the chooser too.
    act(() => {
      dispatchAction("tab.new", router);
    });
    fireEvent.click(screen.getByTestId("landing-new-tab-card-terminal"));
    await waitFor(() => {
      expect(
        landingTerminalTabs(useLandingPanelStore.getState().tabs),
      ).toHaveLength(4);
    });

    // app.terminal.new (⇧⌘J) still creates directly, bypassing the chooser.
    act(() => {
      dispatchAction("app.terminal.new", router);
    });
    await waitFor(() => {
      expect(
        landingTerminalTabs(useLandingPanelStore.getState().tabs),
      ).toHaveLength(5);
    });

    const tabs = landingTerminalTabs(useLandingPanelStore.getState().tabs);
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
    const view = render(panelUi());
    const router = fakeKeybindingRouter();

    // No auto-spawn: create the first terminal directly (a folder is pinned,
    // so ⇧⌘J creates synchronously, without depending on the chooser).
    act(() => {
      dispatchAction("app.terminal.new", router);
    });
    await waitFor(() => {
      expect(
        landingTerminalTabs(useLandingPanelStore.getState().tabs),
      ).toHaveLength(1);
    });
    const folderTab = landingTerminalTabs(
      useLandingPanelStore.getState().tabs,
    )[0];
    expect(folderTab.cwd).toBe("/workspace/project");
    // Relative, not absolute: revealing the panel opens the placeholder before
    // the create fills it, so the create's own generation count is not what
    // this case is about. Detaching the folder must run one MORE.
    const beforeDetach = mocks.queryClient.fetchQuery.mock.calls.length;

    // Detach the last folder: live tabs stay put; no restart, no auto-spawn.
    mocks.primaryWorkspacePath = null;
    view.rerender(panelUi());
    await waitFor(() => {
      expect(mocks.queryClient.fetchQuery.mock.calls.length).toBeGreaterThan(
        beforeDetach,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(landingTerminalTabs(useLandingPanelStore.getState().tabs)).toEqual([
      folderTab,
    ]);
    expect(useLandingPanelStore.getState().activeInstanceId).toBe(
      folderTab.instanceId,
    );
    expect(screen.queryByTestId("landing-terminal-select-folder")).toBeNull();

    fireEvent.click(screen.getByTestId("landing-terminal-new-tab"));
    fireEvent.click(screen.getByTestId("landing-new-tab-card-terminal"));
    await waitFor(() => {
      expect(
        landingTerminalTabs(useLandingPanelStore.getState().tabs),
      ).toHaveLength(2);
    });
    const created = landingTerminalTabs(
      useLandingPanelStore.getState().tabs,
    ).find((tab) => tab.instanceId !== folderTab.instanceId);
    expect(created?.cwd).toBe("/Users/dev");
  });

  it("folder-backed create still works when homeCwd is null", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = emptyList(null);
    mocks.freshProbeData = emptyList(null);
    render(panelUi());
    const router = fakeKeybindingRouter();

    // No auto-spawn: create the first terminal directly (a folder is pinned,
    // so ⇧⌘J creates synchronously, without depending on the chooser).
    act(() => {
      dispatchAction("app.terminal.new", router);
    });
    await waitFor(() => {
      expect(
        landingTerminalTabs(useLandingPanelStore.getState().tabs),
      ).toHaveLength(1);
    });
    expect(
      landingTerminalTabs(useLandingPanelStore.getState().tabs)[0]?.cwd,
    ).toBe("/workspace/project");
    expect(screen.queryByTestId("landing-terminal-host-update")).toBeNull();
    expect(screen.queryByTestId("landing-terminal-select-folder")).toBeNull();

    fireEvent.click(screen.getByTestId("landing-terminal-new-tab"));
    fireEvent.click(screen.getByTestId("landing-new-tab-card-terminal"));
    await waitFor(() => {
      expect(
        landingTerminalTabs(useLandingPanelStore.getState().tabs),
      ).toHaveLength(2);
    });
    expect(
      landingTerminalTabs(useLandingPanelStore.getState().tabs).every(
        (tab) => tab.cwd === "/workspace/project",
      ),
    ).toBe(true);
  });

  it("blocks keyboard and double-click create when folderless and homeCwd is null", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = null;
    mocks.probeData = emptyList(null);
    mocks.freshProbeData = emptyList(null);
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);
    render(panelUi());
    const router = fakeKeybindingRouter();

    // The empty state is displaced by the chooser; the guidance shows on the
    // Terminal card instead.
    const terminalCard = await screen.findByTestId(
      "landing-new-tab-card-terminal",
    );
    await waitFor(() => {
      expect(terminalCard.getAttribute("aria-disabled")).toBe("true");
    });
    expect(
      landingTerminalTabs(useLandingPanelStore.getState().tabs),
    ).toHaveLength(0);
    expect(screen.queryByTestId("landing-terminal-select-folder")).toBeNull();

    fireEvent.doubleClick(screen.getByTestId("landing-terminal-tab-strip"));
    act(() => {
      dispatchAction("tab.new", router);
      dispatchAction("app.terminal.new", router);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      landingTerminalTabs(useLandingPanelStore.getState().tabs),
    ).toHaveLength(0);
    expect(
      screen
        .getByTestId("landing-new-tab-card-terminal")
        .getAttribute("aria-disabled"),
    ).toBe("true");
    expect(screen.queryByTestId("landing-terminal-select-folder")).toBeNull();
  });

  it("rejects stale manual create and late Host A list when client host switches ahead of React", async () => {
    mocks.activeHostId = "host-a";
    mocks.clientActiveHostId = "host-a";
    mocks.primaryWorkspacePath = null;
    mocks.probeData = emptyList("/Users/host-a");
    mocks.freshProbeData = emptyList("/Users/host-a");
    useLandingPanelStore.getState().setPanelOpen(TEST_LANDING_PAGE_ID, true);

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

    // No auto-spawn: the empty panel opens onto the chooser; pick Terminal
    // once host-a's home resolves, which settles reconciledContext + the
    // Host-A create callback the rest of this test exercises.
    const terminalCard = await screen.findByTestId(
      "landing-new-tab-card-terminal",
    );
    await waitFor(() => {
      expect(terminalCard.getAttribute("aria-disabled")).toBeNull();
    });
    fireEvent.click(terminalCard);
    await waitFor(() => {
      expect(
        landingTerminalTabs(useLandingPanelStore.getState().tabs),
      ).toHaveLength(1);
    });
    const hostATab = landingTerminalTabs(
      useLandingPanelStore.getState().tabs,
    )[0];
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

    const tabsBeforeManualCreate = landingTerminalTabs(
      useLandingPanelStore.getState().tabs,
    );
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
    expect(landingTerminalTabs(useLandingPanelStore.getState().tabs)).toEqual(
      tabsBeforeManualCreate,
    );
    expect(
      landingTerminalTabs(useLandingPanelStore.getState().tabs).filter(
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
      landingTerminalTabs(useLandingPanelStore.getState().tabs).filter(
        (tab) => tab.cwd === "/Users/host-a",
      ),
    ).toHaveLength(1);
    expect(
      landingTerminalTabs(useLandingPanelStore.getState().tabs).some(
        (tab) => tab.hostId === "host-b",
      ),
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
    const tabCountBeforeBCreate = landingTerminalTabs(
      useLandingPanelStore.getState().tabs,
    ).length;
    fireEvent.click(screen.getByTestId("landing-terminal-new-tab"));
    fireEvent.click(screen.getByTestId("landing-new-tab-card-terminal"));
    await waitFor(() => {
      expect(
        landingTerminalTabs(useLandingPanelStore.getState().tabs).length,
      ).toBe(tabCountBeforeBCreate + 1);
    });
    const createdOnB = landingTerminalTabs(
      useLandingPanelStore.getState().tabs,
    ).find((tab) => tab.hostId === "host-b");
    expect(createdOnB?.cwd).toBe("/Users/host-b");
    expect(
      landingTerminalTabs(useLandingPanelStore.getState().tabs).some(
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
    render(panelUi());
    const router = fakeKeybindingRouter();

    // No auto-spawn: create the first terminal directly (a folder is pinned,
    // so ⇧⌘J creates synchronously without depending on the chooser).
    act(() => {
      dispatchAction("app.terminal.new", router);
    });
    await waitFor(() => {
      expect(
        landingTerminalTabs(useLandingPanelStore.getState().tabs),
      ).toHaveLength(1);
    });
    expect(
      landingTerminalTabs(useLandingPanelStore.getState().tabs)[0]?.cwd,
    ).toBe("/workspace/host-a-project");

    // Client advances to B; the reactive host and every installed handler
    // still come from Host A's render.
    mocks.clientActiveHostId = "host-b";

    const tabsBeforeManualCreate = landingTerminalTabs(
      useLandingPanelStore.getState().tabs,
    );
    act(() => {
      dispatchAction("app.terminal.new", router);
      dispatchAction("tab.new", router);
    });
    fireEvent.click(screen.getByTestId("landing-terminal-new-tab"));
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(landingTerminalTabs(useLandingPanelStore.getState().tabs)).toEqual(
      tabsBeforeManualCreate,
    );
    expect(
      landingTerminalTabs(useLandingPanelStore.getState().tabs).filter(
        (tab) => tab.cwd === "/workspace/host-a-project",
      ),
    ).toHaveLength(1);
    expect(
      landingTerminalTabs(useLandingPanelStore.getState().tabs).some(
        (tab) => tab.hostId === "host-b",
      ),
    ).toBe(false);
  });
});
