import type {
  SimulatorHostInstance,
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
 * device, so a tile on a clone finds its row there, with the source's
 * version. An iOS clone's instance key IS the udid its tile carries; an
 * Android instance is keyed by its AVD name while its tile carries the serial
 * its emulator runs on, two different strings, so that clone is resolved
 * through whichever read names the pair - this task's `sessions`, or the
 * host-wide `instances`. Null when the host lists none.
 */
export function findSimulatorForTile(
  simulators: readonly SimulatorSummary[],
  tile: {
    readonly simulatorId: string;
    readonly platform: SimulatorPlatform;
    readonly name: string;
  },
  sessions: readonly SimulatorSession[],
  hostInstances: readonly SimulatorHostInstance[],
): SimulatorSummary | null {
  const byId = simulators.find(
    (simulator) => simulator.simulatorId === tile.simulatorId,
  );
  if (byId !== undefined) return byId;
  for (const source of simulators) {
    const instance = source.instances?.find(
      (item) =>
        item.instanceKey === tile.simulatorId ||
        (item.cloneOf !== null &&
          hostNamesPair(
            sessions,
            hostInstances,
            tile.simulatorId,
            item.instanceKey,
          )),
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
 * Whether the host names both of these together: one `simulatorId` and the
 * instance it is the id of. That pair is what ties an Android clone's
 * AVD-name key to the serial its tile holds, and two `@1.1` reads carry it.
 *
 * A session carries it, and every session counts - an agent's and another
 * person's alike - because this is the host's own mapping rather than a hold
 * on the instance. But a clone outlives its sessions: one booted by Traycer
 * stays up until its idle deadline, or indefinitely while kept running, so
 * the last session ending anywhere would otherwise take the mapping with it
 * and leave the tile with nothing to reconnect to. The host-wide instance
 * read answers the same question without one, naming the id each booted
 * instance is reached by now beside its key, so it is consulted as well. It
 * is a polled read where sessions are pushed, which is why both are here.
 *
 * Only a CLONE is resolved through either: a root device names an AVD name in
 * both reads too, and that device has a row of its own, cold under that name
 * once its emulator has exited, which is the row to boot again.
 */
function hostNamesPair(
  sessions: readonly SimulatorSession[],
  hostInstances: readonly SimulatorHostInstance[],
  simulatorId: string,
  instanceKey: string,
): boolean {
  return (
    sessions.some(
      (session) =>
        session.simulatorId === simulatorId &&
        session.instanceKey === instanceKey,
    ) ||
    hostInstances.some(
      (instance) =>
        instance.simulatorId === simulatorId &&
        instance.instanceKey === instanceKey,
    )
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
