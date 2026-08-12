import type { HostDoctorIssue } from "@traycer/protocol/host/maintenance/index";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import type { LocalHostSnapshot } from "@traycer-clients/shared/platform/runner-host";

/**
 * Pure helpers for the one Overview page local and remote hosts share.
 *
 * Everything here is a function of RPC responses plus the scope row, which is
 * the point: the page renders the SAME components for both kinds of host, so
 * anything that would otherwise become a `isLocalMachine ?` branch in JSX is
 * pulled out to where a test can pin both answers against one input.
 */

/**
 * The RPC path's draft rule.
 *
 * Only an EMPTY draft clears the override. The bridge rule (`customNameFromDraft`)
 * also treats "typed the machine's own name" as a clear, and that quietly stops
 * being true once the host owns the name: the host computes
 * `effectiveName = customName ?? hostLabel ?? systemName`, and on a provisioned
 * host started with `TRAYCER_HOST_LABEL` the label is NOT the hostname. Clearing
 * there would land on the label — so someone who typed the machine name would
 * watch a different name appear, having asked for the one they typed.
 *
 * Storing it as a real override instead is honest and costs nothing: the
 * displayed name is what was typed either way, and Reset stays available to get
 * back to the host's own default.
 */
export function customNameFromIdentityDraft(draft: string): string | null {
  const normalized = draft.trim().replace(/\s+/g, " ");
  return normalized.length === 0 ? null : normalized;
}

/**
 * Why an Overview button cannot do its job right now.
 *
 * Kept as a union rather than a boolean because the three reasons call for
 * different words and different remedies, and collapsing them is how "update
 * this host" ended up shown to someone whose host was perfectly current but had
 * no CLI to shell:
 *
 *   - `unsupported`         — the host handshaked WITHOUT the method: it predates
 *     it. Self-heals on update, so the copy says so.
 *   - `cli-unavailable`     — the host is current and answered, but has no local
 *     Traycer CLI to shell out to (a tree-run or hand-unpacked host). Updating
 *     the host cannot fix this; installing the CLI can.
 *   - `externally-managed`  — updates are driven from outside this host entirely
 *     (the `TRAYCER_HOST_UPDATES=external` kill switch). Not a failure at all:
 *     the cloud pin is the supported control, so the UI degrades to it.
 */
export type OverviewDegradeReason =
  "unsupported" | "cli-unavailable" | "externally-managed";

/**
 * Resolve a per-button capability from the tri-state method answer.
 *
 * `null` — no handshake yet — is NOT a degrade. The page's own first RPC is
 * what produces a handshake, so treating "not yet known" as "absent" would
 * disable the button that would have proved it present, permanently, on a host
 * that supports everything. This is the same tri-state discipline the Shell and
 * Diagnostics pages settled on; `useHostCapabilityProbe` is the counterweight
 * for the `false` case.
 */
export function overviewMethodDegrade(
  supported: boolean | null,
): OverviewDegradeReason | null {
  return supported === false ? "unsupported" : null;
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
      return `${hostName}'s updates are managed outside Traycer. Use the version pin below to say what it should run.`;
  }
}

/**
 * The non-transport failure arms every CLI-shelling method shares.
 *
 * These are RESULTS, not errors: the call succeeded and the host is telling us
 * what happened when it tried to shell its CLI. A 500 means transport, and only
 * transport — so a page that folded these into its error branch would report a
 * broken connection for a host that answered perfectly well.
 */
export type CliShellFailure =
  "cli-unavailable" | "cli-failed" | "invalid-output";

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

/**
 * Split a doctor report by what the CONNECTION already proves.
 *
 * The host reports which issue codes its own transport vantage makes trivially
 * green, and the split is the whole reason the report is trustworthy over RPC:
 * a doctor run reached over a live local WebSocket that reports `SERVICE_STOPPED`
 * is describing a service that just answered us. Presenting that as an issue
 * would send someone to fix a host that is demonstrably running.
 *
 * The vantage is the host's call, not this function's, and over a relay the set
 * is EMPTY on purpose — a relay session proves the relay, not the daemon's
 * loopback listener. So the same code that is filtered out for a local host
 * stays a real, actionable issue for a remote one, which is exactly right.
 */
export interface DoctorReportSplit {
  /** What the person should act on. Drives the count and the fix buttons. */
  readonly actionable: readonly HostDoctorIssue[];
  /** Reported by the CLI, disproved by the connection that carried the report. */
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

// `LOCAL_ONLY_FIX_ACTIONS` / `isLocalOnlyFixAction` lived here and are gone.
//
// They named the inverse of `doctorFixRoute`'s RPC set while importing
// nothing from it, so the two partitions drifted independently - and had
// already drifted: the set still listed a bare `free-port-and-restart` that
// `runFixAction` does not handle, and its doc said "three" over four entries.
// Nothing consumed the predicate, so the fix is subtraction rather than
// reconciliation. `doctorFixRoute` in `host-doctor-actions.ts` is the single
// source of truth for which mechanism can carry out a fix.

/**
 * One meta line, sourced honestly per host kind.
 *
 * Deliberately carries NO version: the identity line above owns that, and
 * printing it in both places is how the card ended up showing two different
 * numbers when one came from the RPC and the other from the registry row.
 *
 * Local keeps exactly what it always showed — the loopback endpoint and pid,
 * which only the live local snapshot knows. A remote host has neither: there is
 * no loopback URL to print and its pid is a number on another machine that
 * nothing here could act on. What it has instead is where the route goes and
 * what the host says about its own sessions, so that is what it shows. Reading
 * a local pid file for a remote host would have been the one genuinely wrong
 * answer available.
 */
export function overviewEndpointParts(input: {
  readonly host: HostScopeOption;
  readonly busySessionCount: number | null;
  /** This computer's live host process. Always `null` for a remote row. */
  readonly localHost: LocalHostSnapshot | null;
}): readonly string[] {
  const { host, busySessionCount, localHost } = input;
  const parts: string[] = [];

  if (host.isLocalMachine) {
    // A live snapshot exists only while the process is up, and it carries both
    // fields non-null when it does — so the presence of the snapshot IS the
    // condition, and there is nothing further to check.
    if (localHost !== null) {
      parts.push(localHost.websocketUrl, `pid ${localHost.pid}`);
    }
  } else {
    const relay = relayOrigin(host.entry?.websocketUrl ?? null);
    if (relay !== null) parts.push(`via ${relay}`);
  }

  if (busySessionCount !== null && busySessionCount > 0) {
    parts.push(
      `${busySessionCount} active session${busySessionCount === 1 ? "" : "s"}`,
    );
  }
  return parts;
}

/**
 * The relay's ORIGIN, never its full URL.
 *
 * The path carries the rendezvous id — an opaque routing key that changes hands
 * with the registry row. It is not a bearer, but it is also not something a
 * person reads or needs, and printing routing keys into a support-copyable line
 * is a habit worth not starting. The origin answers the only question the line
 * is asked: which relay is this going through.
 */
function relayOrigin(websocketUrl: string | null): string | null {
  if (websocketUrl === null || websocketUrl.length === 0) return null;
  try {
    return new URL(websocketUrl).host;
  } catch {
    return null;
  }
}
