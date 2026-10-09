import { useEffect, useId, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LazyMotion, domAnimation } from "motion/react";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { ChatAccumulatedChangesPanel } from "@/components/chat/chat-accumulated-changes-panel";
import { ActiveAgentsPanel } from "@/components/chat/chat-active-agents-panel";
import { BackgroundItemsPanel } from "@/components/chat/chat-background-items-panel";
import { PinnedTodoPanel } from "@/components/chat/chat-pinned-stack";
import { TabHostContext } from "@/components/epic-canvas/hooks/use-tab-host-id";
import {
  ChatDockCompactStrip,
  ChatDockCompactStripProvider,
} from "@/components/chat/chat-dock-compact-strip";
import { CHAT_DOCK_PANEL_ROW } from "@/components/chat/chat-dock-panel-row";
import type { ChatDockSection } from "@/lib/chat/chat-dock-sections";
import { createHoverChip } from "@/components/layout-editor/canvas/hover-chip";
import { useLayoutRegion } from "@/components/layout-editor/use-layout-region";
import { PresetsBlock } from "@/components/layout-editor/inspector/presets-block";
import {
  depictRegion,
  regionDepiction,
  SPECIMEN_SCROLL_REGION_CLASS,
} from "@/components/layout-editor/region-depiction";
import { HostContextFrame } from "@/components/layout-editor/region-depiction-frame";
import { LAYOUT_REGION_IDS } from "@/components/layout-editor/regions/region-facts";
import { ComposerTileIdProvider } from "@/components/home/composer/composer-tile-context";
import { ComposerToolbar } from "@/components/home/toolbar/composer-toolbar";
import { SampleWorkspaceSidebar } from "@/components/sample-workspace/sample-workspace-sidebar";
import {
  SAMPLE_AGENT_DESCENDANTS,
  SAMPLE_BACKGROUND_ITEMS,
  SAMPLE_CHAT_ID,
  SAMPLE_DOCK,
  SAMPLE_EPIC_ID,
  SAMPLE_HOST_ID,
  SAMPLE_NO_PENDING_STOPS,
  SAMPLE_RESTORE,
  SAMPLE_SELF_AGENT,
  SAMPLE_TILE_ID,
  SAMPLE_TODO,
  SAMPLE_VIEW_TAB_ID,
  sampleNoop,
  sampleNoopAction,
} from "@/components/sample-workspace/sample-workspace-scene";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  HostRuntimeProvider,
  hostRpcRegistry,
  type HostRpcRegistry,
  type MessengerFactory,
} from "@/lib/host";
import { USAGE_PROVIDER_IDS } from "@/lib/layout/layout-arrangement";
import { effectiveLayoutValues } from "@/lib/layout/layout-presets";
import type { RegionId } from "@/lib/layout/region-id";
import { cn } from "@/lib/utils";
import { createComposerToolbarStore } from "@/stores/composer/composer-toolbar-store";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import { useLayoutStore } from "@/stores/layout/layout-store";
import { useSideTabStripStore } from "@/stores/layout/side-tab-strip-store";
import "@/lib/theme-applier";
import "@/index.css";
import "@/components/layout-editor/layout-editor.css";

/**
 * THE PARITY REGRESSION (P2, L-11, L-53, L-85), in real Chrome with the real
 * stylesheet.
 *
 * What a unit test cannot decide is whether a picture of a region LOOKS like
 * the region: that is resolved computed styles and laid-out rects, and jsdom
 * has neither. Four claims live here.
 *
 * 1. **Live versus picture.** Every live surface this fixture can mount
 *    WITHOUT the host runtime is mounted under the same host frame the
 *    picture is drawn in, and the driver compares the two: the icon's painted
 *    box and colour where the region has one, its own type scale and colour
 *    where it does not. A region this fixture cannot mount live is named in
 *    {@link NO_LIVE_LEAF} with the reason, and the driver PRINTS those rather
 *    than counting them as covered - a coverage claim nobody can rely on is
 *    worse than an honest gap (G3-02). The two picture entry points are one
 *    function since L-77, so comparing them with each other proved nothing.
 * 2. **The live surfaces.** Three of them, and each is a mount the app itself
 *    makes. The sample workspace's rail is a real surface built from the app's
 *    own components, so each of the nine rail regions has a live node. The
 *    composer's toolbar in presentation mode carries the toolbar regions. The
 *    dock's compact strip carries every dock member at Chip size (L-98) - the
 *    size at which they mount with no host runtime behind them. Neither count
 *    is written down here: both clusters have gained and lost members (L-136,
 *    L-139, L-142), and a number in a comment is the thing that goes stale.
 * 3. **The preset cards.** One row at the inspector's 380px, each a
 *    miniature above its name and caption.
 * 4. **The hover chip's PAINTED position.** Real Chrome resolves anchor
 *    positioning, so the chip is asserted where the browser put it rather
 *    than where a measurement says it should be.
 *
 * `window.__layoutEditorProbe.ready` gates all of it.
 */

