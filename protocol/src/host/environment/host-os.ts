/**
 * The operating system a host runs, as an environment item's per-OS rows name
 * it. Imports nothing: a package that compiles with `noUncheckedIndexedAccess`
 * takes it without `item-identity`'s imports, which that setting rejects.
 * `item-identity` re-exports it.
 */

/** The OS a host runs; `any` is an item row's, never a host's. */
export const HOST_OS_VALUES = ["linux", "macos", "windows"] as const;
export type HostOs = (typeof HOST_OS_VALUES)[number];

/**
 * `Host.platform` as a host OS; null for a platform no per-OS row names. A
 * host registers `<process.platform>-<arch>` (`darwin-arm64`); a client's
 * delegated mint and the host's own config carry the bare
 * `process.platform`. Both read by the part before the first `-`. The one
 * mapping authn's per-OS write rule and the binding verdict both read.
 */
export function hostOsOfPlatform(platform: string | null): HostOs | null {
  switch (platform?.split("-", 1)[0]) {
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
