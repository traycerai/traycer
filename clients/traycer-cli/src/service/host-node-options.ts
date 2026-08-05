// Single source of truth for the V8 flags the long-running host process must
// be created with. Applied at the host's creation time, where it is honored:
//   - `host-start.ts` appends it to the spawned host's NODE_OPTIONS. This is
//     the ONE cross-platform launch path (launchd, systemd-user, and the Windows
//     Scheduled Task all run `traycer host start`, which spawns the host), so
//     it gives Linux and Windows the same cap as macOS - Task Scheduler XML
//     cannot set env vars, and a systemd unit would need its own duplicate.
//   - the macOS LaunchAgent plist also sets NODE_OPTIONS directly (see
//     `platforms/macos.ts`); the append above is a no-op there because the host
//     inherits that value via `process.env` and `withHostNodeOptions` collapses
//     the duplicate to the single canonical cap.
//
// `--max-semi-space-size=16` caps V8's young generation. On hosts with a large
// heap limit V8 otherwise sizes the scavenge space for throughput and lets
// `new_space` reach ~64 MB idle / ~128 MB under churn - reserved, mostly-empty
// space that still counts as RSS. This MUST be a creation-time flag: a runtime
// `v8.setFlagsFromString` does NOT cap `new_space`.
//
// Provider CLIs (codex/opencode/claude) are spawned from the user's SHELL env -
// NOT the host's process.env (see `getProviderSpawnEnv`) - so this never leaks
// into third-party binaries.
export const HOST_V8_FLAGS = "--max-semi-space-size=16";

// Diagnostic-report flags for the host process. `--report-on-fatalerror`
// makes Node write a JSON report on a V8 fatal (OOM and friends) - the class
// of abort that otherwise leaves nothing but `phase=crashed` in the log
// (0xC0000409 on Windows). All tokens are in Node's NODE_OPTIONS allowlist
// and space-free on purpose: the report directory is RELATIVE, resolved
// against the spawn cwd (the host data dir), so a Windows profile path with
// spaces never needs NODE_OPTIONS quoting - and a crash BEFORE the host's
// own runtime arming still lands in the exact directory the supervisor
// creates, prunes, and scans. The host entrypoint re-anchors the same
// `<cwd>/crash-reports` absolutely at boot; the two always agree because
// both derive from the spawn cwd.
export const HOST_DIAGNOSTIC_REPORT_FLAGS =
  "--report-on-fatalerror --report-compact --report-directory=crash-reports";

const HOST_APPENDED_FLAGS = `${HOST_V8_FLAGS} ${HOST_DIAGNOSTIC_REPORT_FLAGS}`;

// Value-taking flags this helper canonically owns. Each is stripped from the
// inherited value before the canonical set is appended.
//
// The strip MUST be quote-aware and MUST cover the space-separated form:
// NODE_OPTIONS accepts `--flag value` as well as `--flag=value`, and values
// may be double-quoted (`--report-directory="/path with spaces"`). Removing
// only the flag leaves the VALUE behind as a bare token, and Node rejects the
// whole of NODE_OPTIONS on an unrecognized token - so the host never starts
// at all. That is the worst failure a diagnostics change can ship, which is
// why every arm goes through one shared pattern instead of hand-rolled
// variants that drift (the `--max-semi-space-size` arm had exactly that gap).
const VALUE_FLAGS_OWNED = [
  "--max-semi-space-size",
  "--report-directory",
  // Not appended by us, but stripped: an inherited constant report filename
  // makes every crash overwrite one file, which defeats the supervisor's
  // "report newer than this child, and not one that pre-existed it" scan
  // (and a non-`.json` name makes the scan ignore reports entirely).
  "--report-filename",
] as const;

/** Boolean flags this helper appends; stripped so they cannot duplicate. */
const BOOLEAN_FLAGS_OWNED = [
  "--report-on-fatalerror",
  "--report-compact",
] as const;

// `--flag`, optionally followed by `=value` or ` value`, where value may be
// quoted. The space-separated arm refuses to swallow a following `--flag`, so
// a malformed value-less token cannot eat its neighbor.
function valueFlagPattern(flag: string): RegExp {
  return new RegExp(
    `(^|\\s)${flag}(?:=(?:"[^"]*"|\\S+)|\\s+(?:"[^"]*"|(?!--)\\S+))?(?=\\s|$)`,
    "g",
  );
}

// Appends the host's required creation-time flags to an inherited
// NODE_OPTIONS value, after stripping every token this helper owns - so the
// host always lands on the canonical set whether the inherited value is the
// macOS plist's identical copy (a true no-op) or something an operator set in
// their shell that would silently defeat or duplicate it. Unrelated operator
// tokens are preserved.
export function withHostNodeOptions(existing: string | undefined): string {
  if (existing === undefined || existing.length === 0) {
    return HOST_APPENDED_FLAGS;
  }
  let stripped = existing;
  for (const flag of VALUE_FLAGS_OWNED) {
    stripped = stripped.replace(valueFlagPattern(flag), " ");
  }
  for (const flag of BOOLEAN_FLAGS_OWNED) {
    stripped = stripped.replace(
      new RegExp(`(^|\\s)${flag}(?=\\s|$)`, "g"),
      " ",
    );
  }
  stripped = stripped.trim().replace(/\s+/g, " ");
  return stripped.length > 0
    ? `${stripped} ${HOST_APPENDED_FLAGS}`
    : HOST_APPENDED_FLAGS;
}
