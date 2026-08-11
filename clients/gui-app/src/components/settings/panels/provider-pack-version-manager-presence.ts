/**
 * Whether the version-manager panel is on screen right now.
 *
 * WHY THIS EXISTS. The panel lives inside an unforced Radix popover, so closing
 * the version menu unmounts it, and TanStack drops every callback passed to
 * `mutate` along with the observer. Thrown transport failures already survive
 * that, because they toast from the hooks. Typed refusals (`ok: false`) and
 * success confirmations do not: both arrive on the SUCCESS path, and both were
 * handled per call. Close the menu while an RPC is in flight and the outcome
 * was delivered to a component that no longer existed.
 *
 * Moving them into the hooks fixes the lifetime but creates a second problem:
 * the panel renders a refusal INLINE, anchored to the row or the header the
 * refusal is about, which is strictly better context than a toast whenever the
 * user is still looking at it. Two owners would either both fire or both stay
 * silent.
 *
 * So the surface is chosen by one fact - is the panel there to render it - and
 * this module is the only place that answers. Mounted: the panel renders
 * inline. Not mounted: the hook toasts. Exactly one of them, always one of
 * them.
 *
 * Ref-counted rather than a boolean because settings can mount the panel for a
 * second pack before the first has finished unmounting; a boolean would report
 * "gone" while a panel is still on screen.
 */
let mountedPanels = 0;

/**
 * Register a mounted panel. Returns the release function, so the caller can use
 * it directly as a `useEffect` cleanup. Releasing twice is a no-op, which keeps
 * React's double-invoked effects in development from driving the count
 * negative.
 */
export function registerVersionManagerPanel(): () => void {
  mountedPanels += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    mountedPanels -= 1;
  };
}

/** True while at least one version-manager panel can render an outcome. */
export function versionManagerPanelIsMounted(): boolean {
  return mountedPanels > 0;
}

/** Test-only reset, so a leaked registration cannot bleed across cases. */
export function resetVersionManagerPanelPresence(): void {
  mountedPanels = 0;
}
