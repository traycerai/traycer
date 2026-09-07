import type { HostDoctorIssue } from "@traycer/protocol/host/maintenance/index";

/** Everything here is a function of RPC responses plus the scope row, which is the point. */

/** Only an empty draft clears the override. systemName`, and on a provisioned host started with
 * `TRAYCER_HOST_LABEL` the label is not the hostname. */
export function customNameFromIdentityDraft(draft: string): string | null {
  const normalized = draft.trim().replace(/\s+/g, " ");
  return normalized.length === 0 ? null : normalized;
}

/** Why an Overview button cannot do its job right now. Updating the host cannot fix this; installing the CLI
 * can. */
export type OverviewDegradeReason =
  | "unsupported"
  | "cli-unavailable"
  | "externally-managed";

/** `null` - no handshake yet - is not a degrade. */
export function overviewMethodDegrade(
  supported: boolean | null,
): OverviewDegradeReason | null {
  return supported === false ? "unsupported" : null;
}

/** `null` stays "no degrade, no fallback": the tri-state discipline above is unchanged, and the fallback never
 * triggers on ignorance. */
export function resolveOverviewMethodDegrade(
  supported: boolean | null,
  fallbackServes: boolean,
): OverviewDegradeReason | null {
  if (supported !== false) return null;
  return fallbackServes ? null : "unsupported";
}

export function describeOverviewDegrade(
  reason: OverviewDegradeReason,
  hostName: string,
): string {
  switch (reason) {
    case "unsupported":
      return `${hostName} is running a version that doesn't support this yet. Update it and this comes back on its own.`;
    case "cli-unavailable":
      return `${hostName} has no Traycer CLI installed to run this, so it can't be done over the connection.`;
    case "externally-managed":
      // Deliberately offers no alternative inside Traycer, because there is none: this host skips the update
      // reconciler entirely, so neither the version list nor the auto-update switch below reaches it.
      return `${hostName}'s updates are managed outside Traycer. Whatever deploys it decides its version — nothing here will change it.`;
  }
}

/** A 500 means transport, and only transport - so a page that folded these into its error branch would report a
 * broken connection for a host that answered perfectly well. */
export type CliShellFailure =
  | "cli-unavailable"
  | "cli-failed"
  | "invalid-output";

export function describeCliShellFailure(
  failure: CliShellFailure,
  hostName: string,
): string {
  switch (failure) {
    case "cli-unavailable":
      return `${hostName} has no Traycer CLI installed, so it can't run this.`;
    case "cli-failed":
      return `${hostName}'s Traycer CLI couldn't complete the request.`;
    case "invalid-output":
      return `${hostName}'s Traycer CLI answered in a format this app doesn't understand. It's probably a different version than this app expects.`;
  }
}

/** The vantage is the host's call, not this function's, and over a relay the set is empty on purpose - a relay
 * session proves the relay, not the daemon's loopback listener. */
export interface DoctorReportSplit {
  readonly actionable: readonly HostDoctorIssue[];
  readonly disprovenByTransport: readonly HostDoctorIssue[];
}

export function splitDoctorIssuesByVantage(
  issues: readonly HostDoctorIssue[],
  triviallyGreenIssueCodes: readonly string[],
): DoctorReportSplit {
  const triviallyGreen = new Set(triviallyGreenIssueCodes);
  return {
    actionable: issues.filter((issue) => !triviallyGreen.has(issue.code)),
    disprovenByTransport: issues.filter((issue) =>
      triviallyGreen.has(issue.code),
    ),
  };
}

// Nothing consumed the predicate, so the fix is subtraction rather than reconciliation.

// Neither half is actionable from Settings: the pid belongs to a process this page cannot signal except
// through the Restart button already beside it, and the relay origin is infrastructure the account picked.