/**
 * Why a region has no live node here, one line each.
 *
 * The driver requires every region it did not find live to be named here, so
 * the gap is stated by a person rather than discovered by a count.
 */
const NO_LIVE_LEAF: Readonly<Partial<Record<RegionId, string>>> = {
  homeTab:
    "the real Home item is drawn by the tab strip, which reads the tabs store and the router",
  usageLimits:
    "the status bar's usage cluster resolves the watched host's rate-limit subscription",
  resourceMonitor:
    "StatusBarResourceSegment resolves its readings through the desktop sampler and the resource registry",
  minimap:
    "ChatTurnMinimapView is driven by the transcript's measured viewport and its scroll position",
  contextUsage:
    "ContextUsageChip draws through `motion/react-m`, which needs the app's LazyMotion feature provider",
  toolActivity:
    "an activity row reads its open state from the transcript's per-chat stores, which this fixture does not mount; the canvas phase drives the sample scene's real rows",
  thinking:
    "a reasoning row reads its open state from the transcript's per-chat stores, which this fixture does not mount; the canvas phase drives the sample scene's real rows",
  timestamps:
    "the stamp lives in a transcript row's sender overline, which only the canvas phase's sample scene mounts",
  railArtifacts:
    "the shipped rail stacks Artifacts under Agents, and a stack draws only its top panel's icon (G3), so Artifacts has no live leaf of its own; the driver's groups phase covers the pair on the real rail",
};

declare global {
  interface Window {
    __layoutEditorProbe?: {
      ready: boolean;
      noLiveLeaf: Readonly<Partial<Record<RegionId, string>>>;
      regionIds: ReadonlyArray<RegionId>;
      /**
       * The shared row recipe's tokens, handed to the driver rather than
       * restated by it: a row is found by the recipe because the six panels
       * agree on neither a tag nor a test id, and the driver cannot import a
       * module the page compiles.
       */
      dockRowRecipe: ReadonlyArray<string>;
      showChip: () => void;
    };
  }
}

/**
 * A local stand-in for the deleted `SpecimenStage` (region-section.tsx's own
 * card): the region forms no longer draw a region on a labelled plinth
 * (`layout-form.tsx`'s rows draw the picture inline, at 1:1), but this
 * fixture still needs one card per region to compare its picture against the
 * live leaf beside it.
 */
function Stage(props: {
  readonly children: ReactNode;
  readonly label: string;
}): ReactNode {
  return (
    <div
      className="relative m-3 flex min-h-22 items-center overflow-hidden rounded-xl border border-border bg-card px-4 py-4.5"
      style={{
        backgroundImage:
          "radial-gradient(120% 90% at 50% 0%, color-mix(in srgb, var(--foreground) 7%, transparent) 0%, transparent 62%)",
      }}
    >
      <span className="absolute top-1.5 right-2.5 left-2.5 truncate text-micro tracking-[0.09em] text-muted-foreground uppercase opacity-80">
        {props.label}
      </span>
      <div inert className={cn("flex w-full min-w-0 justify-center")}>
        {props.children}
      </div>
    </div>
  );
}

export function PictureRow(props: { readonly regionId: RegionId }): ReactNode {
  const { regionId } = props;
  const basePreset = useLayoutStore((state) => state.basePreset);
  const overrides = useLayoutStore((state) => state.overrides);
  const arrangement = useLayoutStore((state) => state.arrangement);
  const values = effectiveLayoutValues(basePreset, overrides);
  return (
    <div data-region-row={regionId} style={{ width: 360 }}>
      <Stage label="Sample">
        {regionDepiction(regionId, values, arrangement)}
      </Stage>
    </div>
  );
}

