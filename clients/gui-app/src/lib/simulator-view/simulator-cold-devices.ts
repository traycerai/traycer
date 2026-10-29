/**
 * Which of a machine's devices are cold, for the surfaces that split its
 * device list into a running section and a Boot section.
 *
 * THE INVARIANT, for every such surface and not only this file: BOTH sections
 * are driven by the same read, and that read is the freshest one in hand.
 * `simulator.instances` is it whenever a `@1.1` host has answered it - it
 * polls while the surface is on screen - where a device list neither polls
 * nor follows a boot or a power off this client did not send (an agent's,
 * another window's, an idle deadline's), so its own `booted` flag can be a
 * minute old or older. A surface that moved its running section onto the
 * instance read and left its cold section on the flag has no rule at all: a
 * device that powers off leaves the running section on the next poll and
 * never enters the cold one, so it is in NEITHER and cannot be booted.
 *
 * So, with an instance read in hand, a device is cold iff that read lists no
 * copy of its own, and the flag decides only while the read is owed. The two
 * sections then partition the device list - every row is in exactly one of
 * them - on both paths: against the read, or against the flag.
 *
 * A device's own copy is what counts. A clone is not its source: a device can
 * be cold and bootable while a copy of it runs, which is why a clone's row is
 * passed over here. The host keeps clones out of the device list too - on
 * `@1.1` a clone is only ever a row under its source's `instances` - so this
 * holds the rule in the keys rather than leaning on that listing policy.
 *
 * MEMBERSHIP in the read is the test, not the row's own `booted` field, so
 * that the running section - which lists every row the read carries - and
 * this one cannot disagree about a device and show it twice.
 *
 * Null is no instance read to go on, which is UNKNOWN and not "nothing is
 * running": a `@1.0` host, which has no instances, or a `@1.1` one that still
 * owes or failed its answer. Taking a device off either section needs a read
 * that answered, so while the answer is owed the device list's own flag
 * decides alone.
 */
import type {
  SimulatorHostInstance,
  SimulatorSummary,
} from "@traycer/protocol/host/simulator/schemas";

/**
 * Every id the instance read reaches a device's OWN copy by. Two, because a
 * device row's id is not always its instance's key: an iOS udid is both for
 * life, where an Android device is listed under its AVD name while it is cold
 * (which is its instance key) and under the serial its emulator took while it
 * runs (which is the instance's `simulatorId`). Joining on the key alone
 * would call every booted Android device cold and offer Boot on an emulator
 * that is already up.
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

/**
 * The devices a surface offers Boot on: the machine's rows, minus the
 * physical phones, minus every device whose own copy is running - as the
 * freshest read in hand says, per the invariant above.
 */
export function coldSimulatorDevices(args: {
  readonly simulators: readonly SimulatorSummary[];
  readonly instances: readonly SimulatorHostInstance[] | null;
}): readonly SimulatorSummary[] {
  const { simulators, instances } = args;
  const running = instances === null ? null : ownCopyIds(instances);
  return simulators.filter(
    (simulator) =>
      !simulator.physical &&
      !(running === null
        ? simulator.booted
        : running.has(simulator.simulatorId)),
  );
}
