import type { TraycerDiagnosticsConfigSnapshot } from "@traycer-clients/shared/platform/runner-host";

/**
 * Whether the running host has applied the configured host diagnostic level.
 *
 * Shared by the Settings row (description copy) and the diagnostics config
 * query (poll-until-applied) so both agree on what "applied" means. The host
 * confirms application by matching `appliedConfigMtimeMs` to the on-disk
 * `configMtimeMs`. When the host cannot stat the config file
 * (`configMtimeMs === null`) there is no mtime to compare, so we fall back to
 * the host's effective level already matching the desired level - the
 * strongest available signal - rather than reporting "waiting" forever.
 */
export function isHostDiagnosticsApplied(
  snapshot: TraycerDiagnosticsConfigSnapshot,
): boolean {
  const status = snapshot.hostStatus;
  if (!status.supported || status.restartRequired) return false;
  if (status.effectiveLevel !== snapshot.effective.host.level) return false;
  if (status.configMtimeMs === null) return true;
  return status.appliedConfigMtimeMs === status.configMtimeMs;
}
