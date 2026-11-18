/**
 * Whether the version-manager panel that STARTED a mutation is still on screen.
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
 * So the surface is chosen by one fact - can the panel that asked still render
 * the answer - and this module is the only place that answers. Registered: that
 * panel draws inline. Not registered: the hook toasts. Exactly one of them,
 * always one of them.
 *
 * WHY IDENTITY AND NOT A COUNT. A count answers "is any panel mounted", which
 * is a different question with the same shape. Settings can mount a second
 * pack's panel while the first pack's RPC is still in flight - open pack B's
 * popover and pack A's panel unmounts under a count that never reaches zero.
 * A's refusal would then be suppressed in favour of a panel that has no row to
 * draw it on and no idea the request happened, and the outcome is silent again
 * - the exact failure this module exists to prevent. Each panel therefore
 * registers its own token, the mutation captures the token that initiated it,
 * and the question asked at delivery is about THAT token.
 */

/**
 * Identity of one mounted panel instance. Compared by object identity; the
 * fields are there so a token reads usefully in a debugger, and are never used
 * to decide anything - two panels for the same pack are two distinct tokens.
 */
export interface VersionManagerPanelToken {
  readonly packId: string;
  readonly instance: number;
}

let nextInstance = 1;
const registeredPanels = new Set<VersionManagerPanelToken>();

/**
 * Mint the identity for one panel instance. Called during render and kept
 * stable for the panel's lifetime, so the token exists before the effect that
 * registers it - a mutation can only be started by a panel the user can see,
 * which is strictly after mount.
 */
export function createVersionManagerPanelToken(
  packId: string,
): VersionManagerPanelToken {
  const token = { packId, instance: nextInstance };
  nextInstance += 1;
  return token;
}

/**
 * Register a mounted panel. Returns the release function, so the caller can use
 * it directly as a `useEffect` cleanup. Releasing twice is a no-op, which keeps
 * React's double-invoked effects in development from unregistering a token that
 * the re-run has already registered again.
 */
export function registerVersionManagerPanel(
  token: VersionManagerPanelToken,
): () => void {
  registeredPanels.add(token);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    registeredPanels.delete(token);
  };
}

/**
 * True while the panel that initiated the mutation can still render its
 * outcome. A `null` token means nothing claimed the outcome - no panel is
 * waiting to draw it, so the hook owns it and must toast.
 */
export function versionManagerPanelIsMounted(
  token: VersionManagerPanelToken | null,
): boolean {
  return token !== null && registeredPanels.has(token);
}

/** Test-only reset, so a leaked registration cannot bleed across cases. */
export function resetVersionManagerPanelPresence(): void {
  registeredPanels.clear();
}
