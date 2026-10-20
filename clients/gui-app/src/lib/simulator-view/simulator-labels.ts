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
