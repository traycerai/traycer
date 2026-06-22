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

// Appends the host's required V8 flags to an inherited NODE_OPTIONS value.
// Any pre-existing `--max-semi-space-size` token is stripped first so the
// host always lands on the canonical cap - whether the inherited value is the
// macOS plist's identical `=16` (a true no-op) or some larger value an operator
// set in their shell, which would otherwise silently defeat the cap.
export function withHostNodeOptions(existing: string | undefined): string {
  if (existing === undefined || existing.length === 0) {
    return HOST_V8_FLAGS;
  }
  const stripped = existing
    .replace(/(^|\s)--max-semi-space-size(?:=\S+)?(?=\s|$)/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  return stripped.length > 0 ? `${stripped} ${HOST_V8_FLAGS}` : HOST_V8_FLAGS;
}
