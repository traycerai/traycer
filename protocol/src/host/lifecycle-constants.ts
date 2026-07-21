/**
 * Host shutdown timings shared between the host process and the CLI service
 * controller so they can't drift apart in separate packages.
 */

/**
 * Hard ceiling the host's own shutdown watchdog waits before forcing
 * `process.exit` (`main-bootstrap.ts`). Graceful close normally finishes in
 * milliseconds; this only fires if `close()` wedges.
 */
export const SHUTDOWN_FORCE_EXIT_MS = 30_000;

/**
 * Extra headroom the CLI's stop/restart poll keeps ABOVE the watchdog. The CLI
 * grace (`SHUTDOWN_FORCE_EXIT_MS + STOP_EXIT_GRACE_MARGIN_MS`) must stay above
 * the watchdog: if the CLI gives up first it reports a spurious "stop did not
 * take effect" failure - and aborts `restart` before relaunch - for a host
 * that is in fact guaranteed to exit moments later.
 */
export const STOP_EXIT_GRACE_MARGIN_MS = 2_000;

/**
 * Per-step timeouts for the Windows Scheduled-Task restart sequence
 * (`traycer-cli/src/service/platforms/windows.ts`: `stopService` /
 * `killHostProcessTree` / `startService` / `restartService`). Windows has no
 * single graceful-stop signal like launchd SIGTERM - `restart` runs a
 * sequence of independently-capped steps: `schtasks /End`, a PowerShell
 * process-tree scan, `taskkill` on any surviving pids, then `schtasks /Run`,
 * post-`/Run` spawn-evidence verification, and (on verification failure) a
 * Last Run Result query.
 * Exported here (not left as local literals in `windows.ts`) so the outer
 * budget below can be derived from the platform's actual worst case instead
 * of duplicating these numbers as a second, driftable magic number.
 */
export const WINDOWS_SCHTASKS_END_TIMEOUT_MS = 30_000;
export const WINDOWS_PROCESS_SCAN_TIMEOUT_MS = 10_000;
export const WINDOWS_TASKKILL_TIMEOUT_MS = 30_000;
export const WINDOWS_SCHTASKS_RUN_TIMEOUT_MS = 30_000;
export const WINDOWS_SCHTASKS_QUERY_TIMEOUT_MS = 10_000;

/**
 * After `schtasks /Run`, how long `startService` polls for post-baseline
 * spawn evidence (pid metadata written after the run baseline, or a
 * post-baseline bootstrap marker) before reading Last Run Result and
 * failing with `SERVICE_CONTROL_FAILED`. Exit 0 from `/Run` only means the
 * scheduler accepted the request - not that anything spawned.
 */
export const WINDOWS_START_SPAWN_VERIFY_MS = 15_000;
export const WINDOWS_START_SPAWN_POLL_MS = 250;

/**
 * Hard ceiling for host-readiness waits that extend past the base budget
 * when post-baseline spawn evidence is present (slow first-exec of a freshly
 * downloaded multi-GB host binary). Base budget remains 60s; this is only
 * the extended absolute cap.
 */
export const HOST_READY_EXTENDED_TIMEOUT_MS = 5 * 60_000;

/**
 * Worst-case cumulative duration of a legitimate (non-failing) Windows
 * restart: every step in the sequence runs right up against its own
 * timeout and still succeeds. Not a typical duration - a bound.
 */
export const WINDOWS_RESTART_SEQUENCE_TIMEOUT_MS =
  WINDOWS_SCHTASKS_END_TIMEOUT_MS +
  WINDOWS_PROCESS_SCAN_TIMEOUT_MS +
  WINDOWS_TASKKILL_TIMEOUT_MS +
  WINDOWS_SCHTASKS_RUN_TIMEOUT_MS +
  WINDOWS_START_SPAWN_VERIFY_MS +
  WINDOWS_SCHTASKS_QUERY_TIMEOUT_MS;

/**
 * Budget for a full `traycer host restart` subprocess as invoked by Desktop
 * (Settings, tray, and the native-menu respawn path all route through this
 * one constant). `host restart` runs stop-then-start, and a caller-side
 * timeout shorter than the platform's own worst-case sequence SIGKILLs the
 * CLI mid-restart - after stop succeeds but before start runs - leaving the
 * host down. That is exactly what a desktop-side 10s cap against macOS's 32s
 * stop-grace used to do.
 *
 * Derived as the max of every platform's worst case plus margin, not just
 * macOS's: on macOS the stop phase alone waits up to `SHUTDOWN_FORCE_EXIT_MS
 * + STOP_EXIT_GRACE_MARGIN_MS`; on Windows the four-step sequence above can
 * legitimately take `WINDOWS_RESTART_SEQUENCE_TIMEOUT_MS`, which is larger.
 * A budget sized only for macOS would SIGKILL a slow-but-successful Windows
 * restart during its final `schtasks /Run` step - the same class of bug this
 * constant exists to prevent, just on the other platform.
 */
export const HOST_RESTART_SUBPROCESS_TIMEOUT_MS = Math.max(
  SHUTDOWN_FORCE_EXIT_MS + STOP_EXIT_GRACE_MARGIN_MS + 60_000,
  WINDOWS_RESTART_SEQUENCE_TIMEOUT_MS + 30_000,
);
