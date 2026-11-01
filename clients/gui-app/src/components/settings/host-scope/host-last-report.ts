import type { HostListItem } from "@traycer/protocol/host/host-status";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import { sandboxReportedAt } from "@/lib/sandboxes/sandbox-row-lines";

/** When the account last heard from a host, or why that cannot be said. */
export type HostLastReport =
  | { readonly kind: "reported"; readonly at: number }
  /** Nothing has been reported. */
  | { readonly kind: "none" }
  /** What was asked did not answer, so "nothing reported" would be a guess. */
  | { readonly kind: "unknown" };

/**
 * The one reading of when the account last heard from a host.
 *
 * A sandbox reads its control-plane row's `lastActivityAt`, the report the
 * Details drawer shows. Its registry row has no such stamp and never will:
 * `status.lastSeenAt` is written by the credential refresh, and a sandbox
 * renews by exchange instead. A sandbox whose row has not answered is
 * `unknown`, not `none`, since the registry's `null` says nothing about it.
 */
export function hostLastReport(
  item: HostListItem | null,
  summary: SandboxSummary | null,
): HostLastReport {
  if (summary !== null) {
    const at = sandboxReportedAt(summary.lastActivityAt);
    return at === null ? { kind: "none" } : { kind: "reported", at };
  }
  if (item?.kind === "sandbox") return { kind: "unknown" };
  const lastSeenAt = item?.status.lastSeenAt ?? null;
  if (lastSeenAt === null) return { kind: "none" };
  const at = Date.parse(lastSeenAt);
  return Number.isNaN(at) ? { kind: "unknown" } : { kind: "reported", at };
}
