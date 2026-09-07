/**
 * Host shutdown timings shared between the host process and the CLI service
 * controller so they can't drift apart in separate packages.
 */

/**
 * Hard ceiling the host's own shutdown watchdog waits before forcing `process.exit` (`main-bootstrap.ts`).
 */
export const SHUTDOWN_FORCE_EXIT_MS = 30_000;

/** Deliberate host restart. */
export const RESTART_EXIT_CODE = 87;

/** Extra headroom the CLI's stop/restart poll keeps ABOVE the watchdog. */
export const STOP_EXIT_GRACE_MARGIN_MS = 2_000;

export const WINDOWS_SCHTASKS_END_TIMEOUT_MS = 30_000;
/**
 * Bound on ONE `Get-CimInstance Win32_Process` scan.
 * At 10 s any load pushed the scan over the bound and `host stop` was refused fail-closed - 3 of 5 loaded attempts on 2026-09-06 - before anything was killed.
 */
export const WINDOWS_PROCESS_SCAN_TIMEOUT_MS = 30_000;
export const WINDOWS_TASKKILL_TIMEOUT_MS = 30_000;
export const WINDOWS_SCHTASKS_RUN_TIMEOUT_MS = 30_000;
export const WINDOWS_SCHTASKS_QUERY_TIMEOUT_MS = 10_000;

/**
 * How many KILL passes `killHostProcessTree` may make before it gives up and fails naming the survivors.
 */
export const WINDOWS_KILL_CONVERGENCE_ROUNDS = 3;

export const WINDOWS_START_SPAWN_VERIFY_MS = 15_000;
export const WINDOWS_START_SPAWN_POLL_MS = 250;

export const HOST_READY_EXTENDED_TIMEOUT_MS = 5 * 60_000;

export const WINDOWS_RESTART_SEQUENCE_TIMEOUT_MS =
  WINDOWS_SCHTASKS_END_TIMEOUT_MS +
  // The kill step is a bounded scan-then-kill loop, not a single pass, so its worst case scales with the round bound.
  (WINDOWS_KILL_CONVERGENCE_ROUNDS + 1) * WINDOWS_PROCESS_SCAN_TIMEOUT_MS +
  WINDOWS_KILL_CONVERGENCE_ROUNDS * WINDOWS_TASKKILL_TIMEOUT_MS +
  WINDOWS_SCHTASKS_RUN_TIMEOUT_MS +
  WINDOWS_START_SPAWN_VERIFY_MS +
  WINDOWS_SCHTASKS_QUERY_TIMEOUT_MS;

export const HOST_RESTART_SUBPROCESS_TIMEOUT_MS = Math.max(
  SHUTDOWN_FORCE_EXIT_MS + STOP_EXIT_GRACE_MARGIN_MS + 60_000,
  WINDOWS_RESTART_SEQUENCE_TIMEOUT_MS + 30_000,
);
