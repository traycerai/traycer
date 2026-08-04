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

// Appends the host's required creation-time flags to an inherited
// NODE_OPTIONS value. Any pre-existing token this helper canonically appends
// (`--max-semi-space-size`, the report flags, `--report-directory`) is
// stripped first so the host always lands on the canonical set - whether the
// inherited value is the macOS plist's identical copy (a true no-op) or some
// other value an operator set in their shell, which would otherwise silently
// defeat or duplicate it. Unrelated operator tokens are preserved.
export function withHostNodeOptions(existing: string | undefined): string {
  if (existing === undefined || existing.length === 0) {
    return HOST_APPENDED_FLAGS;
  }
  const stripped = existing
    .replace(/(^|\s)--max-semi-space-size(?:=\S+)?(?=\s|$)/g, " ")
    .replace(/(^|\s)--report-on-fatalerror(?=\s|$)/g, " ")
    .replace(/(^|\s)--report-compact(?=\s|$)/g, " ")
    // Quote-aware, and covers both `=value` and space-separated forms:
    // NODE_OPTIONS values may be double-quoted (`--report-directory="/path
    // with spaces"`), and a naive \S+ strip would leave `with spaces"`
    // behind - an unterminated NODE_OPTIONS that kills Node before any user
    // code runs. The space-separated arm refuses to swallow a following
    // `--flag` so a malformed value-less token cannot eat its neighbor.
    .replace(
      /(^|\s)--report-directory(?:=(?:"[^"]*"|\S+)|\s+(?:"[^"]*"|(?!--)\S+))?(?=\s|$)/g,
      " ",
    )
    .trim()
    .replace(/\s+/g, " ");
  return stripped.length > 0
    ? `${stripped} ${HOST_APPENDED_FLAGS}`
    : HOST_APPENDED_FLAGS;
}
