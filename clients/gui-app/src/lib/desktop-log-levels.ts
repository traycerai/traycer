import type { LogLevel } from "@traycer/protocol/config/log-level";

/**
 * Feature-detected access to the desktop-only `platform.logLevels` namespace the
 * Electron preload installs on `window.runnerHost`. gui-app stays browser-safe,
 * so this reads the global defensively and returns `null` on shells (web /
 * gui-app-dev) that don't expose it — there, log-level config simply isn't
 * available. Typed locally so gui-app doesn't import from the desktop package.
 */

export type LogLevelScope = "cli" | "host" | "desktop";

export interface LogLevelsSnapshot {
  readonly cliLogLevel: LogLevel;
  readonly hostLogLevel: LogLevel;
  readonly desktopLogLevel: LogLevel;
}

export interface LogLevelsBridge {
  readonly get: () => Promise<LogLevelsSnapshot>;
  readonly set: (
    scope: LogLevelScope,
    level: LogLevel,
  ) => Promise<LogLevelsSnapshot>;
}

interface RunnerHostWindowShape {
  readonly platform:
    { readonly logLevels: LogLevelsBridge | undefined } | undefined;
}

export function getLogLevelsBridge(): LogLevelsBridge | null {
  const host = (globalThis as { runnerHost?: RunnerHostWindowShape })
    .runnerHost;
  return host?.platform?.logLevels ?? null;
}

export function selectScopeLevel(
  snapshot: LogLevelsSnapshot,
  scope: LogLevelScope,
): LogLevel {
  switch (scope) {
    case "cli":
      return snapshot.cliLogLevel;
    case "host":
      return snapshot.hostLogLevel;
    case "desktop":
      return snapshot.desktopLogLevel;
  }
}
