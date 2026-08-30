import {
  Analytics,
  AnalyticsEvent,
  type AnalyticsBrowserPersistenceBackend,
  type AnalyticsBrowserPersistenceReason,
  type AnalyticsBrowserPersistenceResult,
  type AnalyticsBrowserPersistenceSurface,
  type AnalyticsPlatform,
} from "@/lib/analytics";
import type {
  BrowserCookieCryptoReason,
  BrowserCookieStorageBackend,
  BrowserPersistencePlatform,
  BrowserPersistenceState,
} from "@traycer-clients/shared/platform/browser-view";

/**
 * The browser-login persistence funnel (spec decision #20): card shown →
 * enable / not now → allowed / denied / retry → relaunch → enabled, plus the
 * steady-state crypto reason at the first tile of a session.
 *
 * ONE module owns every payload this funnel emits, so the hygiene rule is a
 * property of the module rather than of each call site: a payload carries
 * **state names, platform, backend and durations only**. No domain, no
 * hostname, no URL, no cookie name, and no count of sites - a count is a
 * fingerprint of a browsing history, and the funnel is measured in decisions.
 *
 * Callers describe the transition; the mapping from the desktop's kebab-cased
 * vocabulary to the analytics spelling lives here, once.
 */

/** Where the gesture came from. Deliberately not `AnalyticsSource`: these are
 * product surfaces, and "which surface enables" is the whole question. */
export type BrowserPersistenceSurface = AnalyticsBrowserPersistenceSurface;

export type BrowserPersistenceEnableResult = AnalyticsBrowserPersistenceResult;

export type BrowserPersistenceAnalyticsEvent =
  | { readonly name: "browser_persistence_card_shown" }
  | {
      readonly name: "browser_persistence_card_action";
      readonly action: "enable" | "not_now";
    }
  | {
      readonly name: "browser_persistence_enable_result";
      readonly result: BrowserPersistenceEnableResult;
      readonly durationMs: number;
      readonly source: BrowserPersistenceSurface;
    }
  | {
      readonly name: "browser_persistence_relaunch_clicked";
      readonly source: BrowserPersistenceSurface;
    }
  | {
      readonly name: "browser_persistence_state_at_first_tile";
      readonly reason: BrowserCookieCryptoReason;
      readonly backend: BrowserCookieStorageBackend;
      readonly platform: BrowserPersistencePlatform;
    }
  | {
      readonly name: "browser_logins_forgotten";
      readonly source: "settings" | "shield";
    }
  | {
      readonly name: "browser_site_cleared";
      readonly source: "settings" | "tile";
    };

/**
 * Both latches are per renderer session, not per component. The explainer is a
 * one-time card and the first-tile reading is a once-per-session census, so a
 * remount (the card moves between tiles as its claim is released) must not
 * count as a second impression.
 */
let cardShownTracked = false;
let firstTileTracked = false;

export function trackBrowserPersistence(
  event: BrowserPersistenceAnalyticsEvent,
): void {
  const analytics = Analytics.getInstance();
  switch (event.name) {
    case "browser_persistence_card_shown":
      analytics.track(AnalyticsEvent.BrowserPersistenceCardShown, null);
      return;
    case "browser_persistence_card_action":
      analytics.track(AnalyticsEvent.BrowserPersistenceCardAction, {
        action: event.action,
      });
      return;
    case "browser_persistence_enable_result":
      analytics.track(AnalyticsEvent.BrowserPersistenceEnableResult, {
        result: event.result,
        duration_ms: analyticsDurationMs(event.durationMs),
        source: event.source,
      });
      return;
    case "browser_persistence_relaunch_clicked":
      analytics.track(AnalyticsEvent.BrowserPersistenceRelaunchClicked, {
        source: event.source,
      });
      return;
    case "browser_persistence_state_at_first_tile":
      analytics.track(AnalyticsEvent.BrowserPersistenceStateAtFirstTile, {
        reason: analyticsCryptoReason(event.reason),
        backend: analyticsStorageBackend(event.backend),
        platform: analyticsDesktopPlatform(event.platform),
      });
      return;
    case "browser_logins_forgotten":
      analytics.track(AnalyticsEvent.BrowserLoginsForgotten, {
        source: event.source,
      });
      return;
    case "browser_site_cleared":
      analytics.track(AnalyticsEvent.BrowserSiteCleared, {
        source: event.source,
      });
      return;
  }
}

