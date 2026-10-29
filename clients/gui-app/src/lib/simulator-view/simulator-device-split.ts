/**
 * Splitting a machine's devices into what is running and what can be booted,
 * for every surface that draws those two sections.
 *
 * THE INVARIANT, for every such surface and not only this file: BOTH sections
 * come out of ONE verdict per device, and that verdict is the LATER-TAKEN of
 * the two answers in hand. So the sections are a partition - every device is
 * in exactly one of them - and neither can contradict the other.
 *
 * Two answers, because a device's `booted` flag and the host's instances are
 * separate reads. `simulator.instances` polls while a surface is on screen,
 * where a device list neither polls nor follows a boot or a power off this
 * client did not send (an agent's, another window's, an idle deadline's). But
 * "polls" is not "fresher": a device list asked again after an open answers
 * AFTER the instance read's last poll, and TanStack serves the previous
 * answer while a read is in flight, so either read can be the stale one.
 * Which is why the verdict is by timestamp and not by read.
 *
 * What the halves do with the verdict:
 *
 * - A device that is running is listed by its own instance row when the
 *   instance read names one, and otherwise by a STAND-IN carrying the
 *   device's own id - which is what a `@1.0` host's section is made of
 *   entirely, since it has no instances. The stand-in is what keeps the
 *   sections total: without it a device the device list calls booted and the
 *   instance read has not caught up with is in NEITHER section, which is
 *   where this rule comes from.
 * - A root instance row is dropped when the device list, as the later answer,
 *   says its device is down. A clone's row never is: a clone is never a
 *   device row, so the device list cannot speak for it - nor can it for a
 *   copy of a device it does not list at all.
 * - A device that is not running is a Boot row, unless it is a physical phone,
 *   which is never booted from here.
 *
 * A device's OWN copy is what decides its row. A clone is not its source: a
 * device can be cold and bootable while a copy of it runs.
 *
 * MEMBERSHIP in the instance read is the test, never a row's own `booted`
 * field, so that a row the running section lists cannot also be a Boot row.
 *
 * `instances: null` is no instance read to go on, which is UNKNOWN and not
 * "nothing is running": a `@1.0` host, which has none, or a `@1.1` one that
 * still owes or failed its answer. The device list's flag then decides alone.
 */
import type {
  SimulatorHostInstance,
  SimulatorSummary,
} from "@traycer/protocol/host/simulator/schemas";

/**
 * Which of the two answers in hand was taken later, and so decides the
 * devices they disagree about. A surface holding the two reads separately
 * compares their `dataUpdatedAt`; one that takes them in a single fetch knows
 * by construction which it awaited second.
 */
export type FresherSimulatorRead = "devices" | "instances";

/** One copy a running section lists. */
export type SimulatorRunningCopy =
  /** An instance the host named, with its holders and its idle deadline. */
  | { readonly kind: "instance"; readonly instance: SimulatorHostInstance }
  /** A device the deciding answer calls booted and no instance row names. */
  | { readonly kind: "device"; readonly device: SimulatorSummary };

export interface SimulatorDeviceSplit {
  readonly running: readonly SimulatorRunningCopy[];
  /** The devices a surface offers Boot on. */
  readonly cold: readonly SimulatorSummary[];
}

function standIn(device: SimulatorSummary): SimulatorRunningCopy {
  return { kind: "device", device };
}

/**
 * Every id the instance read reaches a device's OWN copy by. Two, because a
 * device row's id is not always its instance's key: an iOS udid is both for
 * life, where an Android device is listed under its AVD name while it is cold
 * (which is its instance key) and under the serial its emulator took while it
 * runs (which is the instance's `simulatorId`). Reading the key alone would
 * call every booted Android device cold and offer Boot on an emulator that is
 * already up.
 */
function ownCopyIds(
  instances: readonly SimulatorHostInstance[],
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const instance of instances) {
    if (instance.cloneOf !== null) continue;
    ids.add(instance.instanceKey);
    ids.add(instance.simulatorId);
  }
  return ids;
}

/** The two sections of a machine's devices, per the invariant above. */
export function splitSimulatorDevices(args: {
  readonly simulators: readonly SimulatorSummary[];
  readonly instances: readonly SimulatorHostInstance[] | null;
  readonly fresher: FresherSimulatorRead;
}): SimulatorDeviceSplit {
  const { simulators, instances, fresher } = args;
  if (instances === null)
    return {
      running: simulators
        .filter((device) => device.booted)
        .map((device) => standIn(device)),
      cold: simulators.filter((device) => !device.booted && !device.physical),
    };
  const ownCopies = ownCopyIds(instances);
  const devices = new Map(
    simulators.map((device) => [device.simulatorId, device] as const),
  );
  const isRunning = (device: SimulatorSummary): boolean =>
    fresher === "instances" ? ownCopies.has(device.simulatorId) : device.booted;
  const deviceOf = (instance: SimulatorHostInstance): SimulatorSummary | null =>
    devices.get(instance.instanceKey) ??
    devices.get(instance.simulatorId) ??
    null;
  const running: SimulatorRunningCopy[] = [];
  for (const instance of instances) {
    const device = instance.cloneOf === null ? deviceOf(instance) : null;
    if (device === null || isRunning(device))
      running.push({ kind: "instance", instance });
  }
  for (const device of simulators) {
    if (isRunning(device) && !ownCopies.has(device.simulatorId))
      running.push(standIn(device));
  }
  return {
    running,
    cold: simulators.filter((device) => !device.physical && !isRunning(device)),
  };
}

/**
 * Which answer a surface holding the two reads SEPARATELY should decide by.
 * `dataUpdatedAt` is when each answer was taken, on one clock, and a read in
 * flight still reports its previous answer's - which is the whole point: a
 * refetch does not make an answer current.
 */
export function fresherSimulatorRead(args: {
  readonly devicesUpdatedAt: number;
  readonly instancesUpdatedAt: number;
}): FresherSimulatorRead {
  return args.instancesUpdatedAt >= args.devicesUpdatedAt
    ? "instances"
    : "devices";
}
