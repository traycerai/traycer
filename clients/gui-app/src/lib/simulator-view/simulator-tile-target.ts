import type {
  SimulatorPlatform,
  SimulatorSession,
  SimulatorState,
  SimulatorSummary,
} from "@traycer/protocol/host/simulator/schemas";

/**
 * The host's row for a tile's simulator. An iOS udid never changes, so the
 * row is the one with the tile's id. An Android emulator is listed under its
 * serial while it runs and under its AVD name once it has exited (the host
 * lists cold AVDs by name, and a booting AVD takes a serial), so a tile
 * opened on the serial loses its row when the emulator powers off. The AVD
 * name is what both rows share - the host dedups the cold list against the
 * booted one by it - so the serial tile falls back to the row of that name,
 * which is the cold AVD to boot again (or, after a reboot elsewhere, its new
 * serial to connect to).
 *
 * A `@1.1` host lists a clone only under its source's `instances`, never as a
 * device, so a tile on an iOS clone (whose udid is its instance key) finds its
 * row there, with the source's version. Null when the host lists none.
 */
export function findSimulatorForTile(
  simulators: readonly SimulatorSummary[],
  tile: {
    readonly simulatorId: string;
    readonly platform: SimulatorPlatform;
    readonly name: string;
  },
): SimulatorSummary | null {
  const byId = simulators.find(
    (simulator) => simulator.simulatorId === tile.simulatorId,
  );
  if (byId !== undefined) return byId;
  for (const source of simulators) {
    const instance = source.instances?.find(
      (item) => item.instanceKey === tile.simulatorId,
    );
    if (instance === undefined) continue;
    return {
      simulatorId: tile.simulatorId,
      platform: source.platform,
      name: instance.name,
      version: source.version,
      booted: instance.booted,
      physical: false,
    };
  }
  if (tile.platform !== "android") return null;
  return (
    simulators.find(
      (simulator) =>
        simulator.platform === "android" && simulator.name === tile.name,
    ) ?? null
  );
}

/**
 * The session this tile shows. On a `@1.1` host only the viewer's own person
 * session counts: an agent's session on the same instance is the agent's, and
 * the stream admits input only on a session the viewer owns. On a `@1.0` host,
 * which says nothing of owners or agents, any session the task holds.
 */
export function findSessionFor(
  state: SimulatorState | null,
  simulatorId: string,
  v11: boolean,
  viewerUserId: string | null,
): SimulatorSession | null {
  if (state === null) return null;
  return (
    state.sessions.find(
      (item) =>
        item.simulatorId === simulatorId &&
        (!v11 ||
          (item.ownerUserId === viewerUserId &&
            (item.agentId ?? null) === null)),
    ) ?? null
  );
}