/**
 * The composer's real toolbar, in presentation mode - the same mount the
 * sample workspace makes, which is the one that draws the five toolbar
 * regions without reaching a host. It is wrapped in the picture's own host
 * frame so the two sides inherit the same type scale, which is the whole
 * point of comparing them.
 */
function LiveToolbar(): ReactNode {
  const [store] = useState(() =>
    createComposerToolbarStore({
      purpose: "run",
      reasoningFallback: "model-default",
      seedKey: "layout-editor-browser-fixture",
      values: {
        permission: "supervised",
        selection: {
          harnessId: "claude",
          modelSlug: "sample-model",
          profileId: null,
        },
        reasoning: "medium",
        serviceTier: "",
      },
      onSettingsChange: null,
      tuiOnly: false,
      chatLineCarriesAutoMode: null,
      hostId: null,
    }),
  );
  return (
    <ComposerTileIdProvider tileId="layout-editor-browser-fixture">
      <HostContextFrame host="toolbar">
        <ComposerToolbar
          presentation
          store={store}
          onAttachImages={() => undefined}
          canSubmit={false}
          attachmentPending={false}
          onSubmit={() => undefined}
          activeTurnStatus={null}
          stopDisabled
          onStopTurn={null}
          composerDisabledHint={null}
          dictation={{
            state: "idle",
            onToggle: () => undefined,
            onStop: () => undefined,
            onCancel: () => undefined,
            getStream: () => null,
          }}
          dictationPreparing={null}
          settingsLocked={false}
          createProfileHostId={null}
          runTargetHostId={null}
          terminalLoginSurface={null}
          chatLineCarriesAutoMode={null}
        />
      </HostContextFrame>
    </ComposerTileIdProvider>
  );
}

/**
 * The dock's members, live, as the pills they are at Chip size.
 *
 * They had no live node here at all while the rows mounted only inside a chat
 * tile's lower surfaces. L-98 moved the sample workspace onto the REAL dock, and
 * its compact strip is the half that needs no host runtime: the chips are
 * `ChatDockCompactChip` fed a model, which is the same leaf the picture draws.
 * The full ROW still has none - `ActiveAgentsPanel` mounts `AgentStopButton`,
 * which resolves a host client and a mutation - so this fixture draws all three
 * at Chip size on both sides (see the store seed below), all four of them
 * since L-139 added Todo.
 *
 * `working: false` on every chip, against the sample scene's own two: a working
 * glyph is `text-primary` under a per-frame opacity sweep, and the driver
 * compares the glyph's resolved colour. The picture is drawn at rest, so the
 * live side is too - the state is not what is being compared here.
 */
function LiveDockChips(): ReactNode {
  const files = useLayoutRegion({
    regionId: "changedFiles",
    instanceId: SAMPLE_TILE_ID,
  });
  const agents = useLayoutRegion({
    regionId: "runningAgents",
    instanceId: SAMPLE_TILE_ID,
  });
  const background = useLayoutRegion({
    regionId: "background",
    instanceId: SAMPLE_TILE_ID,
  });
  // Four since L-139 added Todo, and the count is load-bearing rather than
  // incidental: a `refs` table that misses a `SAMPLE_DOCK` chip hands it an
  // `undefined` hotspot - so it draws a chip that registers no region, and the
  // coverage claim below reports it as a region with no live leaf anywhere.
  const todo = useLayoutRegion({
    regionId: "todo",
    instanceId: SAMPLE_TILE_ID,
  });
  const refs: Readonly<
    Record<ChatDockSection, (node: HTMLElement | null) => void>
  > = {
    filesChanged: files.ref,
    activeAgents: agents.ref,
    background: background.ref,
    todo: todo.ref,
  };
  const chips = SAMPLE_DOCK.map((chip) => ({
    ...chip,
    working: false,
    hotspotRef: refs[chip.section],
  }));
  return (
    <ChatDockCompactStripProvider
      value={{
        chips,
        // Every pill at rest, for the same reason `working` is false above:
        // the open pill is drawn selected, and what is compared here is the
        // resting chip the picture draws.
        openSection: null,
        panelId: "layout-editor-browser-dock-panel",
        onToggle: () => undefined,
      }}
    >
      <HostContextFrame host="chip-strip">
        <ChatDockCompactStrip
          actionsRef={() => undefined}
          snapshotLoaded
          onSettled={() => undefined}
        />
      </HostContextFrame>
    </ChatDockCompactStripProvider>
  );
}

