import { posix, win32 } from "node:path";

export interface HostMaintenanceLeaseTarget {
  readonly hostHomeDir: string;
  /**
   * The GUI domain on macOS. Windows has no GUI-uid namespace, so callers
   * carry the stable sentinel zero there; the macOS controller ignores it
   * outside its Darwin scope.
   */
  readonly serviceUid: number;
}

export function parseHostMaintenanceLeaseTarget(
  hostHomeDir: unknown,
  serviceUid: unknown,
): HostMaintenanceLeaseTarget | null {
  if (
    typeof hostHomeDir !== "string" ||
    hostHomeDir.length === 0 ||
    !isHostMaintenanceTargetPath(hostHomeDir, process.platform) ||
    hostHomeDir.includes("\0") ||
    typeof serviceUid !== "string" ||
    !/^[0-9]+$/.test(serviceUid)
  ) {
    return null;
  }
  const parsedUid = Number.parseInt(serviceUid, 10);
  if (!Number.isSafeInteger(parsedUid) || parsedUid < 0) return null;
  return { hostHomeDir, serviceUid: parsedUid };
}

/**
 * The maintenance protocol crosses platform boundaries: Windows package
 * operations legitimately name `C:\\Users\\…\\.traycer\\host`, while a POSIX
 * executor must never accept a relative or drive-shaped path. Keep the
 * validation parameterized so tests can execute both contracts on any host.
 */
export function isHostMaintenanceTargetPath(
  value: string,
  platform: NodeJS.Platform,
): boolean {
  if (value.includes("\0")) return false;
  return platform === "win32"
    ? win32.isAbsolute(value)
    : posix.isAbsolute(value);
}
