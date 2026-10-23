import type { DetailsRecovery } from "@/lib/settings-details-entry";

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function detailsTime(at: number | null): string {
  return at === null ? "unknown" : DATE_FORMAT.format(at);
}

export function detailsRecoveryLabel(
  recovery: DetailsRecovery,
  name: string,
): string {
  switch (recovery.kind) {
    case "repair":
      return `Repair on ${name}`;
    case "install":
      return `Install on ${name}`;
    case "retry":
      return "Retry";
    case "overview":
      return `Update ${name}`;
  }
}

export function recoveryForHost(
  state: string,
  reason: string | null,
  hostId: string,
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
  return { kind: "retry", hostId };
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
