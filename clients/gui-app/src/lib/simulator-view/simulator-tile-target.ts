import type {
  SimulatorPlatform,
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
 * serial to connect to). Null when the host lists neither.
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
  if (tile.platform !== "android") return null;
  return (
    simulators.find(
      (simulator) =>
        simulator.platform === "android" && simulator.name === tile.name,
    ) ?? null
  );
}
