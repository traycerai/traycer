import type { HostDoctorIssue } from "@traycer/protocol/host/maintenance/index";

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
  | "unsupported"
  | "cli-unavailable"
  | "externally-managed";

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

/**
 * {@link overviewMethodDegrade} with the local-maintenance fallback folded in:
 * a method the handshake definitively refused (`false`) does NOT degrade when
 * the fallback lane can serve it — the control renders live and the decorated
 * client answers it over the desktop CLI bridge instead.
 *
 * Enablement and routing must read the SAME two inputs or they tear: a button
 * enabled here while the client would still send the RPC dispatches a call the
 * handshake already refused, and the inverse leaves a served method behind a
 * degrade notice. The routing half lives in
 * `lib/host/local-maintenance-fallback-client.ts`, whose serve condition is
 * exactly `supported === false && fallbackServes`.
 *
 * `null` stays "no degrade, no fallback": the tri-state discipline above is
 * unchanged, and the fallback never triggers on ignorance — a call in flight
 * while support is unknown goes over real RPC and resolves the handshake.
 */
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
      // Deliberately offers no alternative inside Traycer, because there is
      // none: this host skips the update reconciler entirely, so neither the
      // version list nor the auto-update switch below reaches it. An earlier
      // wording sent people to a version pin that this page no longer has.
      return `${hostName}'s updates are managed outside Traycer. Whatever deploys it decides its version — nothing here will change it.`;
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

// `overviewEndpointParts` and `relayOrigin` lived here and are gone with the
// meta row they fed (`via relay.dev.traycer.ai · 1 active session`).
//
// That row was the page's ONE deliberate local/remote difference — loopback URL
// and pid for this computer, relay origin for a remote host — and it is the
// difference that stopped earning its place. Neither half is actionable from
// Settings: the pid belongs to a process this page cannot signal except through
// the Restart button already beside it, and the relay origin is infrastructure
// the account picked. What the row carried that anyone acts on is whether the
// host is busy, which now renders as a chip on the identity line from
// `host.status.busyBreakdown` (falling back to `busySessionCount` on a @1.1
// host) via `describeHostBusy` — no viewer/tile count, ever.
//
// The local snapshot (`LocalHostSnapshot`) was this module's only reason to
// know about a host's locality at all, so the Overview no longer takes it.
