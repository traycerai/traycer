export const browserMutationKeys = {
  /**
   * Adding is keyed by host alone - the tab it opens has no id until the host answers.
   * `null` is the host-less state a disconnected panel adds from, and it keys separately so a refusal never shares a key with a live host's add.
   */
  openTab: (hostId: string | null) => ["browser.openTab", hostId] as const,
  closeTab: (hostId: string, sessionId: string, tabId: string) =>
    ["browser.closeTab", hostId, sessionId, tabId] as const,
  /**
   * "Save website logins on this machine".
   * Desktop-local rather than host-scoped (decision #18), and there is one switch per machine, so a static key is the whole scope - the same shape `runner.logLevels` and the other machine-local prefs take.
   */
  setSaveLogins: () => ["browser.setSaveLogins"] as const,
  /**
   * "Import logins from another browser".
   * Machine-local like the toggle: the jars it reads and the jar it writes are this desktop's, so a static key is the whole scope.
   */
  importLogins: () => ["browser.importLogins"] as const,
  /** The native file picker for a cookie export; same scope, same reason. */
  pickLoginImportFile: () => ["browser.pickLoginImportFile"] as const,
};

export const browserQueryKeys = {
  /** The read side of {@link browserMutationKeys.setSaveLogins}. */
  saveLogins: (browserView: object | null) =>
    ["browser.saveLogins", browserView] as const,
  /**
   * The browsers and profiles the desktop can import logins from.
   * Same bridge argument, same reasoning as {@link browserQueryKeys.saveLogins}.
   */
  loginImportSources: (browserView: object | null) =>
    ["browser.loginImportSources", browserView] as const,
  /**
   * One source's scan.
   * The source id is minted by the desktop per listing, so a scan can never outlive the listing it came from.
   */
  loginImportScan: (browserView: object | null, sourceId: string | null) =>
    ["browser.loginImportScan", browserView, sourceId] as const,
};
