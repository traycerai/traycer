/**
 * Eagerly warm the heavy epic route component chunks shortly after startup so the first navigation into an epic doesn't pay the code-split chunk download.
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
    // The top-level tab host reaches every surface through `tabSurfaceDescriptor(kind).render()`, which returns a `lazy()` component - so NOTHING statically imports these modules and the route adapters above no longer pull them in.
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
