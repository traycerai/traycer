import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { LAYOUT_REGIONS } from "@/components/layout-editor/regions/layout-regions";
import { createRoot } from "react-dom/client";
import { Info } from "lucide-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { LazyMotion, domAnimation } from "motion/react";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { LocalHostSnapshot } from "@traycer-clients/shared/platform/runner-host";
import { createRendererContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { HostListResponse } from "@traycer/protocol/host/host-status";
import { providersListResponseSchema } from "@traycer/protocol/host/provider-schemas";
import { rateLimitUsageResponseSchemaV40 } from "@traycer/protocol/host/rate-limit/schemas";
import { RateLimitPollProvider } from "@/providers/rate-limit-poll-provider";
import { createResourcesStore } from "@/stores/resources/resources-store";
import { resourcesRegistry } from "@/stores/resources/resources-registry";
import { RootDndProvider } from "@/components/epic-canvas/dnd/root-dnd-provider";
import {
  PanelTaskHeader,
  SidebarWidthResizeHandle,
} from "@/components/epic-canvas/sidebar/epic-sidebar-column";
import { EpicLeftPanelRail } from "@/components/epic-canvas/sidebar/epic-sidebar-rail";
import { StripLiveAgentsPortal } from "@/components/epic-canvas/sidebar/strip-live-agents";
import { StableTileSurfaceHost } from "@/components/epic-canvas/surface-host/stable-tile-surface-host";
import { TileSurfaceSlot } from "@/components/epic-canvas/surface-host/tile-surface-slot";
import { EpicSurfaceSheets } from "@/components/epic-tabs/epic-surface";
import { LayoutEditor } from "@/components/layout-editor/layout-editor";
import {
  LAYOUT_REGION_IDS,
  regionFacts,
} from "@/components/layout-editor/regions/region-facts";
import { AppColumnFrame } from "@/components/layout/app-column-frame";
import { AppHeader } from "@/components/layout/header/app-header";
import {
  appColumnChrome,
  sideStripOwnsTitleBar,
} from "@/components/layout/header/app-title-band-kind";
import { useAppColumnChromeInput } from "@/components/layout/use-app-column-chrome-input";
import { TabChrome } from "@/components/layout/tabs/header-tab-visual";
import { SideTabStrip } from "@/components/layout/tabs/side-strip/side-tab-strip";
import {
  SIDE_STRIP_DEFAULT_WIDTH_PX,
  SIDE_STRIP_MIN_WIDTH_PX,
  SIDE_STRIP_RAIL_WIDTH_PX,
  SIDE_STRIP_SNAP_TO_RAIL_BELOW_PX,
} from "@/components/layout/tabs/side-strip/side-strip-tokens";
import { SampleSceneProvider } from "@/components/sample-workspace/sample-scene-provider";
import { SampleWorkspaceBody } from "@/components/sample-workspace/sample-workspace-body";
import { SampleStripLiveAgents } from "@/components/sample-workspace/sample-strip-live-agents";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { HostNotificationsIndicatorStateResponse } from "@traycer/protocol/host/notifications/contracts";
import type { AgentActivityByEpic } from "@traycer/protocol/host/agent/activity";
import {
  HostRuntimeProvider,
  hostRpcRegistry,
  useHostBinding,
  type HostRpcRegistry,
  type MessengerFactory,
} from "@/lib/host";
import { useArrangementValue } from "@/lib/layout-overrides";
import { cn } from "@/lib/utils";
import { writeArrangementField } from "@/lib/layout/arrangement-gestures";
import {
  insertRailDivider,
  moveRailEntry,
  sideTabStripEdge,
  stackRailPanels,
  unstackRail,
  type BarHost,
  type EdgeSide,
  type SideStripView,
  type TabStripPlacement,
} from "@/lib/layout/layout-arrangement";
import {
  EpicSessionContext,
  getOpenEpicRegistry,
} from "@/lib/registries/epic-session-registry";
import type { LayoutSnapshot } from "@/lib/layout/layout-snapshot";
import type { RegionId } from "@/lib/layout/region-id";
import { createPersistentMemoryHistory } from "@/lib/persistent-history";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import {
  __setAgentActivityStateForTests,
  __setHostAgentActivityHealthForTests,
} from "@/stores/agent-activity-store";
import {
  useLeftPanelStore,
  useMainPanelCollapsed,
  useSidebarWidthPx,
} from "@/stores/epics/left-panel-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { LeftPanelId } from "@/lib/left-panel-ids";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";
import { useAuthStore } from "@/stores/auth/auth-store";
import type { EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import { openStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";
import type { ChatProjection, TreeNode } from "@/stores/epics/open-epic/types";
import {
  useSettingsStore,
  type ThemeMode,
} from "@/stores/settings/settings-store";
import { useSideTabStripStore } from "@/stores/layout/side-tab-strip-store";
import {
  useLayoutEditorStore,
  type LayoutDockMode,
} from "@/stores/layout/layout-editor-store";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  getLayoutSnapshot,
  useLayoutStore,
  useStatusBarShown,
} from "@/stores/layout/layout-store";
import { sampleWorkspaceTabModule } from "@/stores/tabs/kinds/sample-workspace";
import { tabItemId } from "@/stores/tabs/layout";
import { type TabsStoreState, useTabsStore } from "@/stores/tabs/store";
import { tabAppearance } from "@/stores/tabs/types";
import { seedSideStripTabs } from "./side-tab-strip-seed";
import { LayoutSettingsPanel } from "@/components/settings/panels/layout-settings-panel";
import { ProvidersSettingsPanel } from "@/components/settings/panels/providers-settings-panel";
import { useSettingsAnchorReveal } from "@/components/settings/use-settings-anchor-reveal";
import { navigateToLayoutRegion } from "@/lib/settings-navigation";
import { useSettingsSearchStore } from "@/stores/settings/settings-search-store";
import { setSystemTabModalApi } from "@/stores/tabs/system-tab-modal-bridge";
import type { SystemTabModalApi } from "@/stores/tabs/use-system-tab-modal";
import { SettingsDensityContext } from "@/providers/settings-density-context";
import { AppStatusBar } from "@/components/layout/status-bar/app-status-bar";
import { focusGuideTarget } from "@/components/onboarding/guide-target";
import { NavigatorResourceHotspotChip } from "@/components/resources/resource-usage-chip";
import { useNavigatorResourceMetrics } from "@/hooks/resources/use-navigator-resource-metrics";
import "@/lib/theme-applier";
import "@/index.css";
import "@/components/layout-editor/layout-editor.css";

/**
 * THE CANVAS INTERACTION REGRESSION (L-115 .. L-135), in real Chrome with real
 * mouse input.
 *
 * Three review gates and thousands of jsdom tests passed while the sample
 * workspace's chat pane was wrapped in `inert`, so in the shipped app nothing
 * on it could be hovered, selected by pointing or dragged (LV2-01). jsdom has
 * no hit testing, no layout and no paint order, so none of that was observable
 * there and none of it can be observed there now. This fixture mounts the app
 * column the way `app-shell.tsx` builds it, puts the REAL sample scene inside
 * it and the REAL editor beside it, and the driver drives it with
 * `Input.dispatchMouseEvent`.
 *
 * What it mounts, and why that is the app:
 *
 * - `AppColumnFrame`, the shell's own composition of the app column
 *   (`app-shell.tsx` renders the same component), inside the same
 *   `RootDndProvider`, with the placement and band kind read through
 *   `useAppColumnChromeInput` and `appColumnChrome`, exactly as the shell
 *   reads them. For `top` its `header` slot is an opaque `relative z-20`
 *   header specimen. That header is not decoration: it is the element that painted
 *   over the editing outline when the outline was the column's own `outline`
 *   (LV2-04), so the frame's pixels are measured under the same condition that
 *   broke it. It also carries the editor's own TAB, in the real `TabChrome`,
 *   in the same 36px frame the strip gives a tab. For `left` and `right` the
 *   `strip` slot is the REAL `SideTabStrip` over a seeded tabs store (top
 *   block, rows through `useStripTabItem`, the session row, the foot), and a
 *   band kind of `"band"` draws the REAL `DesktopMenuHeader variant="title-band"`;
 *   the specimen header is never used for a side placement.
 * - `SampleWorkspaceBody`, which is the sample rail, the sample transcript and
 *   minimap, the REAL chat lower dock with its real panels, and the REAL
 *   composer toolbar fed the scene's sample dictation control (L-98, L-116).
 * - `<LayoutEditor column={...} />` verbatim, so `useLayoutCanvas`,
 *   `installEditFirewall`, the selection ring, the hover chip and the
 *   inspector are the shipped wiring rather than a re-statement of it.
 *
 * The query `?tabs=top|left|right&collapsed=0|1&wco=none|mac|win|mac-fullscreen&dock=right|left|float`
 * is read once before mount. It seeds the stored placement, the strip's
 * collapsed flag and the inspector dock, and for a desktop `wco` it stands in
 * for the preload and for `window-controls-overlay.ts`: `window.runnerHost` is
 * the fixture's runner host carrying `menu.platform`, so `isFramelessDesktop()`
 * and `resolveDesktopPlatform` answer as on that desktop, and `.wco` goes on
 * `<html>` (except `mac-fullscreen`, where macOS drops the overlay). There is
 * no popup bridge, so the Windows band is its empty drag band, and the
 * `env(titlebar-area-*)` fallbacks (82px leading inset, 40px band) stand in for
 * the real values. `&surface=sample|epic` picks what the surface frame holds
 * (the sample workspace's route sheet, or a task's panel and content sheets
 * with the real width handle between them), `&sidebar=left|right` and
 * `&view=layered|activity` seed the arrangement, `&account=1` signs a
 * fixture user in, so the foot draws the account row, and `&header=app` puts
 * the REAL `AppHeader` and its tab strip in the top placement's header slot. What cannot be
 * simulated here - native window controls,
 * real `env()` values, `-webkit-app-region`, the menu bar's native popups and
 * the signed-in foot - is the Staging pass's (tickets/12, "Staging checklist").
 *
 * The session is begun through the editor store's own `beginSession`, which is
 * what `editor-session.ts` calls once past the door. Nothing here writes a
 * `data-layout-*` attribute by hand: every attribute the driver asserts on is
 * one the product put there.
 *
 * `window.__layoutCanvasProbe.ready` gates all of it.
 */

/**
 * The editor tab's colour, taken from the tab the app really opens.
 *
 * Restating `var(--warning-foreground)` here would make the fixture agree with
 * itself rather than with the product, and the thing being measured on this
 * tab is precisely what the chrome does with the colour it is handed.
 */
const SESSION_TAB_COLOR: string | null =
  tabAppearance(sampleWorkspaceTabModule.build(null))?.color ?? null;

/**
 * The editor's own tab, on the geometry that puts it under the frame (L-163).
 *
 * `app-shell.tsx` gives the header `h-10` and a tab an `h-9` frame, and the
 * tab's box sits 2px inside that frame, so its top edge runs 2px under the
 * editing frame's dotted stroke, held 4px inside the column.
 * The real `TabChrome` in its `session` state is what paints the tab, and it
 * reads only props, so A9 can ask this specimen what the product does. The
 * width is fixed because a tab's width is a SIMULATED fact here, the same
 * exception the preset miniature takes.
 */
function SessionTabSpecimen(): ReactNode {
  return (
    <span data-fixture-session-tab className="relative h-9 w-48 shrink-0">
      <TabChrome isActive joined={false} color={SESSION_TAB_COLOR} session />
      {/* The label colour the real tab gives itself on this fill, restated
          rather than imported: `header-tab-visual.tsx` exports components
          only, and a string export would cost that file its fast refresh. */}
      <span className="relative z-20 flex h-full items-center justify-center text-background">
        Customizing
      </span>
    </span>
  );
}

/**
 * Why a region has no node on this canvas, one line each.
 *
 * All three are shell chrome the app column draws OUTSIDE the sample tab, and
 * each resolves a runtime this fixture has no host for. The driver prints them
 * rather than counting them as covered.
 */
const NO_CANVAS_NODE: Readonly<Partial<Record<RegionId, string>>> = {
  homeTab:
    "at the top placement this fixture's header is a specimen with no tab strip; the real Home is measured in the side-strip variants, where the real SideTabStrip draws it",
  usageLimits:
    "the status bar's usage cluster resolves the watched host's rate-limit subscription, which needs a live host",
  resourceMonitor:
    "StatusBarResourceSegment resolves its readings through the desktop sampler and the resource registry, neither of which exists off Electron",
  railArtifacts:
    "the shipped rail stacks Artifacts under Agents, and a stack draws as one group icon, the top panel's (G3); Artifacts is reached through the inspector, where the group lists both",
};

/** The fixture's desktop stand-in: which window chrome `wco` simulates. */
type FixtureWindowChrome = "none" | "mac" | "win" | "mac-fullscreen";

/**
 * What the app column's surface frame holds: the sample workspace, which is a
 * route sheet in the app, or a task's two sheets (panel and content), which is
 * what the joined tab and the Activity view are about.
 */
type FixtureSurface = "sample" | "epic";

interface CanvasVariant {
  readonly tabs: TabStripPlacement;
  readonly collapsed: boolean;
  readonly wco: FixtureWindowChrome;
  readonly dock: LayoutDockMode;
  readonly surface: FixtureSurface;
  readonly sidebar: EdgeSide;
  readonly view: SideStripView;
  /** Signed in, so the foot draws the account row and the strip the Notifications. */
  readonly account: boolean;
  /**
   * Three hosts in the directory (staging round 1, F5): two dialable, one
   * with no route, so the account menu's Host section draws every row state.
   */
  readonly hosts: boolean;
  /**
   * This computer's host alone, with a registry that lists nothing else (F8):
   * a one-host account, the case a local activity plane must still read idle.
   */
  readonly solo: boolean;
  /**
   * Epsilon's session is REGISTERED, with its agents as chats, so a hover
   * card names them as it does for any epic this window holds live (G5).
   */
  readonly warm: boolean;
  /** Which readings the header (the strip foot, beside a side strip) holds (F6). */
  readonly readings: "none" | "usage" | "resource" | "both";
  /**
   * `app` mounts the REAL `AppHeader` at the top placement, so its tab strip
   * (Home, the seeded tabs and split pair, the new-tab button) is measured as
   * it ships; `specimen` is the session-tab specimen the canvas phases use.
   */
  readonly header: "specimen" | "app";
  /**
   * `1` mounts the REAL Settings ▸ Layout panel where the editor would be
   * (G6), beside the live app column with its status bar, so a driver can
   * operate every setting there and read its effect on the product.
   */
  readonly settings: boolean;
  /** Which settings panel the pane holds under `settings=1` (H2): `providers` for the side-by-side. */
  readonly panel: "layout" | "providers";
  /** `full` draws the settings pane ALONE, filling the window, so a width is the panel's own (H2). */
  readonly pane: "side" | "full";
}

interface LayoutCanvasProbe {
  readonly ready: boolean;
  /** The query this document was mounted with, as parsed. */
  readonly variant: CanvasVariant;
  readonly regionIds: ReadonlyArray<RegionId>;
  readonly noCanvasNode: Readonly<Partial<Record<RegionId, string>>>;
  /** Each region's own name, so the driver checks the chip against the product's word. */
  readonly names: Readonly<Record<string, string>>;
  /** Back to the shipped defaults, so every phase starts from the same layout. */
  readonly reset: () => void;
  readonly beginSession: () => void;
  readonly endSession: () => void;
  readonly setDockMode: (mode: LayoutDockMode) => void;
  /** Both the leading dock members at Chip, which is what folds them into pills. */
  readonly foldDockPills: () => void;
  readonly unfoldDockPills: () => void;
  readonly setMicShown: (shown: boolean) => void;
  /**
   * One of the two combinations the deleted Style row used to write as a
   * named example (T2, L-10 partial): now written field by field, the way
   * the "Show" checks and "Amount" segment write them - so the driver can
   * show the strip's reading follows those fields (G6).
   */
  readonly applyUsageStyle: (exampleId: "barOnly" | "barPercent") => void;
  /** A Settings search result for `anchor` on the Layout page (H2). */
  readonly revealSetting: (anchor: string) => void;
  /** The editor door's deep link to a region's row, as the width gate sends it (H2). */
  readonly landOnRegion: (regionId: RegionId) => void;
  /**
   * Publishes the Settings modal API `landOnRegion` publishes, so an in-page
   * control that takes the same door (the Sidebar's "Choose metrics") can be
   * clicked for real (L-174).
   */
  readonly openSettingsApi: () => void;
  /** The region's area, opened with no row selected, so its row can be hovered. */
  readonly openAreaOf: (regionId: RegionId) => void;
  /** A setup guide step's focus return onto the element at `selector` (H2). */
  readonly focusGuideTarget: (selector: string) => boolean;
  /** Hidden AND Chip, the shape whose only picture used to be the row it never takes. */
  readonly hideChangedFilesAsChip: () => void;
  /**
   * One divider in the rail, between Artifacts and Terminals.
   *
   * The shipped rail has none (L-155), and the two rail drag plans need a
   * divider to aim at. Written through the arrangement's own `insertRail
   * Divider`, so the entry the driver grabs is the one the product mints -
   * including its id, which is `divider:1` on a rail that has used no seq.
   */
  readonly addRailDivider: () => void;
  /**
   * Terminals joined to Browsers the way the inspector's row action does it -
   * the panel BELOW as the source, so the join moves nothing (L-170) - through
   * the product's own writer and inside a recorded gesture, so the driver can
   * assert the capsule the rail draws for a pair and the one history step the
   * join costs (L-166, L-168).
   */
  readonly stackTerminalsWithBrowsers: () => void;
  /**
   * One panel added to another's stack through the rail's own writer, inside a
   * recorded gesture, so the driver can grow a stack past two (L-181).
   */
  readonly stackPanelInto: (source: LeftPanelId, target: LeftPanelId) => void;
  /**
   * One rail entry moved to an index through the Position list's own writer,
   * inside a recorded gesture: how a group's members trade places (G3).
   */
  readonly moveRailEntry: (entryId: string, toIndex: number) => void;
  /** One stack link taken out, as the Position list's Unstack does (L-168). */
  readonly unstackRail: (entryId: string) => void;
  readonly clearSelection: () => void;
  readonly snapshot: () => LayoutSnapshot;
  readonly historyDepth: () => number;
  /** The stored theme mode; persisted, so a check that sets it restores `"system"` for the next document. */
  readonly setTheme: (theme: ThemeMode) => void;
  /**
   * Makes one seeded epic tab the active item, as the strip's own activation
   * leaves the tabs store once the route bridge has followed the navigation.
   * The fixture's router has no epic routes and no route bridge, so a click's
   * navigation lands nowhere; what the rail check measures is the paint of an
   * ACTIVE tinted tile, not the activation path.
   */
  readonly activateEpicTab: (epicId: string) => void;
  /** The same for any strip item, the split pair included (`fixture-split`). */
  readonly activateStripItem: (itemId: string) => void;
  /**
   * What the host answered for `host.notifications.indicatorState`, per epic
   * and per agent: the rail badges and the waiting pulse read the epics, the
   * Activity list's waiting chips read the agents.
   */
  readonly setIndicators: (
    epics: HostNotificationsIndicatorStateResponse["epics"],
    chats: HostNotificationsIndicatorStateResponse["chats"],
  ) => void;
  /** The activity plane's working and turn agents per epic: the meters read it. */
  readonly setActivity: (byEpic: AgentActivityByEpic) => void;
  /**
   * One host's own activity stream (F8): `fleet` a cloud union that vouches
   * for every host, `partial` a local plane that answers for this host only,
   * `none` a stream not open. The union's rows stay where `setActivity` put
   * them; this is the reach, stated for a host the directory knows.
   */
  readonly setActivityCoverage: (
    hostId: string,
    coverage: "fleet" | "partial" | "none",
  ) => void;
  readonly setCollapsed: (collapsed: boolean) => void;
  readonly setStripView: (view: SideStripView) => void;
  /** The panel's side, through the writer the dock rows and the placement bar use. */
  readonly setSidebarSide: (side: EdgeSide) => void;
  /** The tab strip's edge, through the writer the placement bar and the dock row use. */
  readonly setTabPlacement: (placement: TabStripPlacement) => void;
  /** The task panel collapsed to its rail, through the store the rail's toggle writes. */
  readonly setPanelCollapsed: (collapsed: boolean) => void;
  /**
   * Holds every host activation until `releaseActivations` (R1-A2), so the
   * driver can reopen the account menu while a switch is still in flight;
   * `activationCount` is how many reached the authority.
   */
  readonly holdActivations: () => void;
  readonly releaseActivations: () => void;
  readonly activationCount: () => number;
  /**
   * Everything a check changes LIVE, back to the document as it was loaded,
   * so one load can serve every check that shares its load-time
   * configuration (`wco`, `surface`, `account`, `hosts`, `header`,
   * `readings`, which are read once at mount): the layout snapshot (with the
   * URL's placement, sidebar side and strip view), the strip's width and
   * collapse, the inspector's dock, the theme, the panel's collapse, the
   * indicators and activity a check fed in, a slowed panel-motion token, any
   * open session, and the seeded tabs (`restoreTabs`).
   */
  readonly restoreLoadState: () => void;
  /**
   * The seeded tabs, as the document loaded them: a reorder or an activation
   * undone. It puts back the very objects the load seeded, so a strip no
   * check changed re-renders nothing and a changed one keeps its rows mounted.
   */
  readonly restoreTabs: () => void;
  /**
   * Which readings the strip foot (or header) holds, live: the layout's
   * `usageHost` / `resourceHost`, which `readings=` writes only at load. The
   * readings plumbing itself (the usage poll, the resource stream) is what
   * `readings=usage|resource|both` mounts at load, so a load that will switch
   * between these is loaded with `readings=both`.
   */
  readonly setReadings: (readings: CanvasVariant["readings"]) => void;
  /**
   * The production constants a check used to restate, taken from the module
   * that owns them, so a drift in the design is a red test rather than two
   * copies of a number agreeing.
   */
  readonly tokens: {
    readonly stripRailWidthPx: number;
    readonly stripMinWidthPx: number;
    readonly stripDefaultWidthPx: number;
    readonly stripSnapToRailBelowPx: number;
  };
}

declare global {
  interface Window {
    __layoutCanvasProbe?: LayoutCanvasProbe;
  }
}

/**
 * Between Artifacts and Terminals, which is where the rail plans aim.
 *
 * Index 3 rather than 2 since L-166: the shipped rail carries a stack LINK
 * between Agents and Artifacts, so the entries are `railAgents`,
 * `stack:railAgents+railArtifacts`, `railArtifacts`, `railTerminals`, and a
 * divider at 2
 * would land inside the stack rather than after it (where `normalizeRail`
 * would then drop the join).
 */
const RAIL_DIVIDER_INDEX = 3;

function readVariant(): CanvasVariant {
  const params = new URLSearchParams(window.location.search);
  const tabs = params.get("tabs");
  const wco = params.get("wco");
  const dock = params.get("dock");
  return {
    tabs: tabs === "left" || tabs === "right" ? tabs : "top",
    collapsed: params.get("collapsed") === "1",
    wco:
      wco === "mac" || wco === "win" || wco === "mac-fullscreen" ? wco : "none",
    dock: dock === "left" || dock === "float" ? dock : "right",
    surface: params.get("surface") === "epic" ? "epic" : "sample",
    sidebar: params.get("sidebar") === "right" ? "right" : "left",
    view: params.get("view") === "activity" ? "activity" : "layered",
    account: params.get("account") === "1",
    hosts: params.get("hosts") === "1",
    solo: params.get("solo") === "1",
    warm: params.get("warm") === "1",
    readings: readReadings(params.get("readings")),
    header: params.get("header") === "app" ? "app" : "specimen",
    settings: params.get("settings") === "1",
    panel: params.get("panel") === "providers" ? "providers" : "layout",
    pane: params.get("pane") === "full" ? "full" : "side",
  };
}

function readReadings(value: string | null): CanvasVariant["readings"] {
  return value === "usage" || value === "resource" || value === "both"
    ? value
    : "none";
}

const VARIANT = readVariant();

/**
 * The `hosts=1` fleet (staging round 1, F5): this computer's host ("Mac
 * Studio", which the authority derives as the window's host), a remote this
 * window can dial, and one with no route - the row the account menu's Host
 * section draws inert. The remotes are both the directory's (the remote
 * fetcher) and the mock authority's fleet, so an Activate from the menu goes
 * through the real authority engine.
 */
const FIXTURE_LOCAL_HOST: LocalHostSnapshot = {
  hostId: "fixture-host-studio",
  websocketUrl: "ws://127.0.0.1:9/studio",
  version: "1.2.3",
  pid: 1,
  systemHostName: "mac-studio.local",
  displayName: "Mac Studio",
  availability: "available",
};
const FIXTURE_REMOTE_HOSTS: readonly HostDirectoryEntry[] = [
  {
    hostId: "fixture-host-builder",
    // Long enough to overrun the account menu's width (G4): it truncates in
    // its row and reads in full from the row's tooltip.
    label: "build-vm-01.asia-south2-b.c.example-project.internal (staging)",
    kind: "remote",
    websocketUrl: "ws://127.0.0.1:9/builder",
    version: "1.2.3",
    transportDialability: "dialable",
  },
  {
    hostId: "fixture-host-mini",
    // Offline and long (G4): an inert row still reveals a truncated name.
    label: "gpu-runner-02.us-central1-a.c.example-project.internal (nightly)",
    kind: "remote",
    websocketUrl: null,
    version: "1.2.3",
    transportDialability: "not-dialable",
  },
];

/** The shipped defaults with the variant's stored placement, which `reset` returns to. */
const VARIANT_SNAPSHOT: LayoutSnapshot = {
  ...DEFAULT_LAYOUT_SNAPSHOT,
  arrangement: {
    ...DEFAULT_LAYOUT_SNAPSHOT.arrangement,
    tabStripPlacement: VARIANT.tabs,
    sidebarSide: VARIANT.sidebar,
    sideStripView: VARIANT.view,
    usageHost:
      VARIANT.readings === "usage" || VARIANT.readings === "both"
        ? "header"
        : DEFAULT_LAYOUT_SNAPSHOT.arrangement.usageHost,
    resourceHost:
      VARIANT.readings === "resource" || VARIANT.readings === "both"
        ? "header"
        : DEFAULT_LAYOUT_SNAPSHOT.arrangement.resourceHost,
  },
};

/**
 * Back to the variant's layout. Beside a side strip Home is shown, so the
 * strip's top block carries every control it can; the shipped default hides
 * it, and at the top the fixture's header specimen has no Home to show.
 */
function resetLayout(): void {
  useLayoutStore.getState().replaceAll(VARIANT_SNAPSHOT);
  if (VARIANT.tabs !== "top") {
    useLayoutStore.getState().setRegionValues("homeTab", { shown: "shown" });
  }
  // The three readings the strip's resource tile has to fit (F6).
  if (VARIANT.readings !== "none") {
    useLayoutStore.getState().setRegionValues("resourceMonitor", {
      cpu: true,
      memory: true,
      processes: false,
      ramShare: true,
    });
  }
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});

/**
 * What the account's host registry says under `hosts=1`: the gpu runner last
 * checked in a day ago and is offline, which is what gives its row the word.
 * The fixture has no authn, whose fetch answers a signed-out `null`, so the
 * registry query is answered with this whenever it holds anything else.
 */
const FIXTURE_REGISTRY: HostListResponse = {
  hosts: FIXTURE_REMOTE_HOSTS.map((entry) => ({
    hostId: entry.hostId,
    displayName: entry.label,
    platform: "darwin",
    kind: "personal",
    publicKey: "fixture",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatePolicy: "manual",
    status: {
      connectivity: entry.websocketUrl === null ? "offline" : "connectable",
      viewerReachability: "unknown",
      clientCloud: "ok",
      updateState: "current",
      appVersion: entry.version,
      lastSeenAt: new Date(Date.now() - 86_400_000).toISOString(),
    },
  })),
};
if (VARIANT.hosts) {
  queryClient.getQueryCache().subscribe(() => {
    for (const query of queryClient
      .getQueryCache()
      .findAll({ queryKey: ["auth", "registered-hosts"] })) {
      if (query.state.data !== FIXTURE_REGISTRY)
        queryClient.setQueryData(query.queryKey, FIXTURE_REGISTRY);
    }
  });
}

/**
 * The indicator answer `setIndicators` last gave, kept on EVERY
 * `host.notifications.indicatorState` entry rather than written once. A
 * one-shot write reached only the entries that existed at that instant: an
 * entry keyed by an epic set the strip settled on a beat later, or a mock
 * reply landing after the write, left the rail's badges empty on a cold first
 * load. Re-applied on every cache event, so there is no window and no timer.
 */
let fixtureIndicators: HostNotificationsIndicatorStateResponse | null = null;
/**
 * Compared by value: `setQueryData` shares structure with what was there, so
 * the stored object is never the answer itself. The guard stops the write's
 * own synchronous cache event from re-entering.
 */
let applyingFixtureIndicators = false;
function applyFixtureIndicators(): void {
  if (fixtureIndicators === null || applyingFixtureIndicators) return;
  const answer = JSON.stringify(fixtureIndicators);
  applyingFixtureIndicators = true;
  try {
    for (const query of queryClient.getQueryCache().findAll()) {
      // Every host's entry: the method follows the host scope, which is
      // `["host"]` alone with no host directory and `["host", hostId]` with one.
      if (!query.queryKey.includes("host.notifications.indicatorState"))
        continue;
      if (JSON.stringify(query.state.data) === answer) continue;
      queryClient.setQueryData(query.queryKey, fixtureIndicators);
    }
  } finally {
    applyingFixtureIndicators = false;
  }
}
queryClient.getQueryCache().subscribe(applyFixtureIndicators);

const runnerHost = new MockRunnerHost({
  signInUrl: "http://127.0.0.1:9/sign-in",
  authnBaseUrl: "http://127.0.0.1:9",
  localHost: VARIANT.hosts || VARIANT.solo ? FIXTURE_LOCAL_HOST : null,
  hosts: VARIANT.hosts ? FIXTURE_REMOTE_HOSTS : [],
  workspaceFolderPickerPaths: undefined,
  hasLocalHost: undefined,
  traycerCli: undefined,
});

/**
 * The authority's `activate`, wrapped so the driver can hold a switch in
 * flight (R1-A2): the mock authority answers at once, so without a hold there
 * is no pending state to look at. Calls are counted when they reach the
 * authority, which is what a second, unguarded switch would change.
 */
let heldActivations: Array<() => void> | null = null;
let activationCount = 0;
{
  const authority = runnerHost.selectionAuthority;
  const activate = authority.activate.bind(authority);
  Reflect.set(authority, "activate", async (hostId: string) => {
    activationCount += 1;
    const held = heldActivations;
    if (held !== null)
      await new Promise<void>((resolve) => {
        held.push(resolve);
      });
    return activate(hostId);
  });
}

let requestCounter = 0;

/**
 * Two signed-in providers, so the usage tile has two real readings to fit
 * (F6): Codex and Claude Code, the pair the glyph's two slots stand for.
 */
const FIXTURE_PROVIDERS = providersListResponseSchema.parse({
  providers: (["codex", "claude-code"] as const).map((providerId) => ({
    providerId,
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [],
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
  })),
  native: null,
});

const FIXTURE_RESETS_AT = Date.now() + 2 * 3_600_000;

/** Codex at 19% of its 5h window, Claude Code at 62% of its own. */
function fixtureRateLimitUsage(providerId: string | undefined) {
  const window = (usedPercent: number, durationMinutes: number) => ({
    usedPercent,
    resetsAt: FIXTURE_RESETS_AT,
    durationMinutes,
  });
  return rateLimitUsageResponseSchemaV40.parse({
    totalTokens: 0,
    remainingTokens: 0,
    providerRateLimits:
      providerId === "codex"
        ? {
            provider: "codex",
            available: true,
            planType: "pro",
            limitId: null,
            limitName: null,
            primary: window(19, 300),
            secondary: window(23, 10_080),
            extraWindows: [],
            credits: null,
            individualLimit: null,
            resetCredits: null,
            rateLimitReachedType: null,
          }
        : {
            provider: "claude-code",
            available: true,
            subscriptionType: "max",
            fiveHour: window(62, 300),
            sevenDay: window(41, 10_080),
            sevenDayOpus: null,
            sevenDaySonnet: null,
            modelScoped: [],
            extraUsage: null,
          },
  });
}

/**
 * This computer's resource stream, answered once (F6): the host tree at 14%
 * CPU and 3.2 GB of a 32 GB machine, which is what the resource tile reads.
 * The fixture mounts no `ResourcesStreamMount`, so the global entry is this.
 */
if (VARIANT.readings !== "none") {
  const sampledAt = Date.now();
  resourcesRegistry.acquireGlobal("fixture", FIXTURE_LOCAL_HOST.hostId, () =>
    createResourcesStore({
      scope: { kind: "global" },
      streamClientFactory: (_scope, callbacks) => {
        queueMicrotask(() => {
          callbacks.onScopeSupport("supported");
          callbacks.onSnapshot({
            epicId: "__global__",
            sampledAt,
            app: {
              sampledAt,
              hostTotalMemoryBytes: 32 * 1024 ** 3,
              process: {
                pid: 10,
                parentPid: null,
                rootPid: 10,
                name: "traycer-host",
                command: "traycer-host",
                cpuPercent: 2,
                rssBytes: 400 * 1024 ** 2,
                pssBytes: null,
                privateBytes: null,
                descriptor: null,
              },
              processCount: 1,
              cpuPercent: 2,
              rssBytes: 400 * 1024 ** 2,
              pssBytes: null,
              privateBytes: null,
            },
            owners: [],
            epic: null,
            epics: [],
            hostTree: {
              sampledAt,
              processCount: 12,
              cpuPercent: 14,
              rssBytes: 3.2 * 1024 ** 3,
              pssBytes: null,
              privateBytes: null,
            },
            other: null,
            restricted: null,
          });
        });
        return { close: () => undefined, setDemand: () => undefined };
      },
    }),
  );
}

/**
 * A messenger that answers the three calls the runtime makes on startup and
 * nothing else.
 *
 * The sample scene addresses `sample-workspace-host`, which is in no
 * directory, so every panel inside it resolves a null client and asks nothing.
 * What this is here for is the app-wide runtime the dock's real panels are
 * written against: without a `HostRuntimeProvider` their hooks throw at import
 * of the first render, which is the boundary the jsdom suite fakes away.
 */
const messengerFactory: MessengerFactory<HostRpcRegistry> = ({ registry }) =>
  new MockHostMessenger<HostRpcRegistry>({
    registry,
    requestId: () => `layout-canvas-${String(++requestCounter)}`,
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
      "providers.list": () => FIXTURE_PROVIDERS,
      "host.getRateLimitUsage": (params) =>
        fixtureRateLimitUsage(params.providerId),
    },
  });

