import type { DataRootPlatform } from "@traycer/protocol/config/data-root";

/**
 * Which data-location operations this build offers, per platform.
 *
 * A static product constant, not configuration: no environment variable, flag
 * or file can turn an operation on. An operation flips to `true` only when its
 * platform qualification (issue 718, ticket 8: packaged two-volume Windows runs
 * of the native process census, the private-folder ACLs and the full engine)
 * has passed for this build. Until then `data init` and starting `data migrate`
 * refuse before writing anything. Windows passed it (Server 2025, a fixed
 * local NTFS second volume); macOS and Linux have not been qualified.
 *
 * Read-only and recovery operations are never gated: `data status` and
 * `data migrate --dry-run` change nothing, and `data recover` / `data cleanup`
 * act only on a migration that already exists, which must always stay
 * recoverable.
 *
 * Tests pass their own value through the command dependencies instead.
 */
export type DataRootAvailability = {
  readonly [platform in DataRootPlatform]: {
    /** `data init`: choose the data folder for a new installation. */
    readonly init: boolean;
    /** `data migrate` without `--dry-run`: start moving an existing installation. */
    readonly migrate: boolean;
  };
};

export const DATA_ROOT_AVAILABILITY: DataRootAvailability = {
  win32: { init: true, migrate: true },
  posix: { init: false, migrate: false },
};

export type DataRootOperation = "init" | "migrate";

export function dataRootOperationAvailable(
  availability: DataRootAvailability,
  platform: DataRootPlatform,
  operation: DataRootOperation,
): boolean {
  return availability[platform][operation];
}

export function unavailableMessage(operation: DataRootOperation): string {
  return operation === "init"
    ? "Choosing a data folder for a new installation is not available in this Traycer version yet. Nothing was changed."
    : "Moving Traycer's data to another folder is not available in this Traycer version yet. Nothing was changed; `traycer data migrate --dry-run` still shows what a move would involve.";
}
