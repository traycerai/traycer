import type {
  EnvironmentItemStatus,
  EnvironmentStatusResponse,
} from "@traycer/protocol/host/environment-schemas";
import type { NegotiatedMethodVersion } from "@/lib/host/read-negotiated-method-version";
import type { DetailsHostStatus } from "@/lib/settings-details-entry";
import type { ConfigurationChipHost } from "@/components/settings/environment/status-chip-model";
import { itemLabel } from "@/components/settings/personal/personal-page-status";

interface ChipHostIdentity {
  readonly hostId: string;
  readonly name: string;
}

export function statusVersionNeedsUpdate(
  version: NegotiatedMethodVersion,
): boolean {
  if (version === null) return false;
  if (version === false) return true;
  return version.major < 1 || (version.major === 1 && version.minor < 1);
}

function itemRow(
  host: ChipHostIdentity,
  item: EnvironmentItemStatus,
  lastReportedAt: number | null,
): DetailsHostStatus {
  let state = "received";
  let reason: string | null = null;
  let recovery: DetailsHostStatus["recovery"] = null;
  if (item.status === "applied") state = "applied";
  if (item.status === "failed") {
    state = "not_applied";
    // Retry reruns the setup script; the host re-applies any other item itself.
    if (item.kind === "setup_script")
      recovery = { kind: "retry", hostId: host.hostId };
    const { code } = item;
    if (code === "not_installed") {
      reason = "Not installed on this host";
      recovery = { kind: "install", hostId: host.hostId };
    } else if (code === "permission_denied" || code === "native_write_failed") {
      reason = "Couldn't write this setting";
      recovery = { kind: "repair", hostId: host.hostId };
    } else {
      reason = "Couldn't apply this setting";
    }
  }
  if (item.status === "unsupported") {
    if (item.minimumHostVersion === null) {
      state = "not_applied";
      reason = "This setting isn't supported here";
    } else {
      state = "unsupported";
      recovery = { kind: "overview", hostId: host.hostId };
    }
  }
  return {
    hostId: host.hostId,
    name: host.name,
    item: itemLabel(item),
    state,
    reason,
    // environment.status has no per-step time. Never substitute report time.
    at: null,
    lastReportedAt,
    recovery,
  };
}

/** The host's own evidence; a report timestamp is separate from a step's time. */
export function hostConfigurationChip(input: {
  readonly host: ChipHostIdentity;
  readonly status: EnvironmentStatusResponse | null;
  readonly version: NegotiatedMethodVersion;
  readonly kinds: ReadonlySet<string> | null;
  readonly lastReportedAt: number | null;
}): ConfigurationChipHost {
  const { host, status, version, kinds, lastReportedAt } = input;
  const unsupported = statusVersionNeedsUpdate(version);
  const items =
    status?.items.filter((item) => kinds === null || kinds.has(item.kind)) ??
    [];
  const problems = items
    .filter((item) => item.status !== "applied")
    .map((item) => itemRow(host, item, lastReportedAt));
  let state: ConfigurationChipHost["state"] = "applied";
  if (
    status === null ||
    status.reachability !== "connected" ||
    status.desiredRevision !== status.appliedRevision ||
    problems.some((row) => row.state === "received")
  )
    state = "applying";
  if (problems.some((row) => row.state === "not_applied"))
    state = "not_applied";
  if (unsupported || problems.some((row) => row.state === "unsupported"))
    state = "unsupported";
  const rows: readonly DetailsHostStatus[] =
    problems.length > 0 && !unsupported
      ? problems
      : [
          {
            hostId: host.hostId,
            name: host.name,
            item: null,
            state: state === "applying" ? "received" : state,
            reason: null,
            at: null,
            lastReportedAt,
            recovery: unsupported
              ? { kind: "overview", hostId: host.hostId }
              : null,
          },
        ];
  return { hostId: host.hostId, name: host.name, state, lastReportedAt, rows };
}
