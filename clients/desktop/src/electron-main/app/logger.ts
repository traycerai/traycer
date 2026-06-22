import log from "electron-log";
import { app } from "electron";
import { join } from "node:path";
import { isDevBuild } from "../../config";

/**
 * Configures `electron-log` so the desktop shell, the renderer, and any
 * spawned host-lifecycle diagnostics flow through a single sink.
 *
 * The host itself writes to `~/.traycer/host/host.log` in production and
 * `~/.traycer/host/dev/host.log` in dev - see `host-paths.ts`. Our own
 * main-process log is kept separate at
 * `userData/traycer-desktop.log` so the two are easy to differentiate in
 * support bundles.
 */
export function initLogger(): void {
  const logPath = resolveDesktopLogPath();
  log.transports.file.resolvePathFn = () => logPath;
  log.transports.file.level = "info";
  // Console transport is noisy by design (every IPC + lifecycle log).
  // Shipped builds get the same `info` level the file transport does so
  // electron-log's stdout/stderr capture doesn't leak debug payloads to a
  // user's system console; the dev slot keeps `debug`.
  log.transports.console.level = isDevBuild ? "debug" : "info";
  log.info("[desktop] logger initialised", { logPath });
}

export function resolveDesktopLogPath(): string {
  return join(app.getPath("userData"), "traycer-desktop.log");
}

export { log };
