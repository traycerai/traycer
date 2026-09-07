/** Moving them into the hooks fixes the lifetime but creates a second problem. */

/** Identity of one mounted panel instance. */
export interface VersionManagerPanelToken {
  readonly packId: string;
  readonly instance: number;
}

let nextInstance = 1;
const registeredPanels = new Set<VersionManagerPanelToken>();

/** Called during render and kept stable for the panel's lifetime, so the token exists before the effect that
 * registers it - a mutation can only be started by a panel the user can see, which is strictly after mount. */
export function createVersionManagerPanelToken(
  packId: string,
): VersionManagerPanelToken {
  const token = { packId, instance: nextInstance };
  nextInstance += 1;
  return token;
}

/** Releasing twice is a no-op, which keeps React's double-invoked effects in development from unregistering a
 * token that the re-run has already registered again. */
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

/** True while the panel that initiated the mutation can still render its outcome. A `null` token means nothing
 * claimed the outcome - no panel is waiting to draw it, so the hook owns it and must toast. */
export function versionManagerPanelIsMounted(
  token: VersionManagerPanelToken | null,
): boolean {
  return token !== null && registeredPanels.has(token);
}

/** Test-only reset, so a leaked registration cannot bleed across cases. */
export function resetVersionManagerPanelPresence(): void {
  registeredPanels.clear();
}