/** A system modal that is showing Settings, for `landOnRegion`. */
const SETTINGS_OPEN_API: SystemTabModalApi = {
  active: null,
  openSettings: () => undefined,
  openHistory: () => undefined,
  close: () => undefined,
  setSection: () => undefined,
  promoteToTab: () => undefined,
  isOverlayActive: (kind) => kind === "settings",
};

function regionNames(): Readonly<Record<string, string>> {
  const names: Record<string, string> = {};
  for (const regionId of LAYOUT_REGION_IDS)
    names[regionId] = regionFacts(regionId).name;
  return names;
}

function buildProbe(): LayoutCanvasProbe {
  return {
    ready: true,
    variant: VARIANT,
    regionIds: LAYOUT_REGION_IDS,
    noCanvasNode: NO_CANVAS_NODE,
    names: regionNames(),
    reset: () => {
      resetLayout();
    },
    beginSession: () => {
      useLayoutEditorStore.getState().beginSession({
        entry: "pointer",
        source: "direct_ui",
        startedAt: 0,
        origin: { kind: "tab" },
      });
    },
    endSession: () => {
      useLayoutEditorStore.getState().endSession();
    },
    setDockMode: (mode) => {
      useLayoutEditorStore.getState().setDockMode(mode);
    },
    foldDockPills: () => {
      useLayoutStore.getState().setRegionValues("changedFiles", {
        shown: "shown",
        size: "chip",
      });
      useLayoutStore.getState().setRegionValues("runningAgents", {
        shown: "shown",
        size: "chip",
      });
    },
    unfoldDockPills: () => {
      useLayoutStore
        .getState()
        .setRegionValues("changedFiles", { shown: "shown", size: "full" });
      useLayoutStore
        .getState()
        .setRegionValues("runningAgents", { shown: "shown", size: "full" });
    },
    setMicShown: (shown) => {
      useLayoutStore
        .getState()
        .setRegionValues("mic", { shown: shown ? "shown" : "hidden" });
    },
    revealSetting: (anchor) => {
      useSettingsSearchStore.getState().requestReveal("layout", anchor);
    },
    landOnRegion: (regionId) => {
      // The settings pane is already open here, which is what the modal's API
      // would answer; the door needs one to publish its request.
      setSystemTabModalApi(SETTINGS_OPEN_API);
      navigateToLayoutRegion(regionId);
    },
    openSettingsApi: () => {
      setSystemTabModalApi(SETTINGS_OPEN_API);
    },
    openAreaOf: (regionId) => {
      useLayoutEditorStore
        .getState()
        .openArea(LAYOUT_REGIONS[regionId].surface, null);
    },
    focusGuideTarget: (selector) => {
      const target = document.querySelector<HTMLElement>(selector);
      return target !== null && focusGuideTarget(target);
    },
    applyUsageStyle: (exampleId) => {
      const patch =
        exampleId === "barOnly"
          ? {
              bar: true,
              percent: false,
              word: false,
              reset: false,
              amount: "used" as const,
            }
          : {
              bar: true,
              percent: true,
              word: false,
              reset: false,
              amount: "used" as const,
            };
      useLayoutStore.getState().setRegionValues("usageLimits", patch);
    },
    hideChangedFilesAsChip: () => {
      useLayoutStore
        .getState()
        .setRegionValues("changedFiles", { shown: "hidden", size: "chip" });
    },
    addRailDivider: () => {
      const { arrangement } = useLayoutStore.getState();
      useLayoutStore
        .getState()
        .setArrangement(insertRailDivider(arrangement, RAIL_DIVIDER_INDEX));
    },
    // Through `recordGesture`, unlike `addRailDivider`: this one IS the
    // gesture under test, so its history step is the thing being counted.
    stackTerminalsWithBrowsers: () => {
      useLayoutEditorStore.getState().recordGesture(() => {
        const { arrangement } = useLayoutStore.getState();
        useLayoutStore
          .getState()
          .setArrangement(
            stackRailPanels(arrangement, "browsers", "terminals", "panel"),
          );
      });
    },
    stackPanelInto: (source, target) => {
      useLayoutEditorStore.getState().recordGesture(() => {
        const { arrangement } = useLayoutStore.getState();
        useLayoutStore
          .getState()
          .setArrangement(
            stackRailPanels(arrangement, source, target, "panel"),
          );
      });
    },
    moveRailEntry: (entryId, toIndex) => {
      useLayoutEditorStore.getState().recordGesture(() => {
        const { arrangement } = useLayoutStore.getState();
        useLayoutStore
          .getState()
          .setArrangement(moveRailEntry(arrangement, entryId, toIndex));
      });
    },
    unstackRail: (entryId) => {
      useLayoutEditorStore.getState().recordGesture(() => {
        const { arrangement } = useLayoutStore.getState();
        useLayoutStore
          .getState()
          .setArrangement(unstackRail(arrangement, entryId));
      });
    },
    clearSelection: () => {
      useLayoutEditorStore.getState().select(null);
    },
    snapshot: () => getLayoutSnapshot(),
    historyDepth: () => useLayoutEditorStore.getState().history.past.length,
    setTheme: (theme) => {
      useSettingsStore.getState().setTheme(theme);
    },
    activateEpicTab: (epicId) => {
      useTabsStore.setState({
        activeItemId: tabItemId({ kind: "epic", id: epicId }),
      });
    },
    activateStripItem: (itemId) => {
      useTabsStore.setState({ activeItemId: itemId });
    },
    // Stands in for the host's reply; `applyFixtureIndicators` keeps every
    // indicator entry answered with it, including ones that appear later.
    setIndicators: (epics, chats) => {
      fixtureIndicators = { epics, chats };
      applyFixtureIndicators();
    },
    setActivity: (byEpic) => {
      __setAgentActivityStateForTests(byEpic, "local", null);
    },
    setActivityCoverage: (hostId, coverage) => {
      __setHostAgentActivityHealthForTests(hostId, {
        connectionStatus: coverage === "none" ? "connecting" : "open",
        servedBy: coverage === "fleet" ? "cloud" : "local",
        cloudSyncStatus: coverage === "fleet" ? "connected" : null,
        stateFrameSeenThisEpoch: coverage !== "none",
      });
    },
    setCollapsed: (collapsed) => {
      useSideTabStripStore.getState().setCollapsed(collapsed);
    },
    setStripView: (view) => {
      const { arrangement } = useLayoutStore.getState();
      useLayoutStore
        .getState()
        .setArrangement({ ...arrangement, sideStripView: view });
    },
    setSidebarSide: (side) => {
      writeArrangementField("sidebarSide", side);
    },
    setTabPlacement: (placement) => {
      writeArrangementField("tabStripPlacement", placement);
    },
    holdActivations: () => {
      heldActivations = [];
    },
    releaseActivations: () => {
      const held = heldActivations ?? [];
      heldActivations = null;
      for (const resolve of held) resolve();
    },
    activationCount: () => activationCount,
    setPanelCollapsed: (collapsed) => {
      useLeftPanelStore.getState().setMainCollapsed(EPIC_SURFACE_ID, collapsed);
    },
    restoreLoadState: () => {
      const editor = useLayoutEditorStore.getState();
      editor.endSession();
      editor.setDockMode(VARIANT.dock);
      resetLayout();
      const strip = useSideTabStripStore.getState();
      strip.resetWidth();
      strip.setCollapsed(VARIANT.collapsed);
      useSettingsStore.getState().setTheme("system");
      useLeftPanelStore.getState().setMainCollapsed(EPIC_SURFACE_ID, false);
      fixtureIndicators = { epics: {}, chats: {} };
      applyFixtureIndicators();
      __setAgentActivityStateForTests({}, "local", null);
      document.documentElement.style.removeProperty(
        "--panel-animation-duration",
      );
      restoreLoadedTabs();
    },
    restoreTabs: restoreLoadedTabs,
    setReadings: (readings) => {
      const { arrangement } = useLayoutStore.getState();
      const shown = (wanted: boolean, fallback: BarHost): BarHost =>
        wanted ? "header" : fallback;
      useLayoutStore.getState().setArrangement({
        ...arrangement,
        usageHost: shown(
          readings === "usage" || readings === "both",
          DEFAULT_LAYOUT_SNAPSHOT.arrangement.usageHost,
        ),
        resourceHost: shown(
          readings === "resource" || readings === "both",
          DEFAULT_LAYOUT_SNAPSHOT.arrangement.resourceHost,
        ),
      });
    },
    tokens: {
      stripRailWidthPx: SIDE_STRIP_RAIL_WIDTH_PX,
      stripMinWidthPx: SIDE_STRIP_MIN_WIDTH_PX,
      stripDefaultWidthPx: SIDE_STRIP_DEFAULT_WIDTH_PX,
      stripSnapToRailBelowPx: SIDE_STRIP_SNAP_TO_RAIL_BELOW_PX,
    },
  };
}