/**
 * The clip fade, on the one picture that can outgrow the inspector (LV2-14).
 *
 * The Usage limits picture draws EVERY shown windowed provider since R3-03:
 * six segments, calm ones a bare bar and the running-low specimen expanded in
 * place, which together do not fit the 292px a docked stage gives them. With
 * every specimen calm they would fit exactly, so the case depends on the one
 * running-low reading `sample-workspace-scene.ts` keeps. That is what
 * `HostContextFrame`'s measured `data-clipped` and its `CLIP_FADE` mask are
 * for, and jsdom can decide neither: `scrollWidth`, `clientWidth` and a
 * resolved `mask-image` are all real layout. The driver asserts on this node -
 * `data-clipped="true"` and a computed `mask-image` other than `none` on the
 * `[data-layout-depiction]` frame inside it.
 *
 * Its own arrangement rather than the store's, so the case is every provider
 * whatever this build ships as a default and whatever the preset rows above
 * leave hidden.
 */
function ClipFadeCase(): ReactNode {
  const basePreset = useLayoutStore((state) => state.basePreset);
  const overrides = useLayoutStore((state) => state.overrides);
  const arrangement = useLayoutStore((state) => state.arrangement);
  const values = effectiveLayoutValues(basePreset, overrides);
  return (
    <div data-clip-case="usage-limits" style={{ width: 292 }}>
      <Stage label="Sample">
        {depictRegion("usageLimits", values.usageLimits, {
          ...arrangement,
          usageProviders: USAGE_PROVIDER_IDS,
          hiddenProviders: [],
        })}
      </Stage>
    </div>
  );
}

/**
 * THE ONE ROW METRIC, in real Chrome (L-171).
 *
 * The compact pills are a switcher: clicking another one replaces the panel
 * attached above the composer. So a panel showing ONE one-line row has to
 * measure the same whichever of the four members it belongs to, or every
 * switch between two one-line panels moves the composer's whole upper edge -
 * which is what the owner saw going from one changed file to one background
 * shell. `chat-dock-panel-row.ts` states that height instead of letting the
 * tallest thing inside a row decide it.
 *
 * jsdom can check that the four rows carry the same class recipe and nothing
 * more; only a browser resolves `min-h-8`, `py-0.5`, a `size-6` control and a
 * floated toolbar into a number. So the four panels are mounted here for
 * REAL, each fed exactly one one-line row of the sample scene's own data, and
 * the driver compares their four `getBoundingClientRect().height` values to
 * the pixel.
 *
 * Their own runtime island rather than the fixture's root: two of the four
 * (Active agents, Background) resolve a host client and a mutation, so they
 * need the app-wide runtime the parity sections above deliberately do without
 * - the whole fixture inside a `LazyMotion` would also hand `contextUsage` a
 * live leaf it is excused from having.
 */
const dockMetricQueryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});

const dockMetricRunnerHost = new MockRunnerHost({
  signInUrl: "http://127.0.0.1:9/sign-in",
  authnBaseUrl: "http://127.0.0.1:9",
  localHost: null,
  hosts: [],
  workspaceFolderPickerPaths: undefined,
  hasLocalHost: undefined,
  traycerCli: undefined,
});

let dockMetricRequestCounter = 0;

/**
 * The startup calls the runtime makes, and nothing else - the same three the
 * canvas fixture answers. The sample ids address a host that is in no
 * directory, so every panel below resolves a null client and asks nothing.
 */
const dockMetricMessengerFactory: MessengerFactory<HostRpcRegistry> = ({
  registry,
}) =>
  new MockHostMessenger<HostRpcRegistry>({
    registry,
    requestId: () => `layout-dock-metric-${String(++dockMetricRequestCounter)}`,
    handlers: {
      "host.status": () => ({
        ready: true,
        hostVersion: "1.2.3",
        protocolVersion: { major: 1, minor: 2 },
        busy: false,
        busySessionCount: 0,
        updateProgress: null,
        busyBreakdown: null,
        updateOperation: null,
        updateTransaction: null,
        storeFormats: null,
        install: null,
      }),
      "host.notifications.indicatorState": () => ({ epics: {}, chats: {} }),
      "epic.getTaskContexts": () => ({ tasks: {} }),
    },
  });

