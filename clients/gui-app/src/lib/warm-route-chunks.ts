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
 */
let warmed = false;

export function warmRouteChunks(): void {
  if (warmed) return;
  warmed = true;
  if (typeof window === "undefined") return;

  const warm = () => {
    // Route adapters, for a deep-link navigation's own route chunk.
    void import("@/routes/epics-layout-route-components");
    void import("@/routes/epic-tab-route-components");
    void import("@/routes/draft-route-components");
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
    void import("@/components/epic-tabs/epic-surface");
    void import("@/components/home/landing-draft-surface");
    void import("@/providers/draft-surface-provider");
    void import("@/components/epics/history-surface");
    void import("@/components/settings/settings-surface");
  };

  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(warm, { timeout: 2000 });
  } else {
    window.setTimeout(warm, 1000);
  }
}
