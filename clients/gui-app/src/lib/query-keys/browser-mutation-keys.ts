export const browserMutationKeys = {
  /**
   * Adding is keyed by host alone - the tab it opens has no id until the host
   * answers. `null` is the host-less state a disconnected panel adds from, and
   * it keys separately so a refusal never shares a key with a live host's add.
   */
  openTab: (hostId: string | null) => ["browser.openTab", hostId] as const,
  closeTab: (hostId: string, sessionId: string, tabId: string) =>
    ["browser.closeTab", hostId, sessionId, tabId] as const,
  /**
   * "Save website logins on this machine". Desktop-local rather than
   * host-scoped (decision #18), and there is one switch per machine, so a
   * static key is the whole scope - the same shape `runner.logLevels` and the
   * other machine-local prefs take.
   */
  setSaveLogins: () => ["browser.setSaveLogins"] as const,
};

export const browserQueryKeys = {
  /** The read side of {@link browserMutationKeys.setSaveLogins}. */
  saveLogins: () => ["browser.saveLogins"] as const,
};
