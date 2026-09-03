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

/**
 * One V8 isolate inside the renderer process: the page itself, or one of the
 * dedicated workers it has spawned. `url` is the isolate's script URL - for a
 * worker, the chunk it was started from, which is what tells an epic runtime
 * worker apart from a diff highlighter worker.
 */
export interface RendererJsHeapIsolate {
  readonly kind: "page" | "worker";
  readonly url: string;
  /** `Runtime.getHeapUsage` - live objects after the last GC. */
  readonly usedBytes: number;
  /** `Runtime.getHeapUsage` - pages V8 has committed for this isolate. */
  readonly totalBytes: number;
  /**
   * `Runtime.getHeapUsage` - memory the embedder (Blink) holds for this
   * isolate, outside the JS heap the two fields above measure. `null` when the
   * protocol build does not report it (both fields are experimental).
   */
  readonly embedderBytes: number | null;
  /**
   * `Runtime.getHeapUsage` - backing stores for `ArrayBuffer`s and WebAssembly
   * memory. A diff highlighter worker's Oniguruma engine lives here, not in
   * `usedBytes`, so a row without it undercounts exactly the off-main-thread
   * memory this readout exists to attribute.
   */
  readonly backingStorageBytes: number | null;
}

/**
 * The renderer's JS heaps, one row per isolate. A main-thread heap snapshot
 * sees the page's isolate only; a renderer that runs a dozen dedicated workers
 * can hold most of its memory where that snapshot cannot look. This is the
 * readout that says where.
 */
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

/**
 * A host whose registry-published Noise static key no longer matches the one
 * this client pinned on first sight (browser-security-hardening H11).
 *
 * The host has ALREADY been refused in main by the time this is emitted -
 * nothing a surface does re-admits it - so this exists to say so rather than
 * to ask. `remedy` carries the one honest recovery there is: delete the pin
 * record at `pinLocation`. Structured-clone-safe by construction; the typed
 * `HostKeyPinMismatchError` does not cross the boundary.
 */
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

/**
 * What `fileSave` hands back once the bytes are on disk. `name` is the base
 * name the user settled on in the save dialog (display copy for the toast);
 * `path` is the absolute location, which is the only thing `fileOpenSaved`
 * accepts - the renderer never composes or edits it.
 */
export interface FileSaveResult {
  readonly name: string;
  readonly path: string;
}

/**
 * Which surface a trust grant applies to. Grants are scope-specific: trusting
 * a cert for an in-app browser tab never grants it to the app shell itself,
 * so listing and revoking must carry the scope too.
 */
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
