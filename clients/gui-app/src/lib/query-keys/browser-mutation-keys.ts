export const browserMutationKeys = {
  /**
   * Adding is keyed by host alone - the tab it opens has no id until the host
   * answers. `null` is the host-less state a disconnected panel adds from, and
   * it keys separately so a refusal never shares a key with a live host's add.
   */
  openTab: (hostId: string | null) => ["browser.openTab", hostId] as const,
  /**
   * The serializing scope every open on one device shares.
   *
   * A `mutationKey` groups cached state and defaults; it does NOT serialize
   * the mutation functions that carry it. Two openers reach this device - the
   * chooser's and the popup queue's - and each re-checks the tab cap against
   * the device's published count, so run in parallel they both read the count
   * from BEFORE either opened and the pair can land one tab over the cap.
   * TanStack's mutation cache runs same-`scope.id` mutations one at a time,
   * pausing the later one and continuing it when the first settles, which is
   * what makes the second re-check read a count that includes the first.
   *
   * Keyed by device, so opens on two devices still run in parallel.
   */
  openTabScope: (hostId: string | null) =>
    `browser.openTab:${hostId ?? "none"}`,
  closeTab: (hostId: string, sessionId: string, tabId: string) =>
    ["browser.closeTab", hostId, sessionId, tabId] as const,
  /**
   * "Save website logins on this machine". Desktop-local rather than
   * host-scoped (decision #18), and there is one switch per machine, so a
   * static key is the whole scope - the same shape `runner.logLevels` and the
   * other machine-local prefs take.
   */
  setSaveLogins: () => ["browser.setSaveLogins"] as const,
  /**
   * "Import logins from another browser". Machine-local like the toggle: the
   * jars it reads and the jar it writes are this desktop's, so a static key
   * is the whole scope.
   */
  importLogins: () => ["browser.importLogins"] as const,
  /** The native file picker for a cookie export; same scope, same reason. */
  pickLoginImportFile: () => ["browser.pickLoginImportFile"] as const,
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
  /**
   * The browsers and profiles the desktop can import logins from. Same bridge
   * argument, same reasoning as {@link browserQueryKeys.saveLogins}.
   */
  loginImportSources: (browserView: object | null) =>
    ["browser.loginImportSources", browserView] as const,
  /**
   * One source's scan. The source id is minted by the desktop per listing, so
   * a scan can never outlive the listing it came from.
   */
  loginImportScan: (browserView: object | null, sourceId: string | null) =>
    ["browser.loginImportScan", browserView, sourceId] as const,
};
