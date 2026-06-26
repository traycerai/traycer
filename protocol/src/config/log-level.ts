/**
 * Log-level vocabulary shared by every Traycer logger — the host, the CLI, the
 * desktop main process, and the GUI renderer. Kept dependency-free (no zod, no
 * `node:fs`) so the browser renderer can import it from the `@traycer/protocol`
 * root without dragging in the filesystem-backed config store. The zod schema
 * that *persists* these values lives in `./schema` (Node-only).
 */

export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LOG_LEVEL_RANK: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

/** Default threshold for every surface: quiet (no debug/trace) but never silent. */
export const DEFAULT_LOG_LEVEL: LogLevel = "info";

export function isLogLevel(value: unknown): value is LogLevel {
  return (
    typeof value === "string" &&
    (LOG_LEVELS as readonly string[]).includes(value)
  );
}

/**
 * True when a message at `level` should be emitted under `threshold`. A level is
 * a threshold: `info` emits info/warn/error and drops debug/trace. There is no
 * "off" — `error` always passes — so a quiet setting can never hide a failure.
 */
export function logLevelAllows(threshold: LogLevel, level: LogLevel): boolean {
  return LOG_LEVEL_RANK[level] >= LOG_LEVEL_RANK[threshold];
}
