import { createRoot } from "react-dom/client";
import { LazyMotion, domMax } from "motion/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DndContext } from "@dnd-kit/core";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  hostRpcRegistry,
  HostRuntimeProvider,
  type HostRpcRegistry,
  type MessengerFactory,
} from "@/lib/host";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type { LocalHostSnapshot } from "@traycer-clients/shared/platform/runner-host";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import { openStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import type { EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import { NotificationConsumptionContext } from "@/components/notifications/notification-consumption-context";
import { TabStrip } from "@/components/epic-canvas/canvas/tab-strip";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { makeBlankTileRef } from "@/stores/epics/canvas/tile-schema/blank-tile";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";
import { useEpicDndStore } from "@/components/epic-canvas/dnd/dnd-store";
import type { EpicCanvasDropPreview } from "@/components/epic-canvas/dnd/dnd";
import "@/index.css";

/**
 * Real-layout fixture for the epic canvas tile's VS Code-style tab strip
 * (`TabStrip`, `src/components/epic-canvas/canvas/tab-strip.tsx`): does a
 * SINGLE tab (no horizontal overflow) leave the scroller with NO vertical
 * scroll range at all, so a real vertical mouse wheel over the strip cannot
 * wobble it by a pixel - and does an OVERFLOWING strip still turn that same
 * wheel into horizontal scroll, exactly as before the fix?
 *
 * jsdom cannot answer either half. It lays nothing out, so `scrollHeight` and
 * `clientHeight` are always 0 and "does the scroller have 1px of vertical
 * overflow" has no answer there; and a wheel dispatched through jsdom's
 * `fireEvent.wheel` never reaches the browser's NATIVE scroll-on-wheel
 * behaviour (there is none to reach), which is exactly the mechanism the bug
 * lived in - `useHorizontalWheelScroll` returns early without
 * `preventDefault()` when there is no horizontal overflow, and it is the
 * BROWSER's default action that then scrolls whatever axis the container
 * computes as scrollable. Only a real layout engine plus a real dispatched
 * wheel event can tell a 35px row with no vertical slack apart from one with
 * 1px of it.
 *
 * This renders the PRODUCTION `TabStrip` against the real stylesheet, with a
 * single blank tab that is both active and globally active (so the top
 * accent bar renders) or with enough blank tabs to overflow the strip
 * horizontally, chosen by `?tabs=N` (default 1). `?dropIndex=N` additionally
 * seeds the dnd store with an `artifact-tab-strip` drop preview at index N
 * before the first render, so `TabStripDropIndicator` mounts inside tab N
 * without a real drag gesture; omitted, no preview is seeded and behaviour is
 * unchanged. Structure follows
 * `status-bar-usage-scroll.tsx` (vite + headless Chrome over CDP via
 * `scripts/chrome-launcher.mjs`); wired into `scripts/run-tests.ts` behind
 * `RUN_DIFF_EDIT_BROWSER_REGRESSION`, next to that fixture's entry.
 *
 * What it mounts around `TabStrip`, and why each layer is real rather than
 * mocked (there is no `vi.mock` outside vitest):
 *
 *  - `QueryClientProvider` - every host RPC in this app goes through Query.
 *  - `RunnerHostProvider` + `HostRuntimeProvider` - `TabItem` resolves a
 *    per-tab host client unconditionally (`useHostClientForHostId`, called
 *    with `null` for every non-terminal tab, which still calls the strict
 *    `useHostClient()` and THROWS with no `<HostRuntimeProvider>` above it -
 *    the jsdom test sidesteps this entirely with
 *    `vi.mock("@/hooks/host/use-host-client-for-host-id", ...)`). The
 *    provider is REAL production code
 *    (`src/providers/host-runtime-provider.tsx`); what is fake is the
 *    transport underneath it, through its own documented test seam
 *    (`messengerFactory`) - the same pattern `epics-list.test.tsx` uses to
 *    mount this exact provider. No real host ever needs to exist: the
 *    fixture's blank tab reads `UNKNOWN_HOST_PLACEHOLDER` reachability, which
 *    resolves to "reachable" before any RPC is even issued.
 *  - `EpicSessionContext.Provider` - `TabItemBody` also unconditionally reads
 *    `useEpicTabDisplayTitle` / `useEpicLiveArtifactTitleGenerating`, both of
 *    which go through the STRICT `useEpicStore()` and throw without an open
 *    epic session (jsdom sidesteps this with
 *    `vi.mock("@/lib/epic-selectors", ...)`). `openStoreForTest`
 *    (`src/stores/epics/open-epic/test-support/open-store-for-test.ts`) is
 *    the same real (non-mock) in-process runtime harness dozens of existing
 *    suites use to hand a component a genuine, empty `OpenEpicStoreHandle`.
 *  - `TooltipProvider`, `NotificationConsumptionContext.Provider` - mirror
 *    the jsdom test's wrapper (`tab-strip.test.tsx`).
 *  - `LazyMotion features={domMax}` - `motion/react-m` (`import * as m from
 *    "motion/react-m"`, used throughout `tab-strip.tsx` for the drop
 *    indicator, tab motion frame, and the strip-end indicator) is the "mini"
 *    bundle: its `m.*` components render but never animate without a
 *    `LazyMotion` ancestor supplying the feature bundle - they stay frozen at
 *    their `initial` prop forever, not merely unanimated at their `animate`
 *    target. `traycer-app.tsx` wraps the whole app in exactly this provider;
 *    without it here, `TabStripDropIndicator`'s mount transition
 *    (`opacity`/`scaleY`) would never run and its measured rect would be the
 *    unscaled `initial` box, not the settled one production shows.
 *
 * `BrowserSessionsContext` is deliberately NOT provided: its strict reader is
 * only reached by a `browser-session` tab, and this fixture never mounts one
 * - its default `null` context value is exactly what a blank tab reads. The
 * leader-badge keybinding context needs no provider either - it ships a real,
 * inert default (`DEFAULT_LEADER_STATE`, confirmed by reading
 * `keybinding-context.ts`). `<DndContext>` IS mounted below, matching the
 * sibling `tab-recovery.tsx` browser fixture's convention, even though
 * `useDraggable`/`useDroppable` do not throw without one (their own
 * `InternalContext` also ships a real default, `defaultInternalContext` in
 * `@dnd-kit/core`'s source) - it costs nothing and keeps drag/drop plumbing
 * inert rather than absent.
 */

const EPIC_ID = "fixture-epic";
const VIEW_TAB_ID = "fixture-view-tab";
const GROUP_ID = "fixture-group";
const FIXTURE_HOST_ID = "fixture-host";

const FIXTURE_LOCAL_HOST: LocalHostSnapshot = {
  hostId: FIXTURE_HOST_ID,
  websocketUrl: "ws://127.0.0.1:1/rpc",
  version: "0.0.0-fixture",
  pid: 1,
  systemHostName: "fixture",
  displayName: "fixture",
  availability: "available",
};

const fixtureStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

const fixtureMessengerFactory: MessengerFactory<HostRpcRegistry> = (args) =>
  new MockHostMessenger<HostRpcRegistry>({
    registry: args.registry,
    requestId: () => `fixture-req-${Math.random().toString(36).slice(2, 8)}`,
    // No handlers registered: this fixture's blank tab never issues an RPC
    // (reachability short-circuits on the unknown-host placeholder before
    // reaching the directory, and nothing else in the strip queries a host
    // for a blank tile). An unhandled call would reject with a
    // `HostRpcError`, not throw synchronously, so leaving this empty is safe
    // even if some future tab kind starts one.
    handlers: {},
  });

/** Seeds the canvas store with one pane holding every tile, the FIRST tile
 * active + preview + globally active so the top accent bar renders. Mirrors
 * `seedActivePreviewTab` in `tab-strip.test.tsx` - the only difference is N
 * tiles instead of one. */
function seedCanvas(tiles: readonly EpicCanvasTileRef[]): void {
  const firstTile = tiles.at(0);
  if (firstTile === undefined) {
    throw new Error(
      "canvas-tab-strip-overflow fixture requires at least one tile",
    );
  }
  useEpicCanvasStore.setState({
    tabsById: {
      [VIEW_TAB_ID]: {
        tabId: VIEW_TAB_ID,
        epicId: EPIC_ID,
        name: "Fixture epic",
      },
    },
    canvasByTabId: {
      [VIEW_TAB_ID]: {
        activePaneId: GROUP_ID,
        root: {
          kind: "pane",
          id: GROUP_ID,
          tabInstanceIds: tiles.map((tile) => tile.instanceId),
          activeTabId: firstTile.instanceId,
          previewTabId: firstTile.instanceId,
          activationHistory: tiles.map((tile) => tile.instanceId),
        },
        tilesByInstanceId: Object.fromEntries(
          tiles.map((tile) => [tile.instanceId, tile] as const),
        ),
        sizesByGroupId: {},
      },
    },
  });
}

export function CanvasTabStripOverflowFixture(props: {
  readonly tiles: readonly EpicCanvasTileRef[];
}): React.ReactElement {
  const firstTile = props.tiles.at(0);
  if (firstTile === undefined) {
    throw new Error(
      "canvas-tab-strip-overflow fixture requires at least one tile",
    );
  }
  return (
    <TabStrip
      epicId={EPIC_ID}
      tabId={VIEW_TAB_ID}
      groupId={GROUP_ID}
      tabs={props.tiles}
      activeTabId={firstTile.instanceId}
      onSelectTab={() => undefined}
      onCloseTab={() => undefined}
      onPromotePreview={() => undefined}
      onSplit={() => undefined}
      onCloseGroup={() => undefined}
      onOpenBlankTab={() => undefined}
      canRenameTabs
      menuHandlers={{
        onClose: () => undefined,
        onCloseOthers: () => undefined,
        onCloseRight: () => undefined,
        onCloseAll: () => undefined,
        onSplit: () => undefined,
        onRevealInSidebar: () => undefined,
        onRename: () => undefined,
      }}
    />
  );
}

const tabCountParam = Number(
  new URLSearchParams(window.location.search).get("tabs") ?? "1",
);
const tabCount =
  Number.isFinite(tabCountParam) && tabCountParam > 0
    ? Math.floor(tabCountParam)
    : 1;
const tiles: EpicCanvasTileRef[] = Array.from({ length: tabCount }, () =>
  makeBlankTileRef(),
);
seedCanvas(tiles);

// `?dropIndex=N` seeds an `artifact-tab-strip` drop preview at index N before
// the first render, so `TabStripDropIndicator` mounts inside tab N with no
// real drag gesture involved. Absent (the default), no preview is seeded and
// the strip renders exactly as before this param existed.
const dropIndexParam = new URLSearchParams(window.location.search).get(
  "dropIndex",
);
if (dropIndexParam !== null) {
  const dropIndex = Number(dropIndexParam);
  if (!Number.isFinite(dropIndex)) {
    throw new Error(
      `canvas-tab-strip-overflow fixture: invalid dropIndex ` +
        `"${dropIndexParam}"`,
    );
  }
  const dropPreview: EpicCanvasDropPreview = {
    kind: "artifact-tab-strip",
    groupId: GROUP_ID,
    index: dropIndex,
  };
  useEpicDndStore.getState().dropPreviewChanged(dropPreview);
}

const runnerHost = new MockRunnerHost({
  signInUrl: "https://auth.traycer.invalid/sign-in",
  authnBaseUrl: "http://127.0.0.1:1",
  localHost: FIXTURE_LOCAL_HOST,
  hosts: [],
  workspaceFolderPickerPaths: undefined,
  hasLocalHost: undefined,
  traycerCli: undefined,
});

const epicHandle = openStoreForTest({
  epicId: EPIC_ID,
  userId: null,
  factories: {
    streamClientFactory: fixtureStreamClientFactory,
    laneSelection: null,
  },
  writeCommand: null,
});

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});

const container = document.querySelector("#root");
if (container === null) throw new Error("probe root missing");
createRoot(container).render(
  <LazyMotion features={domMax}>
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <HostRuntimeProvider
          registry={hostRpcRegistry}
          messengerFactory={fixtureMessengerFactory}
          invalidator={null}
          requestId={null}
          remoteFetcher={() => Promise.resolve({ kind: "hosts", entries: [] })}
          fallback={
            <div data-testid="fixture-runtime-fallback">
              Booting host runtime…
            </div>
          }
        >
          <TooltipProvider>
            <NotificationConsumptionContext.Provider value={() => undefined}>
              <EpicSessionContext.Provider value={epicHandle}>
                <DndContext>
                  <CanvasTabStripOverflowFixture tiles={tiles} />
                </DndContext>
              </EpicSessionContext.Provider>
            </NotificationConsumptionContext.Provider>
          </TooltipProvider>
        </HostRuntimeProvider>
      </RunnerHostProvider>
    </QueryClientProvider>
  </LazyMotion>,
);
