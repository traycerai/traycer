/**
 * Write keys for the machine-user-global config store over host RPC
 * (`config.*`). The store is the same file `traycer config …` writes, so these
 * mutations are the RPC twin of the `runner.traycer.*` bridge keys — kept in
 * their own namespace so a queued CLI write and a queued RPC write are never
 * mistaken for one another when the stopped-local fallback is in play.
 */
export const configMutationKeys = {
  shellSet: () => ["config.shell.set"] as const,
  shellReset: () => ["config.shell.reset"] as const,
  shellAdd: () => ["config.shell.add"] as const,
  shellRemove: () => ["config.shell.remove"] as const,
  shellRevertArgs: () => ["config.shell.revertArgs"] as const,
  envSet: () => ["config.env.set"] as const,
  envDelete: () => ["config.env.delete"] as const,
  // A rename is ONE operation, not a set the panel follows with a delete.
  // Chained through a per-`mutate` callback it split at the unmount boundary:
  // TanStack drops those callbacks when the observer goes, so closing Settings
  // (or switching host) between the two left the new key written and the old
  // one still live - a rename silently becoming two active variables.
  envRename: () => ["config.env.rename"] as const,
  logLevelsSet: () => ["config.logLevels.set"] as const,
};
