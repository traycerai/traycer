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
    // The epic-canvas graph spans two split routes: the `/epics` layout
    // (EpicTabHost -> EpicSessionProvider -> EpicRouteSessionBody) and the
    // detail route (EpicRoute -> EpicShell -> TileCanvas/DnD/sidebar). Warming
    // both source modules covers the bulk of the cost; the thin per-route split
    // wrappers the router imports later re-use these already-warm deps.
    void import("@/routes/epics-layout-route-components");
    void import("@/routes/epic-tab-route-components");
    void import("@/routes/draft-route-components");
  };

  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(warm, { timeout: 2000 });
  } else {
    window.setTimeout(warm, 1000);
  }
}