/** Fires at most once per renderer session; a re-render of the card is not a
 * second impression. */
export function trackBrowserPersistenceCardShown(): void {
  if (cardShownTracked) return;
  cardShownTracked = true;
  trackBrowserPersistence({ name: "browser_persistence_card_shown" });
}

/**
 * The steady-state census: what does persistence actually look like on this
 * machine the first time a tile opens in this session? Latched, because the
 * answer is about the machine and N tiles must not mean N readings.
 */
export function trackBrowserPersistenceStateAtFirstTile(
  state: BrowserPersistenceState,
): void {
  if (firstTileTracked) return;
  firstTileTracked = true;
  trackBrowserPersistence({
    name: "browser_persistence_state_at_first_tile",
    reason: state.cryptoState.reason,
    backend: state.cryptoState.storageBackend,
    platform: state.platform,
  });
}

/**
 * Forget-all lives in Settings (ticket 10) and, while it is still there, on
 * the tile shield. Exported as its own helper so both call sites name the
 * same event without importing the union.
 */
export function trackBrowserLoginsForgotten(
  source: "settings" | "shield",
): void {
  trackBrowserPersistence({ name: "browser_logins_forgotten", source });
}

/**
 * What an enable attempt actually resolved to. `relaunch-pending` is checked
 * FIRST: the second denial both records the relaunch offer and leaves the
 * crypto reason at `keychain-denied`, and the funnel's whole question is how
 * many users reach the relaunch step rather than how many denials it took.
 *
 * A `null` state is an enable that never answered (a bridge older than the
 * channel, or a rejected call); the funnel still has to close, so it reports
 * `unavailable` rather than silently dropping the attempt.
 */
export function browserPersistenceEnableResult(
  state: BrowserPersistenceState | null,
): BrowserPersistenceEnableResult {
  if (state === null) return "unavailable";
  if (state.decision.kind === "relaunch-pending") return "relaunch_pending";
  if (state.cryptoState.reason === "os-backed") return "os_backed";
  if (state.cryptoState.reason === "keychain-denied") return "keychain_denied";
  return "unavailable";
}

const CRYPTO_REASONS: Readonly<
  Record<BrowserCookieCryptoReason, AnalyticsBrowserPersistenceReason>
> = {
  "encryption-unavailable": "encryption_unavailable",
  "keychain-denied": "keychain_denied",
  "linux-basic-text": "linux_basic_text",
  "not-enabled": "not_enabled",
  "os-backed": "os_backed",
  unresolved: "unresolved",
};

function analyticsCryptoReason(
  reason: BrowserCookieCryptoReason,
): AnalyticsBrowserPersistenceReason {
  return CRYPTO_REASONS[reason];
}

/** `null` is "nothing was probed here", which is a reading in its own right -
 * it is reported as `none` rather than dropped. */
function analyticsStorageBackend(
  backend: BrowserCookieStorageBackend,
): AnalyticsBrowserPersistenceBackend {
  return backend === null ? "none" : backend;
}

const DESKTOP_PLATFORMS: Readonly<
  Record<BrowserPersistencePlatform, AnalyticsPlatform>
> = {
  darwin: "macos",
  linux: "linux",
  other: "other",
  win32: "windows",
};

/** The desktop names its platforms the way Node does; PostHog already has one
 * `platform` vocabulary (the registered global) and must not gain a second. */
function analyticsDesktopPlatform(
  platform: BrowserPersistencePlatform,
): AnalyticsPlatform {
  return DESKTOP_PLATFORMS[platform];
}

/** Durations are clamped into the sanitizer's measure range so a clock jump
 * cannot drop an otherwise good funnel event. */
function analyticsDurationMs(durationMs: number): number {
  if (!Number.isFinite(durationMs)) return 0;
  return Math.min(Math.max(Math.round(durationMs), 0), 1_000_000);
}

/** Test-only: clears the session latches between tests. */
export function __resetBrowserPersistenceAnalyticsForTests(): void {
  cardShownTracked = false;
  firstTileTracked = false;
}
