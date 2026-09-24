import { isMobileApp } from "@/lib/mobile-app";

/**
 * Eagerly warm the heavy epic route component chunks shortly after startup so
 * the first navigation into an epic doesn't pay the code-split chunk download.
 *
 * With `autoCodeSplitting` enabled, each route's component is a separate chunk,
 * and TanStack awaits `route._componentsPromise` before committing a navigation
 * (see `@tanstack/router-core` `load-matches`). A cold chunk therefore holds
 * the previous screen on screen until it resolves - in the Vite dev server that
 * is a multi-second unbundled-ESM transform waterfall for the whole epic-canvas
 * module graph; in a packaged build it is a one-off prebuilt-chunk fetch on
 * first visit. Importing the source modules at idle primes Vite's module graph
 * (dev) / the browser's module cache (prod) so the router's await resolves
 * effectively instantly when the user actually navigates.
 *
 * This warms the module graph ONLY. It does not run route loaders, so no host
 * RPCs are issued here - it is pure code priming, safe to run during the
 * cold-start RPC storm because `requestIdleCallback` defers it to thread gaps.
 *
 * The mobile app warms the epic surface alone, and only once the first route
 * has rendered: every warmed chunk there is JS a phone downloads, parses and
 * holds whether or not the user goes near it, and it would compete with the
 * first paint. Settings, History and the draft surfaces load on open instead.
 */
let warmed = false;

export interface RouteChunkWarmer {
  /** The warmed module's specifier, as written in `load`. */
  readonly module: string;
  readonly load: () => Promise<unknown>;
}

/** The subset of the router `warmRouteChunks` waits on. */
export interface FirstRenderSignal {
  readonly subscribe: (eventType: "onRendered", fn: () => void) => () => void;
}

// The surface a phone opens all the time: its route adapters, for a deep-link
// navigation's own route chunk, and the lazily-mounted surface itself.
const EPIC_WARMERS: ReadonlyArray<RouteChunkWarmer> = [
  {
    module: "@/routes/epics-layout-route-components",
    load: () => import("@/routes/epics-layout-route-components"),
  },
  {
    module: "@/routes/epic-tab-route-components",
    load: () => import("@/routes/epic-tab-route-components"),
  },
  // The top-level tab host reaches every surface through
  // `tabSurfaceDescriptor(kind).render()`, which returns a `lazy()`
  // component - so NOTHING statically imports these modules and the route
  // adapters above no longer pull them in. Each one must be warmed by name
  // or the first open of that tab kind pays the cold dynamic import behind
  // `Suspense fallback={null}`, i.e. a blank pane. `epic-surface` is the
  // expensive one: it owns `EpicRouteSessionBody` + `EpicSidebarColumn` +
  // `EpicSessionProvider`, which the epic route adapter used to import
  // directly and warm for free. `surface-modules-are-warmed.test.ts` keeps
  // this list in sync with the `lazy()` calls in `stores/tabs/kinds/`.
  {
    module: "@/components/epic-tabs/epic-surface",
    load: () => import("@/components/epic-tabs/epic-surface"),
  },
];

const DESKTOP_ONLY_WARMERS: ReadonlyArray<RouteChunkWarmer> = [
  {
    module: "@/routes/draft-route-components",
    load: () => import("@/routes/draft-route-components"),
  },
  {
    module: "@/components/home-focus/home-focus-view",
    load: () => import("@/components/home-focus/home-focus-view"),
  },
  {
    module: "@/components/home/landing-draft-surface",
    load: () => import("@/components/home/landing-draft-surface"),
  },
  {
    module: "@/providers/draft-surface-provider",
    load: () => import("@/providers/draft-surface-provider"),
  },
  {
    module: "@/components/epics/history-surface",
    load: () => import("@/components/epics/history-surface"),
  },
  {
    module: "@/components/settings/settings-surface",
    load: () => import("@/components/settings/settings-surface"),
  },
  // The Settings / History modal bodies are `lazy()` in
  // `stores/tabs/overlays/`; warming them here is what keeps the desktop
  // modal opening instantly.
  {
    module: "@/components/settings/settings-modal-content",
    load: () => import("@/components/settings/settings-modal-content"),
  },
  {
    module: "@/components/epics/history-modal-content",
    load: () => import("@/components/epics/history-modal-content"),
  },
];

export function routeChunkWarmers(
  mobileApp: boolean,
): ReadonlyArray<RouteChunkWarmer> {
  return mobileApp ? EPIC_WARMERS : [...EPIC_WARMERS, ...DESKTOP_ONLY_WARMERS];
}

export function warmRouteChunks(router: FirstRenderSignal): void {
  if (warmed) return;
  warmed = true;
  if (typeof window === "undefined") return;

  const mobileApp = isMobileApp();
  const warm = () => {
    for (const warmer of routeChunkWarmers(mobileApp)) void warmer.load();
  };

  if (!mobileApp) {
    whenIdle(warm);
    return;
  }
  // `onRendered` fires from a layout effect once the first route commits, so
  // the frame after it is the first paint; idle time after that is free.
  const unsubscribe = router.subscribe("onRendered", () => {
    unsubscribe();
    window.requestAnimationFrame(() => whenIdle(warm));
  });
}

function whenIdle(run: () => void): void {
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(run, { timeout: 2000 });
  } else {
    window.setTimeout(run, 1000);
  }
}
