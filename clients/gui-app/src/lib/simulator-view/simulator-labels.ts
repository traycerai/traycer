import type { SimulatorSessionEndReason } from "@traycer/protocol/host/simulator/catalog-contracts";
import type {
  SimulatorPlatform,
  SimulatorSummary,
} from "@traycer/protocol/host/simulator/schemas";

export function simulatorPlatformLabel(platform: SimulatorPlatform): string {
  return platform === "ios" ? "iOS" : "Android";
}

/**
 * The "iOS 18.0" / "Android 15.0" a row shows beside a simulator's name. The
 * host's version strings are not uniform: a booted device's carries the OS
 * name already ("Android 15.0", "iOS 26.5") and a cold Android AVD's is the
 * bare "Android", while a cold iOS simulator's is the number alone. The
 * platform is prefixed only when the version does not already name it, so
 * no row reads "Android Android 15.0".
 */
export function simulatorVersionLabel(
  simulator: Pick<SimulatorSummary, "platform" | "version">,
): string {
  const platform = simulatorPlatformLabel(simulator.platform);
  const version = simulator.version.trim();
  if (version.length === 0) return platform;
  if (version.toLowerCase().startsWith(platform.toLowerCase())) return version;
  return `${platform} ${version}`;
}

/**
 * The countdown an idle instance shows: "Idle · powers off in 7 min", rounded
 * up so the last minute still reads "in 1 min". Null while the instance has
 * no deadline (in use, kept running, or booted outside Traycer).
 *
 * Past the deadline the row stops counting down: the host's tick runs about
 * once a minute, and a label that read "in 1 min" on every refresh made a
 * stuck tick indistinguishable from a healthy one.
 */
export function simulatorIdleCountdownLabel(
  idleUntil: number | null,
  nowMs: number,
): string | null {
  if (idleUntil === null) return null;
  const remainingMs = idleUntil - nowMs;
  if (remainingMs <= 0) return "Idle · powering off";
  return `Idle · powers off in ${Math.ceil(remainingMs / 60_000)} min`;
}

/** Why a closed row's session ended, as its notice says it. */
export function simulatorSessionEndedLabel(
  reason: SimulatorSessionEndReason,
): string {
  switch (reason) {
    case "idle":
      return "Powered off after being idle";
    case "powerOff":
    case "shutdown":
      return "Powered off";
    case "archived":
      return "Ended when its agent was archived";
    case "switchOff":
      return "Ended when mobile simulators were turned off";
    case "cold":
      return "Shut down outside Traycer";
    case "rebooted":
      return "Restarted outside Traycer";
  }
}