/** The tabs store as the load seeded it, which `restoreLoadedTabs` puts back. */
let loadedTabs: TabsStoreState | null = null;

/**
 * The seeded tabs and, for a task window, Epsilon's one-pane canvas, in the
 * order the load applies them: seeding a task's record resets its canvas.
 */
function seedVariantTabs(variant: CanvasVariant): void {
  seedSideStripTabs(variant.surface === "sample");
  if (variant.surface === "epic") seedEpicSurfaceCanvas();
  loadedTabs = useTabsStore.getState();
}

/**
 * The tabs store back to the load's own objects: the order, the split pair,
 * the group, the active tab and its activation history.
 */
function restoreLoadedTabs(): void {
  if (loadedTabs === null) throw new Error("the fixture never seeded its tabs");
  useTabsStore.setState(loadedTabs);
}

/**
 * The fixture's header for the `top` placement: the paint-order condition
 * LV2-04 measured, reproduced. An opaque positioned strip on its own stacking
 * layer, flush with the column's top edge and both of its sides; an `outline`
 * on the column is painted underneath this, the shipped `::after` frame is not.
 */
function FixtureHeader(): ReactNode {
  if (VARIANT.header === "app") return <AppHeader variant="app" />;
  return (
    <header
      data-fixture-header
      className="relative z-20 flex h-10 shrink-0 items-end gap-3 border-b bg-canvas px-3 text-ui-sm"
    >
      <span className="self-center">Sample window</span>
      <SessionTabSpecimen />
    </header>
  );
}

