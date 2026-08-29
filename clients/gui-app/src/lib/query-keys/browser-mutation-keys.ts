export const browserMutationKeys = {
  /**
   * Adding is keyed by host alone - the tab it opens has no id until the host
   * answers. `null` is the host-less state a disconnected panel adds from, and
   * it keys separately so a refusal never shares a key with a live host's add.
   */
  openTab: (hostId: string | null) => ["browser.openTab", hostId] as const,
  closeTab: (hostId: string, sessionId: string, tabId: string) =>
    ["browser.closeTab", hostId, sessionId, tabId] as const,
};
