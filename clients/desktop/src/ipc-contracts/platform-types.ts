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

export interface RendererJsHeapIsolate {
  readonly kind: "page" | "worker";
  readonly url: string;
  /** `Runtime.getHeapUsage` - live objects after the last GC. */
  readonly usedBytes: number;
  /** `Runtime.getHeapUsage` - pages V8 has committed for this isolate. */
  readonly totalBytes: number;
  readonly embedderBytes: number | null;
  readonly backingStorageBytes: number | null;
}

/** A main-thread heap snapshot sees the page's isolate only; a renderer that runs a dozen dedicated workers can hold most of its memory where that snapshot cannot look. */
export interface RendererJsHeapBreakdown {
  readonly capturedAt: number;
  /** The whole renderer process's working set, or `null` if it has no metric. */
  readonly workingSetBytes: number | null;
  readonly isolates: ReadonlyArray<RendererJsHeapIsolate>;
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

/** A host whose registry-published Noise static key no longer matches the one this client pinned on first sight (browser-security-hardening H11). */
export interface HostKeyPinMismatch {
  readonly hostId: string;
  readonly pinnedKey: string;
  readonly offeredKey: string;
  readonly pinLocation: string;
  readonly remedy: string;
  readonly observedAt: number;
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

export interface FileSaveResult {
  readonly name: string;
  readonly path: string;
}

/** Grants are scope-specific: trusting a cert for an in-app browser tab never grants it to the app shell itself, so listing and revoking must carry the scope too. */
export type CertificateTrustScope = "app-shell" | "browser";

export interface TrustedCertificateEntry {
  readonly scope: CertificateTrustScope;
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

export interface FeatureSettingsSnapshot {
  readonly agentRoles: boolean;
}

/** A font family installed on this machine, offered by the Appearance font pickers. */
export interface InstalledFont {
  readonly family: string;
}
