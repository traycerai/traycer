import type { EnvironmentOs } from "@traycer/protocol/host/environment-schemas";

export type HostEnvironmentOs = Exclude<EnvironmentOs, "any">;

/**
 * The OS axis a host's registry platform falls on. The registry reports a
 * Node platform triple such as `darwin-arm64`; only its first segment names the
 * OS. `null` for a host that reported none, or one on a platform the
 * configuration has no axis for.
 */
export function hostEnvironmentOs(
  platform: string | null,
): HostEnvironmentOs | null {
  switch (platform?.split("-")[0]) {
    case "darwin":
      return "macos";
    case "linux":
      return "linux";
    case "win32":
      return "windows";
    default:
      return null;
  }
}

/**
 * Whether a setting's saved value is what the host is expected to run, so a
 * live value that differs from it is a difference worth showing.
 *
 * A universal setting (`any`, or a row with no OS axis) applies to every host,
 * unless the same item has a row for this host's OS, which the host runs
 * instead. A setting for one OS applies only to a host on that OS. When the
 * host's OS is unknown, an OS-specific setting is never claimed, and a
 * universal one is claimed only if no sibling row could be the one the host
 * runs.
 *
 * `siblings` are the OS axes of every stored row of the same item.
 */
export function comparesWithHost(input: {
  readonly rowOs: EnvironmentOs | null;
  readonly hostOs: HostEnvironmentOs | null;
  readonly siblings: readonly (EnvironmentOs | null)[];
}): boolean {
  const { rowOs, hostOs, siblings } = input;
  if (rowOs !== null && rowOs !== "any") return rowOs === hostOs;
  return !siblings.some((os) =>
    hostOs === null ? os !== null && os !== "any" : os === hostOs,
  );
}
