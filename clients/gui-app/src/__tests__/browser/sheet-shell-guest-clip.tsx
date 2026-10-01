import { useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
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
import { AppColumnFrame } from "@/components/layout/app-column-frame";
import { AppHeader } from "@/components/layout/header/app-header";
import {
  appColumnChrome,
  type AppColumnChrome,
  type AppColumnChromeInput,
} from "@/components/layout/header/app-title-band-kind";
import {
  browserGuestCssAnchorName,
  browserGuestCssClipAnchorName,
  browserGuestCssSheetAnchorName,
  setBrowserGuestTilePlacement,
  startPersistentBrowserGuestHost,
  type BrowserGuestTilePlacement,
} from "@/lib/browser-view/guest/persistent-browser-guest-host";
import { FakeBrowserViewBridge } from "@/lib/browser-view/__tests__/fake-browser-view-bridge";
import {
  HostRuntimeProvider,
  hostRpcRegistry,
  type HostRpcRegistry,
  type MessengerFactory,
} from "@/lib/host";
import type { TabStripPlacement } from "@/lib/layout/layout-arrangement";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import "@/lib/theme-applier";
import "@/index.css";

/**
 * Real Chrome, real CSS anchor positioning (`anchor()`/`anchor-size()`,
 * `position-anchor`) and a real `clip-path: … round …` computed value - none
 * of which jsdom can evaluate, which is why `persistent-browser-guest-host`'s
 * own suite only asserts the DECLARED CSS text, not what it resolves to.
 *
 * Two guests, each bound to its OWN content sheet (`tab-a` / `tab-b`) inside
 * a REAL `AppColumnFrame`, so `md:task-surface-frame*`, `md:bg-shell-ground`
 * and the `[data-shell-sheet]` radius/border rules are exactly what ships.
 *
 * `?placement=top|left|right` picks the frame's placement (default `top`).
 * `?wco=none|mac|mac-fullscreen` stands in for the preload the way
 * `layout-editor-canvas.tsx` models it: `window.runnerHost` carries
 * `menu.platform: "darwin"` so `isFramelessDesktop()` and
 * `resolveDesktopPlatform` answer as on that desktop, and `.wco` goes on
 * `<html>` for `mac` only (macOS drops the overlay in fullscreen). The real
 * `appColumnChrome()` then decides the title band from placement + platform,
 * exactly as the shell does - `left` under `mac` owns the title bar itself
 * (no band), `right` draws one. `?band=1` forces a band even on `left`,
 * the one combination `none|mac|mac-fullscreen` alone cannot reach (that
 * needs a Windows/Linux platform this fixture does not model), so corner
 * coverage with a band on both sides doesn't wait on adding `wco=win`.
 *
 * `top`'s header is the REAL `AppHeader`, wrapped in the same minimal
 * Query/Router/RunnerHost/HostRuntime stack `layout-editor-canvas.tsx` and
 * `side-tab-strip-overlay-placement.test.tsx` use to render real host-bound
 * chrome: signed-out, so it renders `DesktopAppHeader` with an empty tab
 * strip and a `SignInButton`, but with its own bottom hairline
 * (`after:…bg-border/90`) intact - the fixture never restates that class
 * string, so a screenshot proves the real header/ground boundary rather than
 * a copy of it.
 *
 * NOT proven here: real Electron `<webview>` guest-page painting. A plain
 * browser tab never runs the Chromium `<webview>` guest process, so the
 * element below is a plain filled box standing in for it - what this fixture
 * verifies is the DOM geometry/clip a real guest would inherit, not that a
 * real guest paints inside it.
 *
 * `window.__sheetShellGuestClipProbe.ready` gates all of it.
 */

interface GuestConfig {
  readonly registrationId: string;
  readonly instanceId: string;
  readonly paneId: string;
  readonly partition: string;
}

const GUEST_A: GuestConfig = {
  registrationId: "sheet-clip-guest-a",
  instanceId: "sheet-clip-tile-a",
  paneId: "pane-a",
  partition: "persist:sheet-clip-a",
};
const GUEST_B: GuestConfig = {
  registrationId: "sheet-clip-guest-b",
  instanceId: "sheet-clip-tile-b",
  paneId: "pane-b",
  partition: "persist:sheet-clip-b",
};
const GUESTS: readonly GuestConfig[] = [GUEST_A, GUEST_B];
const DEFAULT_TAB_ID: Readonly<Record<string, string>> = {
  [GUEST_A.registrationId]: "tab-a",
  [GUEST_B.registrationId]: "tab-b",
};
const WRAPPER_ATTRIBUTE = "data-browser-guest-registration";

type Corner = "tl" | "tr" | "bl" | "br";

interface Rect {
  readonly top: number;
  readonly left: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

interface SheetShellGuestClipProbe {
  readonly ready: boolean;
  readonly registrations: readonly string[];
  readonly errors: () => string[];
  /** Sizes the guest's own stage to fill its sheet edge-to-edge, then presents it there. */
  readonly presentFlush: (registrationId: string, tabId: string) => void;
  /** Sizes the guest's stage well inside its sheet (never touching a corner), then presents it. */
  readonly presentInset: (
    registrationId: string,
    tabId: string,
    insetPx: number,
  ) => void;
  /** Re-presents the SAME registration on a DIFFERENT sheet, stage untouched - proves the anchor re-targets live, with no resize. */
  readonly moveToTab: (registrationId: string, tabId: string) => void;
  readonly retain: (registrationId: string) => void;
  /** Re-presents at the last tab/stage this registration had. */
  readonly present: (registrationId: string) => void;
  readonly sheetMarker: (registrationId: string) => string | undefined;
  readonly computedClipPath: (registrationId: string) => string;
  readonly rects: (
    registrationId: string,
  ) => { sheet: Rect; sheetClipper: Rect; wrapper: Rect } | null;
  /** Whether `document.elementFromPoint` at that sheet corner (inset by probePx from both edges) still hits the guest. */
  readonly cornerHitsGuest: (
    registrationId: string,
    corner: Corner,
    probePx: number,
  ) => boolean;
}

declare global {
  interface Window {
    __sheetShellGuestClipProbe?: SheetShellGuestClipProbe;
  }
}

/** The fixture's desktop stand-in: which window chrome `wco` simulates. */
type FixtureWindowChrome = "none" | "mac" | "mac-fullscreen";

function readPlacement(): TabStripPlacement {
  const value = new URLSearchParams(window.location.search).get("placement");
  return value === "left" || value === "right" ? value : "top";
}

function readWindowChrome(): FixtureWindowChrome {
  const value = new URLSearchParams(window.location.search).get("wco");
  return value === "mac" || value === "mac-fullscreen" ? value : "none";
}

function readForceBand(): boolean {
  return new URLSearchParams(window.location.search).get("band") === "1";
}

const PLACEMENT = readPlacement();
const WCO = readWindowChrome();
const FORCE_BAND = readForceBand();

const CHROME_INPUT: AppColumnChromeInput = {
  placement: PLACEMENT,
  platform: WCO === "none" ? null : "darwin",
  frameless: WCO !== "none",
};
const NATURAL_CHROME = appColumnChrome(CHROME_INPUT);
const CHROME: AppColumnChrome =
  FORCE_BAND && NATURAL_CHROME.placement !== "top"
    ? { placement: NATURAL_CHROME.placement, titleBand: "band" }
    : NATURAL_CHROME;

const runnerHost = new MockRunnerHost({
  signInUrl: "http://127.0.0.1:9/sign-in",
  authnBaseUrl: "http://127.0.0.1:9",
  localHost: null,
  hosts: [],
  workspaceFolderPickerPaths: undefined,
  hasLocalHost: undefined,
  traycerCli: undefined,
});

if (WCO !== "none") {
  Reflect.set(runnerHost, "menu", { platform: "darwin" });
  Reflect.set(window, "runnerHost", runnerHost);
}
if (WCO === "mac") {
  document.documentElement.classList.add("wco");
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});

let requestCounter = 0;

/**
 * Answers the three calls the app-wide runtime makes on startup, the same
 * set `layout-editor-canvas.tsx` registers - nothing here resolves a live
 * host, so the header renders signed-out chrome only.
 */
const messengerFactory: MessengerFactory<HostRpcRegistry> = ({ registry }) =>
  new MockHostMessenger<HostRpcRegistry>({
    registry,
    requestId: () => `sheet-shell-guest-clip-${String(++requestCounter)}`,
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

function Providers(props: { readonly children: ReactNode }): ReactNode {
  return (
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <HostRuntimeProvider
          registry={hostRpcRegistry}
          messengerFactory={messengerFactory}
          invalidator={null}
          requestId={null}
          remoteFetcher={() => Promise.resolve({ kind: "hosts", entries: [] })}
          fallback={<div data-fixture-runtime-fallback />}
        >
          <LazyMotion features={domAnimation}>
            <TooltipProvider>{props.children}</TooltipProvider>
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

const owner = Symbol("sheet-shell-guest-clip-fixture");
const lastTabIdByRegistration: Record<string, string> = { ...DEFAULT_TAB_ID };

function configFor(registrationId: string): GuestConfig {
  const config = GUESTS.find(
    (entry) => entry.registrationId === registrationId,
  );
  if (config === undefined) throw new Error(`unknown guest: ${registrationId}`);
  return config;
}

function placement(
  config: GuestConfig,
  tabId: string,
  presented: boolean,
): BrowserGuestTilePlacement {
  return {
    registrationId: config.registrationId,
    instanceId: config.instanceId,
    viewTabId: tabId,
    paneId: config.paneId,
    presented,
    viewport: null,
  };
}

function presentGuest(registrationId: string, tabId: string): void {
  lastTabIdByRegistration[registrationId] = tabId;
  setBrowserGuestTilePlacement(
    owner,
    placement(configFor(registrationId), tabId, true),
  );
}

function retainGuest(registrationId: string): void {
  const tabId = lastTabIdByRegistration[registrationId];
  setBrowserGuestTilePlacement(
    owner,
    placement(configFor(registrationId), tabId, false),
  );
}

function stageElement(registrationId: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(
    `[data-fixture-stage="${registrationId}"]`,
  );
  if (el === null) throw new Error(`no stage for ${registrationId}`);
  return el;
}

function wrapperElement(registrationId: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(
    `[${WRAPPER_ATTRIBUTE}="${registrationId}"]`,
  );
  if (el === null) throw new Error(`no guest wrapper for ${registrationId}`);
  return el;
}

/** wrapper -> clipper (tile stage clip) -> sheetClipper (D2 sheet-corner clip) -> host. */
function sheetClipperElement(registrationId: string): HTMLElement {
  const clipper = wrapperElement(registrationId).parentElement;
  const sheetClipper = clipper?.parentElement ?? null;
  if (sheetClipper === null) {
    throw new Error(`no sheet clipper for ${registrationId}`);
  }
  return sheetClipper;
}

function toRect(domRect: DOMRect): Rect {
  return {
    top: domRect.top,
    left: domRect.left,
    right: domRect.right,
    bottom: domRect.bottom,
    width: domRect.width,
    height: domRect.height,
  };
}

function cornerPoint(
  rect: DOMRect,
  corner: Corner,
  inset: number,
): readonly [number, number] {
  const x =
    corner === "tl" || corner === "bl" ? rect.left + inset : rect.right - inset;
  const y =
    corner === "tl" || corner === "tr" ? rect.top + inset : rect.bottom - inset;
  return [x, y];
}

function buildProbe(): SheetShellGuestClipProbe {
  return {
    ready: true,
    registrations: GUESTS.map((config) => config.registrationId),
    errors: () => [...fixtureErrors],
    presentFlush: (registrationId, tabId) => {
      stageElement(registrationId).style.inset = "0px";
      presentGuest(registrationId, tabId);
    },
    presentInset: (registrationId, tabId, insetPx) => {
      stageElement(registrationId).style.inset = `${insetPx}px`;
      presentGuest(registrationId, tabId);
    },
    moveToTab: (registrationId, tabId) => {
      presentGuest(registrationId, tabId);
    },
    retain: retainGuest,
    present: (registrationId) => {
      presentGuest(registrationId, lastTabIdByRegistration[registrationId]);
    },
    sheetMarker: (registrationId) =>
      sheetClipperElement(registrationId).dataset.browserGuestSheet,
    computedClipPath: (registrationId) =>
      getComputedStyle(sheetClipperElement(registrationId)).clipPath,
    rects: (registrationId) => {
      const tabId = lastTabIdByRegistration[registrationId];
      const sheet = document.querySelector<HTMLElement>(
        `[data-fixture-sheet="${tabId}"]`,
      );
      if (sheet === null) return null;
      return {
        sheet: toRect(sheet.getBoundingClientRect()),
        sheetClipper: toRect(
          sheetClipperElement(registrationId).getBoundingClientRect(),
        ),
        wrapper: toRect(wrapperElement(registrationId).getBoundingClientRect()),
      };
    },
    cornerHitsGuest: (registrationId, corner, probePx) => {
      const rect = sheetClipperElement(registrationId).getBoundingClientRect();
      const [x, y] = cornerPoint(rect, corner, probePx);
      const hit = document.elementFromPoint(x, y);
      return hit !== null && wrapperElement(registrationId).contains(hit);
    },
  };
}

export function Stage(props: { readonly registrationId: string }): ReactNode {
  return (
    <div
      data-fixture-stage={props.registrationId}
      className="absolute inset-0"
    />
  );
}

export function Sheet(props: {
  readonly tabId: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div
      data-shell-sheet="task"
      data-fixture-sheet={props.tabId}
      style={{ anchorName: browserGuestCssSheetAnchorName(props.tabId) }}
      className="relative min-h-0 min-w-0 flex-1 bg-canvas"
    >
      {props.children}
    </div>
  );
}

export function Fixture(): ReactNode {
  useEffect(() => {
    const bridge = new FakeBrowserViewBridge({});
    const dispose = startPersistentBrowserGuestHost(bridge, {
      pointerDown: () => undefined,
      focus: () => undefined,
    });
    for (const config of GUESTS) {
      bridge.emitGuestMountRequested({
        registrationId: config.registrationId,
        partition: config.partition,
      });
      // One placeholder element is both the tile's own stage (its clip
      // boundary) and its position/size source - the real app keeps these
      // separate (`usePublishBrowserGuestTile`), collapsed here because this
      // fixture verifies the OUTER sheet clip, not the inner tile-stage clip
      // (already covered by `use-publish-browser-guest-tile.test.tsx`).
      stageElement(config.registrationId).style.setProperty(
        "anchor-name",
        `${browserGuestCssAnchorName(config.registrationId)}, ${browserGuestCssClipAnchorName(config.registrationId)}`,
      );
      presentGuest(
        config.registrationId,
        lastTabIdByRegistration[config.registrationId],
      );
    }

    window.__sheetShellGuestClipProbe = buildProbe();
    return () => {
      dispose();
      window.__sheetShellGuestClipProbe = undefined;
    };
  }, []);

  return (
    <AppColumnFrame
      {...CHROME}
      columnRef={() => undefined}
      header={<AppHeader variant="app" />}
      strip={<nav data-fixture-strip className="w-10 shrink-0 bg-canvas" />}
      banners={<div />}
      surface={
        <div className="flex h-full min-h-0 w-full flex-row md:gap-(--shell-gap)">
          <Sheet tabId="tab-a">
            <Stage registrationId={GUEST_A.registrationId} />
          </Sheet>
          <Sheet tabId="tab-b">
            <Stage registrationId={GUEST_B.registrationId} />
          </Sheet>
        </div>
      }
      mainTail={null}
      tail={null}
    />
  );
}

const style = document.createElement("style");
// `<webview>` paints nothing in a plain browser tab (no Electron guest
// process); these fills are the ONLY thing making the corner clip visible to
// a screenshot or `elementFromPoint`.
style.textContent = `
  [${WRAPPER_ATTRIBUTE}="${GUEST_A.registrationId}"] webview { background: oklch(0.6 0.2 260 / 70%); }
  [${WRAPPER_ATTRIBUTE}="${GUEST_B.registrationId}"] webview { background: oklch(0.7 0.2 50 / 70%); }
`;
document.head.appendChild(style);

/**
 * `AppHeader` reads `useRouter()`/`useNavigate()` (`TabStrip`,
 * `HistoryNavButtons`, `HistoryButton`), so it has to mount inside a real
 * router - a bare memory history with no epic routes, the same shape
 * `layout-editor-canvas.tsx` gives its own top-placement variants.
 */
function buildRouter() {
  const rootRoute = createRootRoute({
    component: () => (
      <Providers>
        <Fixture />
      </Providers>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => null,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
}

const container = document.getElementById("root");
if (container !== null)
  createRoot(container).render(<RouterProvider router={buildRouter()} />);