/**
 * The sample workspace as the app mounts it: a route surface, which is one
 * sheet. `TopLevelSurfaceMount` puts the marker and the clip on the mount; the
 * fixture has no tab host, so it puts them on the same box around the body
 * (the host's absolute placement aside, which a single surface fills anyway).
 */
function SampleRouteSheet(): ReactNode {
  return (
    <div
      data-shell-sheet="route"
      className="relative flex h-full min-h-0 w-full min-w-0 flex-col overflow-clip"
    >
      {/* The sample notice, mirrored from `sample-workspace-surface.tsx`: the
          third half of the amber signal with the Customizing tab and the
          frame (design craft 2.3). Not dimmed, for the same reason the tab
          is not. */}
      <div
        data-sample-notice
        className="flex h-7 shrink-0 items-center justify-between gap-3 border-b border-warning-foreground/40 bg-warning-foreground/14 px-3 text-ui-xs font-medium text-warning-foreground"
      >
        <span className="flex min-w-0 items-center gap-2">
          <Info aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate">
            Sample workspace. Changes apply to your layout.
          </span>
        </span>
        <span className="truncate font-normal opacity-80">
          Point at any part of the app to change it.
        </span>
      </div>
      <SampleWorkspaceBody />
      <SampleStripLiveAgents tabId="sample-workspace" />
    </div>
  );
}

