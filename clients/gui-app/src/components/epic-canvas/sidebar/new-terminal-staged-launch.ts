/**
 * A staged sandbox's terminal launched from the tab-level handoff
 * (`NewTerminalStagedHandoff`), told to the picker shells of that tab that
 * hold their open state themselves: the phone's dialog closes as it does on
 * its own Launch.
 */
const listeners = new Map<string, Set<() => void>>();

export function notifyStagedTerminalLaunch(tabId: string): void {
  for (const listener of listeners.get(tabId) ?? []) listener();
}

export function subscribeStagedTerminalLaunch(
  tabId: string,
  listener: () => void,
): () => void {
  const forTab = listeners.get(tabId) ?? new Set();
  forTab.add(listener);
  listeners.set(tabId, forTab);
  return () => {
    forTab.delete(listener);
    if (forTab.size === 0) listeners.delete(tabId);
  };
}
