/**
 * Plain-data mirror of `LocalHostSnapshot` from
 * `@traycer-clients/shared/platform/runner-host`. The Electron bridge must not
 * import the shared module directly (Electron main/preload are CommonJS and
 * live outside the shared package's module resolution) - we duplicate the
 * shape here so `contextBridge` serializes a plain object while the renderer
 * consumes the fully typed shared interface.
 */
export interface DesktopLocalHostSnapshot {
  readonly hostId: string;
  readonly websocketUrl: string;
  readonly version: string;
  readonly pid: number;
  readonly systemHostName: string;
  readonly displayName: string;
}

export interface DesktopTrayEpic {
  readonly epicId: string;
  readonly title: string;
  readonly subtitle: string;
}

export type DesktopTrayIndicatorState = "idle" | "active" | "attention";
