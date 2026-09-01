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
  /**
   * The read side of {@link browserMutationKeys.setSaveLogins}.
   *
   * Carries the bridge the answer came from, the same shape the runner-host
   * queries take. It does NOT narrow the scope: `BrowserViewBridge` is
   * method-only, so TanStack's key hash serializes every instance to `{}` and
   * the machine-wide pref stays one entry - which is the whole point, since a
   * window has exactly one bridge for its entire life. Naming it is what makes
   * the read's one input part of the key rather than a value the fetch closes
   * over silently.
   *
   * `null` is the bridge-less shell (web, mobile), whose read never runs. It
   * keys apart so a disabled query can never share an entry with a live one.
   */
  saveLogins: (browserView: object | null) =>
    ["browser.saveLogins", browserView] as const,
};