/** One one-line row each, taken from the sample scene rather than invented. */
const ONE_CHANGED_FILE = SAMPLE_RESTORE.accumulatedFileChanges.slice(0, 1);
const ONE_BACKGROUND_ITEM = SAMPLE_BACKGROUND_ITEMS.slice(0, 1);
const ONE_TODO = { ...SAMPLE_TODO, items: SAMPLE_TODO.items.slice(0, 1) };
/** The Active agents panel's one row is the chat itself, with no children. */
const NO_AGENT_DESCENDANTS = SAMPLE_AGENT_DESCENDANTS.slice(0, 0);

/**
 * A panel drawn as the attached one, which is what `openSection` decides: the
 * members read it themselves, so this is the only thing that has to be said to
 * get the header-less compact body rather than the collapsible full row.
 */
function OneRowPanel(props: {
  readonly section: ChatDockSection;
  /** What the driver prints for this case; defaults to the section's name. */
  readonly name: string | null;
  readonly children: ReactNode;
}): ReactNode {
  const panelId = useId();
  return (
    <div
      data-dock-row-metric={props.name ?? props.section}
      style={{ width: 420 }}
    >
      <ChatDockCompactStripProvider
        value={{
          chips: [],
          openSection: props.section,
          panelId,
          onToggle: () => undefined,
        }}
      >
        {props.children}
      </ChatDockCompactStripProvider>
    </div>
  );
}

function DockRowMetrics(): ReactNode {
  return (
    <QueryClientProvider client={dockMetricQueryClient}>
      <RunnerHostProvider runnerHost={dockMetricRunnerHost}>
        <HostRuntimeProvider
          registry={hostRpcRegistry}
          messengerFactory={dockMetricMessengerFactory}
          invalidator={null}
          requestId={null}
          remoteFetcher={() => Promise.resolve({ kind: "hosts", entries: [] })}
          fallback={<div data-dock-row-metric-fallback />}
        >
          <LazyMotion features={domAnimation}>
            <TabHostContext.Provider value={SAMPLE_HOST_ID}>
              <OneRowPanel section="filesChanged" name={null}>
                <ChatAccumulatedChangesPanel
                  restore={{
                    ...SAMPLE_RESTORE,
                    accumulatedFileChanges: ONE_CHANGED_FILE,
                  }}
                  separated={false}
                  scrollRegionMaxHeightClass={SPECIMEN_SCROLL_REGION_CLASS}
                />
              </OneRowPanel>
              <OneRowPanel section="activeAgents" name={null}>
                <ActiveAgentsPanel
                  epicId={SAMPLE_EPIC_ID}
                  viewTabId={SAMPLE_VIEW_TAB_ID}
                  self={SAMPLE_SELF_AGENT}
                  descendants={NO_AGENT_DESCENDANTS}
                  scrollRegionMaxHeightClass={SPECIMEN_SCROLL_REGION_CLASS}
                  separated={false}
                />
              </OneRowPanel>
              <OneRowPanel section="background" name={null}>
                <BackgroundItemsPanel
                  items={ONE_BACKGROUND_ITEM}
                  epicId={SAMPLE_EPIC_ID}
                  chatId={SAMPLE_CHAT_ID}
                  viewTabId={SAMPLE_VIEW_TAB_ID}
                  canAct
                  readOnly={false}
                  pendingStopTaskIds={SAMPLE_NO_PENDING_STOPS}
                  stopAllPending={false}
                  sessionStopPending={false}
                  turnActive={false}
                  scrollRegionMaxHeightClass={SPECIMEN_SCROLL_REGION_CLASS}
                  separated={false}
                  onItemClick={sampleNoop}
                  onStopItem={sampleNoopAction}
                  onStopAll={sampleNoopAction}
                  onStopSession={sampleNoopAction}
                />
              </OneRowPanel>
              <OneRowPanel section="todo" name={null}>
                <PinnedTodoPanel
                  todo={ONE_TODO}
                  scrollRegionMaxHeightClass={SPECIMEN_SCROLL_REGION_CLASS}
                  separated={false}
                />
              </OneRowPanel>
            </TabHostContext.Provider>
          </LazyMotion>
        </HostRuntimeProvider>
      </RunnerHostProvider>
    </QueryClientProvider>
  );
}

