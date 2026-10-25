import type { DetailsHostStatus } from "@/lib/settings-details-entry";
import type { ConfigurationChipHost } from "@/components/settings/environment/status-chip-model";
import { recoveryForHost } from "@/components/settings/details/details-copy";
import { itemLabel } from "@/components/settings/personal/personal-page-status";
import { chipReportsKind } from "@/components/settings/environment/status-chip-page-kinds";
import type { NegotiatedMethodVersion } from "@/lib/host/read-negotiated-method-version";
import { statusVersionNeedsUpdate } from "@/components/settings/environment/status-chip-hosts";

interface ConfigurationHostReport {
  readonly hostId: string;
  readonly hostLabel: string | null;
  readonly lastReportedAt: number | null;
  readonly applied: readonly {
    /** Canonical kind:key. Colons after the first belong to the item's key. */
    readonly itemKey: string;
    readonly state: "received" | "applied" | "not_applied" | "waiting_resume";
    readonly reason: string | null;
    readonly at: number;
  }[];
}

function reportRows(
  host: ConfigurationHostReport,
  kinds: ReadonlySet<string> | null,
): readonly DetailsHostStatus[] {
  const rows: DetailsHostStatus[] = [];
  for (const item of host.applied) {
    const separator = item.itemKey.indexOf(":");
    if (separator < 1) continue;
    const kind = item.itemKey.slice(0, separator);
    if (!chipReportsKind(kinds, kind)) continue;
    rows.push({
      hostId: host.hostId,
      name: host.hostLabel ?? "your hosts",
      item: itemLabel({ kind, key: item.itemKey.slice(separator + 1) }),
      state: item.state,
      reason: item.reason,
      at: item.at,
      lastReportedAt: host.lastReportedAt,
      recovery: recoveryForHost(item.state, item.reason, host.hostId, kind),
    });
  }
  return rows;
}

/**
 * Whether a host has yet to settle this page: it has never reported, or a
 * page-scoped item is still on its way.
 */
export function poolReportPending(
  host: ConfigurationHostReport,
  kinds: ReadonlySet<string> | null,
): boolean {
  return (
    host.lastReportedAt === null ||
    reportRows(host, kinds).some(
      (row) => row.state === "received" || row.state === "waiting_resume",
    )
  );
}

/** Page-scoped delivery reports, with the server's step and report timestamps. */
export function poolConfigurationChip(
  host: ConfigurationHostReport,
  kinds: ReadonlySet<string> | null,
  version: NegotiatedMethodVersion,
): ConfigurationChipHost {
  const rows = reportRows(host, kinds);
  const problems = rows.filter((row) => row.state !== "applied");
  let state: ConfigurationChipHost["state"] =
    host.lastReportedAt === null ? "applying" : "applied";
  if (problems.some((row) => row.state === "received")) state = "applying";
  if (problems.some((row) => row.state === "waiting_resume"))
    state = "waiting_resume";
  if (problems.some((row) => row.state === "not_applied"))
    state = "not_applied";
  const unsupported = statusVersionNeedsUpdate(version);
  if (unsupported) state = "unsupported";
  const latestAppliedAt = rows.reduce<number | null>(
    (at, row) =>
      row.at !== null && (at === null || row.at > at) ? row.at : at,
    null,
  );
  return {
    hostId: host.hostId,
    name: host.hostLabel ?? "your hosts",
    state,
    lastReportedAt: host.lastReportedAt,
    rows:
      problems.length > 0 && !unsupported
        ? problems
        : [
            {
              hostId: host.hostId,
              name: host.hostLabel ?? "your hosts",
              item: null,
              state: state === "applying" ? "received" : state,
              reason: null,
              at: latestAppliedAt,
              lastReportedAt: host.lastReportedAt,
              recovery: unsupported
                ? { kind: "overview", hostId: host.hostId }
                : null,
            },
          ],
  };
}
