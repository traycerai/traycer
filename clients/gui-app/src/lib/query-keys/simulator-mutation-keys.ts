/**
 * Write keys for the host's simulator domain (`simulator.*` and the
 * `config.simulator.set` switch). Every key names the host the write goes to:
 * two tiles on two machines must never share a pending state, and the
 * sidebar reads "a boot is outstanding on this host" off the mutation cache.
 */
export const simulatorMutationKeys = {
  /** Boot (or attach to) one simulator. Keyed per simulator so one row spins. */
  open: (hostId: string, simulatorId: string) =>
    ["simulator.open", hostId, simulatorId] as const,
  close: (hostId: string, simulatorId: string) =>
    ["simulator.close", hostId, simulatorId] as const,
  shutdown: (hostId: string, simulatorId: string) =>
    ["simulator.shutdown", hostId, simulatorId] as const,
  screenshot: (hostId: string, simulatorId: string) =>
    ["simulator.screenshot", hostId, simulatorId] as const,
  action: (hostId: string, simulatorId: string) =>
    ["simulator.action", hostId, simulatorId] as const,
  /** The machine-user-global switches; one pair per host. */
  configSet: (hostId: string) => ["config.simulator.set", hostId] as const,
  /** Remove the downloaded tools from one host's store. */
  removeTools: (hostId: string) => ["simulator.removeTools", hostId] as const,
};
