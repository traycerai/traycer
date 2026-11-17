// Imports nothing: a package compiled with `noUncheckedIndexedAccess` takes it
// without `item-identity`'s imports.

/** The OS a host runs; `any` is an item row's, never a host's. */
export const HOST_OS_VALUES = ["linux", "macos", "windows"] as const;
export type HostOs = (typeof HOST_OS_VALUES)[number];

/**
 * A host registers `<platform>-<arch>`; a delegated mint and the host's config
 * carry the bare platform. Both read the part before the first `-`.
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