export function Fixture(): ReactNode {
  useEffect(() => {
    const chip = createHoverChip();
    window.__layoutEditorProbe = {
      ready: true,
      noLiveLeaf: NO_LIVE_LEAF,
      regionIds: LAYOUT_REGION_IDS,
      dockRowRecipe: CHAT_DOCK_PANEL_ROW.split(" "),
      showChip: () => {
        const node = document.querySelector("[data-chip-anchor]");
        if (!(node instanceof HTMLElement)) return;
        chip.show({ label: "Minimap - Right", node, placement: "above" });
      },
    };
    return () => {
      chip.destroy();
      window.__layoutEditorProbe = undefined;
    };
  }, []);

  return (
    <TooltipProvider>
      <div data-layout-editing="1" style={{ width: 1400 }}>
        <section data-live-surface id="live-rail" style={{ display: "flex" }}>
          <SampleWorkspaceSidebar />
        </section>

        <section data-live-surface id="live-toolbar" style={{ width: 720 }}>
          <LiveToolbar />
        </section>

        <section data-live-surface id="live-dock" style={{ width: 720 }}>
          <LiveDockChips />
        </section>

        <section id="pictures">
          {LAYOUT_REGION_IDS.map((regionId) => (
            <PictureRow key={regionId} regionId={regionId} />
          ))}
        </section>

        <section id="dock-row-metrics">
          <DockRowMetrics />
        </section>

        <section id="clip-fade">
          <ClipFadeCase />
        </section>

        <section id="presets" style={{ width: 380 }}>
          <PresetsBlock reveal={() => {}} />
        </section>

        {/* The two states the canvas decoration is read off: a dimmed leaf and
            a region the chip anchors to. Both carry the attributes
            `use-layout-region.ts` writes onto the app's own elements, so the
            driver measures the shipped rules rather than fixture styling. */}
        <section id="decoration" style={{ paddingTop: 80 }}>
          <span data-layout-passive style={{ display: "inline-block" }}>
            Passive leaf
          </span>
          <span
            data-chip-anchor
            data-layout-region="minimap"
            data-layout-anchor="hover"
            style={{
              display: "inline-block",
              width: 120,
              height: 24,
              marginLeft: 200,
            }}
          />
        </section>
      </div>
    </TooltipProvider>
  );
}

// `useLayoutRegion` only marks a node while a session is live, and the live
// surfaces' `data-layout-region` attributes are what the driver compares
// against.
useLayoutEditorStore.getState().beginSession({
  entry: "pointer",
  source: "direct_ui",
  startedAt: 0,
  origin: { kind: "tab" },
});

// Every dock member at Chip size, so the picture and the live leaf are
// pictures of the same thing (see `LiveDockChips`). Every other region is drawn
// at whatever this build ships as its default.
//
// Read off the arrangement rather than listed here: the dock's membership and
// its order are model facts that have already changed twice (L-139, L-142),
// and a list written down in a fixture is the thing that goes stale while the
// coverage claim above still reports green.
for (const regionId of useLayoutStore.getState().arrangement.dock)
  useLayoutStore.getState().setRegionValues(regionId, { size: "chip" });

// The stored tab strip placement, sidebar side and strip view the preset
// miniature is drawn from, and the strip's collapsed flag, from
// `?tabs=top|left|right&sidebar=left|right&view=layered|activity&collapsed=0|1`
// (default: the shipped `top`, `left`, `layered`, expanded). The driver
// reopens the page once per variant and compares the miniature's structure
// with the live canvas's.
function applyPlacementQuery(): void {
  const params = new URLSearchParams(window.location.search);
  const tabs = params.get("tabs");
  const sidebar = params.get("sidebar");
  const { arrangement } = useLayoutStore.getState();
  useLayoutStore.getState().setArrangement({
    ...arrangement,
    tabStripPlacement: tabs === "left" || tabs === "right" ? tabs : "top",
    sidebarSide: sidebar === "right" ? "right" : "left",
    sideStripView: params.get("view") === "activity" ? "activity" : "layered",
  });
  useSideTabStripStore.getState().setCollapsed(params.get("collapsed") === "1");
}

applyPlacementQuery();

const container = document.getElementById("root");
if (container !== null) createRoot(container).render(<Fixture />);
