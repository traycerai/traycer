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
