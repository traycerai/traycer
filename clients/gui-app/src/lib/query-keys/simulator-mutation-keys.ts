/**
 * Write keys for the host's simulator domain (`simulator.*` and the
 * `config.simulator.set` switch). Every key names the host the write goes to:
 * two tiles on two machines must never share a pending state.
 */
export const simulatorMutationKeys = {
  /**
   * Boot (or attach to) a simulator. Keyed by host alone: which simulator is
   * booting is the host's own `booting` list, which every window reads.
   */
  open: (hostId: string) => ["simulator.open", hostId] as const,
  /**
   * The person's Boot, Boot another and Watch from a list of instances. Keyed
   * by task: each open is told apart by its own `requestId`.
   */
  instanceOpen: (epicId: string) =>
    ["simulator.open", "instance", epicId] as const,
  close: (hostId: string, simulatorId: string) =>
    ["simulator.close", hostId, simulatorId] as const,
  shutdown: (hostId: string, simulatorId: string) =>
    ["simulator.shutdown", hostId, simulatorId] as const,
  screenshot: (hostId: string, simulatorId: string) =>
    ["simulator.screenshot", hostId, simulatorId] as const,
  action: (hostId: string, simulatorId: string) =>
    ["simulator.action", hostId, simulatorId] as const,
  /** A task row's Close or Dismiss: one or more `close@1.1` by session id. */
  catalogClose: (epicId: string) =>
    ["simulator.close", "catalog", epicId] as const,
  powerOff: (hostId: string, instanceKey: string) =>
    ["simulator.powerOff", hostId, instanceKey] as const,
  setKeepRunning: (hostId: string, instanceKey: string) =>
    ["simulator.setKeepRunning", hostId, instanceKey] as const,
  /** The machine-user-global switch; one value per host. */
  configSet: (hostId: string) => ["config.simulator.set", hostId] as const,
  /** Remove the downloaded tools from one host's store. */
  removeTools: (hostId: string) => ["simulator.removeTools", hostId] as const,
};