/** The active task in the `surface=epic` windows: Epsilon, which the seed makes active. */
const EPIC_SURFACE_ID = "fixture-epsilon";

/** Epsilon's agents, for the Activity view: two turns (one nested), one background. */
const EPIC_SURFACE_AGENTS: ReadonlyArray<TreeNode> = [
  chatNode("fixture-agent-plan", null, "Plan the migration"),
  chatNode("fixture-agent-tests", "fixture-agent-plan", "Write the tests"),
  chatNode("fixture-agent-index", null, "Rebuild the index"),
];

function chatNode(
  id: string,
  parentId: string | null,
  title: string,
): TreeNode {
  return {
    id,
    parentId,
    title,
    type: "chat",
    status: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

const noopStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

/**
 * Epsilon's session: a real open-epic store with its agents in the tree, so
 * the REAL `StripLiveAgentsPortal` reads a session exactly as the epic surface
 * hands it one. Built only for the `surface=epic` windows.
 */
function openEpicSurfaceSession() {
  const handle = openStoreForTest({
    epicId: EPIC_SURFACE_ID,
    userId: null,
    factories: {
      streamClientFactory: noopStreamClientFactory,
      laneSelection: null,
    },
    writeCommand: null,
  });
  const nodeById: Record<string, TreeNode> = {};
  const childrenByParent: Record<string, string[]> = {};
  const rootIds: string[] = [];
  for (const node of EPIC_SURFACE_AGENTS) {
    nodeById[node.id] = node;
    if (node.parentId === null) rootIds.push(node.id);
    else (childrenByParent[node.parentId] ??= []).push(node.id);
  }
  handle.store.setState({ tree: { rootIds, childrenByParent, nodeById } });
  if (VARIANT.warm) {
    const byId: Record<string, ChatProjection> = {};
    for (const node of EPIC_SURFACE_AGENTS) {
      byId[node.id] = {
        id: node.id,
        title: node.title,
        parentId: node.parentId,
        createdAt: 1,
        updatedAt: 1,
        userId: null,
        hostId: "test-local-host",
        isTitleEditedByUser: false,
        docResident: false,
        archivedAt: null,
        settings: null,
      };
    }
    handle.store.setState({
      chats: { allIds: Object.keys(byId), byId },
    });
    getOpenEpicRegistry().acquire(EPIC_SURFACE_ID, () => handle);
  }
  return handle;
}

const EPIC_SURFACE_SESSION =
  VARIANT.surface === "epic" ? openEpicSurfaceSession() : null;

/** The agent Epsilon's resource stream tracks (G7): "Plan the migration". */
const FIXTURE_TRACKED_AGENT_ID = "fixture-agent-plan";

/**
 * Epsilon's resource stream under `settings=1` (G7): one tracked agent, so the
 * agent row specimen has a reading for its chip - the real chip, through the
 * real registry, reading the real `agentRows` switch.
 */
if (VARIANT.settings && VARIANT.surface === "epic") {
  const sampledAt = Date.now();
  resourcesRegistry.acquire(EPIC_SURFACE_ID, "fixture", "fixture-host", () =>
    createResourcesStore({
      scope: { kind: "epic", epicId: EPIC_SURFACE_ID },
      streamClientFactory: (_scope, callbacks) => {
        queueMicrotask(() => {
          callbacks.onSnapshot({
            epicId: EPIC_SURFACE_ID,
            sampledAt,
            app: null,
            owners: [
              {
                owner: {
                  kind: "chat",
                  hostId: "fixture-host",
                  epicId: EPIC_SURFACE_ID,
                  ownerId: FIXTURE_TRACKED_AGENT_ID,
                },
                sampledAt,
                rootPids: [20],
                activeProcessName: "claude",
                processCount: 3,
                cpuPercent: 0.5,
                rssBytes: 472 * 1024 ** 2,
                pssBytes: null,
                privateBytes: null,
                harnessId: "claude",
                managedCommand: null,
                processes: [],
              },
            ],
            epic: null,
            epics: [],
            hostTree: null,
            other: null,
            restricted: null,
          });
        });
        return { close: () => undefined, setDemand: () => undefined };
      },
    }),
  );
}

/**
 * Epsilon's one chat tile, in a one-pane canvas: its body is a HOSTED
 * surface, painted by the real `StableTileSurfaceHost` plane at the rect its
 * real `TileSurfaceSlot` reports, as every chat body is in the app.
 */
const EPIC_SURFACE_CHAT: EpicCanvasTileRef = {
  id: "fixture-epsilon-chat",
  instanceId: "fixture-epsilon-chat",
  type: "chat",
  name: "Plan the migration",
  hostId: "fixture-host",
};

function seedEpicSurfaceCanvas(): void {
  const paneId = "fixture-epsilon-pane";
  useEpicCanvasStore.setState((state) => ({
    canvasByTabId: {
      ...state.canvasByTabId,
      [EPIC_SURFACE_ID]: {
        root: {
          kind: "pane",
          id: paneId,
          tabInstanceIds: [EPIC_SURFACE_CHAT.instanceId],
          activeTabId: EPIC_SURFACE_CHAT.instanceId,
          previewTabId: null,
          activationHistory: [EPIC_SURFACE_CHAT.instanceId],
        },
        activePaneId: paneId,
        tilesByInstanceId: {
          [EPIC_SURFACE_CHAT.instanceId]: EPIC_SURFACE_CHAT,
        },
        sizesByGroupId: {},
      },
    },
  }));
}

/** What the plane paints for the hosted chat: a marked box filling its rect. */
function renderFixtureHostedBody(): ReactNode {
  return (
    <div
      data-fixture-hosted-body
      className="flex h-full w-full items-center justify-center border-2 border-dashed border-info bg-info/10 text-ui-sm"
    >
      Hosted chat body
    </div>
  );
}

/**
 * A task's surface as `EpicSurface` lays it out, through the REAL
 * `EpicSurfaceSheets`: one task sheet, the panel pane on the stored sidebar
 * side, the REAL width handle on the hairline, and the content pane beside it.
 * The panel draws the REAL rail across its top (vertical in the collapsed rail) and the
 * REAL task header; the body below is left out (the real panel needs a live
 * host). The content sheet holds a REAL `TileSurfaceSlot`, and the REAL
 * `StableTileSurfaceHost` plane sits over the surface as `TopLevelTabHost`
 * mounts it, so the hosted chat body is positioned by the shipped geometry
 * coordinator. The live agents list is the real portal, owned here as the
 * epic surface owns it (D9).
 */
function EpicSurfaceStandIn(): ReactNode {
  const sidebarSide = useArrangementValue("sidebarSide");
  const sidebarWidthPx = useSidebarWidthPx();
  const mainCollapsed = useMainPanelCollapsed(EPIC_SURFACE_ID);
  // `CanvasColumn`'s own border (epic-shell.tsx): the epic canvas is the
  // only bordered thing on the flush surface, suppressed on whichever edge
  // already carries the surface frame's own seam line or the status bar's
  // top border. Mirrored here since this stand-in renders `TileSurfaceSlot`
  // directly rather than through the real `EpicShell`.
  const stripEdge = sideTabStripEdge(useArrangementValue("tabStripPlacement"));
  const canvasSeam = stripEdge === sidebarSide ? null : stripEdge;
  const statusBarShown = useStatusBarShown();
  const handle = (
    <SidebarWidthResizeHandle side={sidebarSide} hidden={mainCollapsed} />
  );
  const panel = (
    <div
      data-epic-sidebar-panel
      data-fixture-panel
      className={cn(
        "flex h-full min-h-0 max-w-[50vw] shrink-0 flex-col overflow-hidden bg-background",
        mainCollapsed && "hidden",
      )}
      style={{ width: sidebarWidthPx }}
    >
      {mainCollapsed ? null : (
        <>
          <EpicLeftPanelRail
            epicId={EPIC_SURFACE_ID}
            tabId={EPIC_SURFACE_ID}
            orientation="horizontal"
          />
          <PanelTaskHeader epicId={EPIC_SURFACE_ID} tabId={EPIC_SURFACE_ID} />
          {VARIANT.settings ? <AgentRowReadingsSpecimen /> : null}
        </>
      )}
    </div>
  );
  // `EpicSidebarColumn`'s collapsed rail pane, with its classes: no width of
  // its own, so it is as wide as the real vertical rail inside it (`w-12`,
  // 48px). The panel stays mounted and hidden beside it, as in the app.
  const collapsedRail = mainCollapsed ? (
    <div
      data-fixture-collapsed-rail
      className="shrink-0 overflow-clip bg-background"
    >
      <EpicLeftPanelRail
        epicId={EPIC_SURFACE_ID}
        tabId={EPIC_SURFACE_ID}
        orientation="vertical"
      />
    </div>
  ) : null;
  if (EPIC_SURFACE_SESSION === null) return null;
  return (
    // `TopLevelTabHost`'s own box: the plane's coordinate origin.
    <div className="relative flex min-h-0 min-w-0 flex-1 overflow-clip">
      <EpicSessionContext value={EPIC_SURFACE_SESSION}>
        <StripLiveAgentsPortal
          epicId={EPIC_SURFACE_ID}
          tabId={EPIC_SURFACE_ID}
        />
        <EpicSurfaceSheets
          tabId={EPIC_SURFACE_ID}
          sidebarSide={sidebarSide}
          sidebar={
            // Fragment order as `EpicSidebarColumn` renders it: the handle
            // finds the panel as its sibling on the sidebar's side.
            sidebarSide === "right" ? (
              <>
                {handle}
                {panel}
                {collapsedRail}
              </>
            ) : (
              <>
                {collapsedRail}
                {panel}
                {handle}
              </>
            )
          }
        >
          <div
            data-epic-canvas-frame
            className={cn(
              "min-h-0 flex-1 border border-canvas-border/70 max-md:border-0",
              canvasSeam === "left" && "md:border-s-0",
              canvasSeam === "right" && "md:border-e-0",
              statusBarShown && "md:border-b-0",
            )}
          >
            <TileSurfaceSlot
              node={EPIC_SURFACE_CHAT}
              epicId={EPIC_SURFACE_ID}
              paneId="fixture-epsilon-pane"
              viewTabId={EPIC_SURFACE_ID}
              tabSelected
              canvasPaneActive
            />
          </div>
        </EpicSurfaceSheets>
      </EpicSessionContext>
      <StableTileSurfaceHost renderRecordBody={renderFixtureHostedBody} />
    </div>
  );
}

/**
 * The app column and the editor beside it, exactly as `app-shell.tsx` arranges
 * them: a flex ROW whose first child is the column and whose second is the
 * inspector, so a side dock reflows the app rather than covering it, and the
 * column is never an ancestor of the inspector (C-06). The column is the
 * shell's own `AppColumnFrame`, fed the placement and band kind the way the
 * shell computes them.
 */
export function CanvasFixture(): ReactNode {
  const [column, setColumn] = useState<HTMLDivElement | null>(null);
  const chromeInput = useAppColumnChromeInput();
  const chrome = appColumnChrome(chromeInput);
  const stripEdge = sideTabStripEdge(chromeInput.placement);

  useEffect(() => {
    window.__layoutCanvasProbe = buildProbe();
    return () => {
      window.__layoutCanvasProbe = undefined;
    };
  }, []);

  if (VARIANT.settings && VARIANT.pane === "full")
    return <SettingsFixturePane />;
  return (
    <div className="flex min-h-safe-dvh bg-canvas text-canvas-foreground">
      <RootDndProvider>
        <AppColumnFrame
          columnRef={setColumn}
          {...chrome}
          header={<FixtureHeader />}
          strip={
            stripEdge === null ? null : (
              <SideTabStrip
                edge={stripEdge}
                ownsTitleBar={sideStripOwnsTitleBar(chromeInput)}
              />
            )
          }
          banners={null}
          surface={
            VARIANT.surface === "epic" ? (
              <EpicSurfaceStandIn />
            ) : (
              <SampleRouteSheet />
            )
          }
          mainTail={null}
          tail={VARIANT.settings ? <AppStatusBar /> : null}
        />
      </RootDndProvider>
      {VARIANT.settings ? (
        <SettingsFixturePane />
      ) : (
        <LayoutEditor column={column} />
      )}
    </div>
  );
}

/**
 * Settings ▸ Layout as the modal draws it (G6): compact density, inside the
 * pane the reveal watcher scrolls, with that watcher mounted so a search
 * result's landing is the shipped one. A fixed width because it stands in for
 * the modal's pane, a SIMULATED surface, as the preset miniature is.
 */
function SettingsFixturePane(): ReactNode {
  useSettingsAnchorReveal(VARIANT.panel);
  return (
    <SettingsDensityContext.Provider value="compact">
      <div
        data-settings-panel-pane
        data-fixture-settings-pane
        className={cn(
          "h-safe-dvh shrink-0 overflow-x-hidden overflow-y-auto bg-background text-foreground",
          VARIANT.pane === "full"
            ? "w-full"
            : "w-[36rem] max-w-[50vw] border-l",
        )}
      >
        {VARIANT.panel === "providers" ? (
          <ProvidersSettingsPanel />
        ) : (
          <LayoutSettingsPanel />
        )}
      </div>
    </SettingsDensityContext.Provider>
  );
}

/**
 * One agent row's readings (G7): the REAL chip every agent and terminal row
 * draws, with the metrics the REAL hook resolves from `agentRows`. The row
 * around it is a stand-in, because the real Agents tree needs a live host.
 */
function AgentRowReadingsSpecimen(): ReactNode {
  const metrics = useNavigatorResourceMetrics();
  return (
    <div
      data-fixture-agent-row
      className="flex items-center justify-between gap-2 px-3 py-1.5 text-ui-sm"
    >
      <span className="truncate">Plan the migration</span>
      <NavigatorResourceHotspotChip
        owner={{
          epicId: EPIC_SURFACE_ID,
          kind: "chat",
          ownerId: FIXTURE_TRACKED_AGENT_ID,
          hostId: "fixture-host",
        }}
        metrics={metrics}
        className={undefined}
      />
    </div>
  );
}

/**
 * A signed-in request context for the readings variants (F6), which is what
 * lets a host query run at all: the fixture's AuthService has no session, so
 * every `useHostQuery` stays disabled without one. Set once the runtime has
 * started (it renders nothing before), and before anything under it mounts;
 * the other variants keep their seeded caches and never fetch.
 */
function FixtureRequestContext(props: {
  readonly children: ReactNode;
}): ReactNode {
  const binding = useHostBinding();
  const [ready, setReady] = useState(VARIANT.readings === "none");
  useLayoutEffect(() => {
    if (ready || binding === null) return;
    // The client announces the new context itself ("auth-changed").
    const unsubscribe = binding.hostClient.onChange(() => {
      setReady(true);
    });
    binding.hostClient.setRequestContext(
      createRendererContextFixture({ bearerToken: "fixture" }),
    );
    return unsubscribe;
  }, [binding, ready]);
  return ready ? props.children : null;
}

export function Providers(props: { readonly children: ReactNode }): ReactNode {
  return (
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <HostRuntimeProvider
          registry={hostRpcRegistry}
          messengerFactory={messengerFactory}
          invalidator={null}
          requestId={null}
          remoteFetcher={() =>
            Promise.resolve({
              kind: "hosts",
              entries: VARIANT.hosts ? FIXTURE_REMOTE_HOSTS : [],
            })
          }
          fallback={<div data-fixture-runtime-fallback />}
        >
          <LazyMotion features={domAnimation}>
            <TooltipProvider>
              {/* The app shell's usage poll, which is what fills the usage
                  tile's cache; the readings variants only (F6). */}
              <FixtureRequestContext>
                {VARIANT.readings === "none" ? null : <RateLimitPollProvider />}
                <SampleSceneProvider>{props.children}</SampleSceneProvider>
              </FixtureRequestContext>
            </TooltipProvider>
          </LazyMotion>
        </HostRuntimeProvider>
      </RunnerHostProvider>
    </QueryClientProvider>
  );
}

const fixtureErrors: string[] = [];
window.addEventListener("error", (event) => {
  fixtureErrors.push(
    event.error instanceof Error
      ? (event.error.stack ?? event.message)
      : event.message,
  );
});
window.addEventListener("unhandledrejection", (event) => {
  fixtureErrors.push(
    event.reason instanceof Error
      ? (event.reason.stack ?? event.reason.message)
      : String(event.reason),
  );
});
Reflect.set(window, "__layoutCanvasErrors", fixtureErrors);

/**
 * The variant, applied before the first render so the first frame is already
 * the window under test: the desktop stand-in, the stored placement, the
 * strip's width and collapse, the inspector dock, and the seeded tabs.
 */
function applyVariant(variant: CanvasVariant): void {
  if (variant.wco !== "none") {
    Reflect.set(runnerHost, "menu", {
      platform: variant.wco === "win" ? "win32" : "darwin",
    });
    Reflect.set(window, "runnerHost", runnerHost);
  }
  if (variant.wco === "mac" || variant.wco === "win") {
    document.documentElement.classList.add("wco");
  }
  if (variant.account) {
    useAuthStore.getState().setSignedIn(
      {
        userId: "fixture-user",
        userName: "Ada Lovelace",
        email: "ada@example.com",
        avatarUrl: null,
      },
      { userId: "fixture-user", username: "ada" },
      [],
    );
  }
  resetLayout();
  const strip = useSideTabStripStore.getState();
  strip.resetWidth();
  strip.setCollapsed(variant.collapsed);
  useLayoutEditorStore.getState().setDockMode(variant.dock);
  // A task window has no layout session, so no Customizing tab: Epsilon is
  // the active tab, which is what the join and the Activity view are about.
  seedVariantTabs(variant);
}

applyVariant(VARIANT);

function buildRouter() {
  const rootRoute = createRootRoute({
    component: () => (
      <Providers>
        <CanvasFixture />
      </Providers>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => null,
  });
  // The desktop's own history where the fixture stands in for a desktop
  // (`router.tsx` gives an Electron renderer a persistent memory history,
  // session-scoped here), which is what the strip's back and forward arrows
  // self-gate on; the browser shell's plain history otherwise.
  return createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history:
      VARIANT.wco === "none"
        ? createMemoryHistory({ initialEntries: ["/"] })
        : createPersistentMemoryHistory("/", null),
  });
}

const container = document.getElementById("root");
if (container !== null)
  createRoot(container).render(<RouterProvider router={buildRouter()} />);
