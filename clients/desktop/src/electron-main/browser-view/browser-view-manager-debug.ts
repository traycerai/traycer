/**
 * BT-501: env-gated debug surface for the Playwright Electron specs.
 *
 * Only installed when TRAYCER_E2E=1; production builds never define it.
 * Lives on `globalThis` because the specs reach it via `app.evaluate()`,
 * which runs inside the main process where the manager instances live.
 */

export interface BrowserViewManagerDebug {
  /** Effective bounds per entry key id, as last applied to the view. */
  readonly boundsByKeyId: () => Record<string, { x: number; y: number; width: number; height: number }>;
  /** Entry key ids currently parked under an overlay owner. */
  readonly occludedKeyIds: () => readonly string[];
  /** Frame-cache counters (BT-205). */
  readonly frameCacheStats: () => {
    readonly attached: number;
    readonly framesAccepted: number;
    readonly framesSkipped: number;
    readonly emptyFrames: number;
    readonly encodeFailures: number;
  };
  /** Key ids evicted by the hidden-guest LRU since startup (BT-403). */
  readonly evictedKeyIds: () => readonly string[];
}

const DEBUG_KEY = "__traycerBrowserViewManagerDebug";

function isBrowserViewManagerDebug(
  value: unknown,
): value is BrowserViewManagerDebug {
  if (typeof value !== "object" || value === null) return false;
  return (
    "boundsByKeyId" in value &&
    "occludedKeyIds" in value &&
    "frameCacheStats" in value &&
    "evictedKeyIds" in value
  );
}

/** Cast-free global registration. */
export function installBrowserViewManagerDebug(
  debug: BrowserViewManagerDebug,
): void {
  Object.defineProperty(globalThis, DEBUG_KEY, {
    configurable: true,
    writable: false,
    value: debug,
  });
}

export function readBrowserViewManagerDebug(): BrowserViewManagerDebug | null {
  const value: unknown = Reflect.get(globalThis, DEBUG_KEY);
  return isBrowserViewManagerDebug(value) ? value : null;
}
