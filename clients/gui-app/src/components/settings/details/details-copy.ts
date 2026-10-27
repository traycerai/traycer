import { formatSettingsDate } from "@/lib/settings/settings-date";
import type { DetailsRecovery } from "@/lib/settings-details-entry";

/** A time the app has. One it does not have is left out, never "unknown". */
export function detailsTime(at: number): string {
  return formatSettingsDate(at, true);
}

export function detailsRecoveryLabel(
  recovery: DetailsRecovery,
  name: string,
): string {
  switch (recovery.kind) {
    case "repair":
      return `Open ${name}`;
    case "apply":
      return "Retry applying";
    case "install":
      return `Install on ${name}`;
    case "retry":
      return "Retry";
    case "overview":
      return `Update ${name}`;
  }
}

/**
 * Retry reruns the setup script, so only a failed setup script offers it.
 * The host re-applies any other item itself; its row shows the reason alone.
 */
export function recoveryForHost(
  state: string,
  reason: string | null,
  hostId: string,
  itemKind: string | null,
): DetailsRecovery | null {
  if (state === "unsupported") return { kind: "overview", hostId };
  if (state !== "not_applied" && state !== "failed") return null;
  if (
    reason !== null &&
    /not_installed|not installed|isn't installed/i.test(reason)
  )
    return { kind: "install", hostId };
  if (
    reason?.includes("permission") === true ||
    reason?.includes("write") === true
  )
    return { kind: "repair", hostId };
  return itemKind === "setup_script" ? { kind: "retry", hostId } : null;
}

export function removalLabel(
  outcome: "revoked" | "cleanup_requested" | "destroyed",
): string {
  switch (outcome) {
    case "revoked":
      return "Access revoked";
    case "cleanup_requested":
      return "Cleanup requested";
    case "destroyed":
      return "Destroyed";
  }
}
