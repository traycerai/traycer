/**
 * Mapping one of a simulator's identities to another, for the tile.
 *
 * THE INVARIANT, for every surface and not only this file: a mapping between
 * a tile's `simulatorId`, the host's `instanceKey` and a clone's `cloneOf` is
 * resolved only through a read that names the pair together - this task's
 * `sessions`, the host-wide `simulator.instances`, or the task catalog's
 * records - never through a string equality that holds only where the udid IS
 * the key, never from a read that cannot carry the pair (`simulator.list`'s
 * nested instances have no `simulatorId`), and never by letting a root device
 * of the same name stand in for a clone.
 */
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
 * through whichever read names the pair - the tile's OWN `instanceKey`,
 * recorded from the answer that placed it, then this task's `sessions`, then
 * the host-wide `instances`. The tile's own is the only one of the three
 * that outlives the instance running: both reads drop a clone whose emulator
 * has exited, where the device rows still carry its cold ledger row. It is
 * also the only one that can be STALE, because instance keys are reused by
 * design - so what it buys is that an exited clone's tile is answered with a
 * clone's row and not with its source device's, never that the row is
 * certainly the same copy. Null when the host lists none.
 */
export function findSimulatorForTile(
  simulators: readonly SimulatorSummary[],
  tile: {
    readonly simulatorId: string;
    readonly platform: SimulatorPlatform;
    readonly name: string;
    /** The instance this tile's id was the id of; null for an older tile. */
    readonly instanceKey: string | null;
  },
  sessions: readonly SimulatorSession[],
  /**
   * The host-wide instance read, or null while it is still owed - a `@1.1`
   * host that has not answered it yet. The AVD-name fallback below waits for
   * it: a clone's tile is named after whatever the open named, which for Boot
   * another is the SOURCE DEVICE, so falling back on the name alone would
   * hand that clone its source's row - the one identity a clone must never be
   * resolved to.
   */
  hostInstances: readonly SimulatorHostInstance[] | null,
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
          (item.instanceKey === tile.instanceKey ||
            hostNamesPair(
              sessions,
              hostInstances ?? [],
              tile.simulatorId,
              item.instanceKey,
            ))),
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
  if (tile.platform !== "android" || hostInstances === null) return null;
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

/** One instance as the host's own rows describe it. */
export interface SimulatorInstanceIdentity {
  readonly name: string;
  /** Its device row's: an instance carries no version of its own. */
  readonly version: string;
  readonly drivenByAgent: boolean;
}

/**
 * The host's nested row for one instance, found by the KEY rather than by
 * any tile's id: a clone is listed under no `simulatorId` at all, and on
 * Android its key is not even the same string as the serial its tile
 * carries. The caller holds a read that already named the pair - a live
 * tile's own session - so the key is the whole question here. A root
 * device's own instance is listed beside its clones, so one lookup answers
 * for both. Null when no row carries that key, which is every instance on a
 * `@1.0` host: there are none there, and no clones either.
 */
export function findInstanceForKey(
  simulators: readonly SimulatorSummary[],
  instanceKey: string,
): SimulatorInstanceIdentity | null {
  for (const source of simulators) {
    const instance = source.instances?.find(
      (item) => item.instanceKey === instanceKey,
    );
    if (instance === undefined) continue;
    return {
      name: instance.name,
      version: source.version,
      drivenByAgent: instance.drivenByAgent,
    };
  }
  return null;
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
