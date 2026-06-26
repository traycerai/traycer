import type { LogLevel } from "@traycer/protocol/config/log-level";

// Re-exported so the preload bridge (which must import only from
// `src/ipc-contracts/`) can reach the protocol's `LogLevel` through this layer.
export type { LogLevel };

export interface AccessibilityThemeSnapshot {
  readonly prefersReducedTransparency: boolean;
  readonly shouldUseHighContrastColors: boolean;
  readonly shouldUseDarkColors: boolean;
  readonly shouldUseInvertedColorScheme: boolean;
}

export interface ProcessMetricsSnapshot {
  readonly main: {
    readonly residentSet: number;
    readonly private: number;
    readonly shared: number;
  };
  readonly appMetrics: ReadonlyArray<{
    readonly pid: number;
    readonly type: string;
    readonly cpu: { readonly percentCPUUsage: number };
    readonly memory: {
      readonly workingSetSize: number;
      readonly peakWorkingSetSize: number;
    };
  }>;
  readonly cpuUsage: { readonly user: number; readonly system: number };
}

export type Vibrancy =
  | "titlebar"
  | "selection"
  | "menu"
  | "popover"
  | "sidebar"
  | "header"
  | "sheet"
  | "window"
  | "hud"
  | "fullscreen-ui"
  | "tooltip"
  | "content"
  | "under-window"
  | "under-page";

export type BackgroundMaterial =
  | "auto"
  | "none"
  | "mica"
  | "acrylic"
  | "tabbed";

export interface PendingCertificateError {
  readonly id: string;
  readonly hostname: string;
  readonly fingerprint: string;
  readonly subject: string;
  readonly issuer: string;
  readonly error: string;
  readonly url: string;
  readonly observedAt: number;
}

export interface FindResultSnapshot {
  readonly requestId: number;
  readonly activeMatchOrdinal: number;
  readonly matches: number;
  readonly finalUpdate: boolean;
}

export interface DisplaySnapshot {
  readonly id: number;
  readonly bounds: { x: number; y: number; width: number; height: number };
  readonly workArea: { x: number; y: number; width: number; height: number };
  readonly scaleFactor: number;
  readonly rotation: number;
  readonly internal: boolean;
  readonly label: string;
  readonly primary: boolean;
}

export interface DisplayTopology {
  readonly displays: ReadonlyArray<DisplaySnapshot>;
  readonly primaryId: number;
}

export interface FileSaveInput {
  readonly name: string;
  readonly type: string;
  readonly bytes: ArrayBuffer;
}

export type FindInPageStopAction =
  | "clearSelection"
  | "keepSelection"
  | "activateSelection";

export interface TrustedCertificateEntry {
  readonly fingerprint: string;
  readonly hostname: string;
  readonly subject: string;
  readonly issuer: string;
  readonly trustedAt: number;
}

/** Which logger a Settings change targets. */
export type LogLevelScope = "cli" | "host" | "desktop";

/** The three configurable thresholds, surfaced together to the renderer. */
export interface LogLevelsSnapshot {
  readonly cliLogLevel: LogLevel;
  readonly hostLogLevel: LogLevel;
  readonly desktopLogLevel: LogLevel;
}
