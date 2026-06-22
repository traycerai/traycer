export type DesktopAppUpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "error"
  | "up-to-date"
  | "unavailable";

export type DesktopAppUpdateCheckIntent = "automatic" | "manual";

export interface DesktopAppUpdateSnapshot {
  readonly sequence: number;
  readonly status: DesktopAppUpdateStatus;
  readonly currentVersion: string;
  readonly latestVersion: string | null;
  // Whole-percent download progress (0-100) while `status` is "downloading";
  // null in every other state (including before a user-initiated download).
  readonly downloadProgress: number | null;
  readonly errorMessage: string | null;
  readonly lastCheckedAt: string | null;
  readonly lastCheckIntent: DesktopAppUpdateCheckIntent | null;
}
