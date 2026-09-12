/**
 * Docs: see `src/components/settings/SETTINGS.md` § Search.
 *
 * Whether a settings row exists in THIS shell — one named predicate per gate.
 *
 * Each gated panel and the search-index entry that points into it call the
 * SAME function, so a gate is written exactly once: a row cannot render in a
 * shell where search withholds it, and search cannot offer a row the panel
 * will not draw. A result that navigates to a page and lights nothing reads
 * as "this takes me nowhere", which is worse than not offering it at all.
 *
 * No React here. The panels reach these through
 * `useSettingsAvailabilityContext()`, the search through the same hook in the
 * search box, and tests call them with a literal context.
 *
 * What a predicate may read is the SHELL: the runner host's bridges, the
 * desktop feature-settings bridge and the product identity — and only through
 * its context argument, never a global, so the context is the whole truth. It
 * never decides selected-host identity or a capability negotiated over host
 * RPC — a shell-level context has no stable answer to either, so rows gated
 * on them are not indexed and their enclosing page is. The existing bridge resolvers stay the source of truth for each
 * bridge; a predicate only names which bridge its row needs.
 */
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import type { FeatureSettingsBridge } from "@/lib/desktop-feature-settings";
import {
  resolveDesktopPowerBridge,
  resolveDesktopZoomBridge,
} from "@/lib/windows/desktop-capabilities";

export interface SettingsAvailabilityContext {
  /** `null` in host-less shells, where every bridge-gated row is absent. */
  readonly runnerHost: IRunnerHost | null;
  /**
   * `getFeatureSettingsBridge()`, read by the caller at call time. It lives on
   * the window global rather than the runner host, so the caller resolves it
   * and a predicate never reads the global itself.
   */
  readonly featureSettings: FeatureSettingsBridge | null;
  /**
   * `isMobileApp()`, read by the caller at call time. Never captured at
   * module init: the Capacitor entry sets it before first render, and a module
   * evaluated earlier than that would freeze the wrong answer.
   */
  readonly mobileApp: boolean;
}

/** Rendered in every shell. */
export function alwaysAvailable(
  _context: SettingsAvailabilityContext,
): boolean {
  return true;
}

/**
 * Voice input — dictation is host-executed and `useDictationAvailability`
 * refuses it outright without a LOCAL host, so in a shell whose every
 * reachable host is another machine the toggle would control nothing and the
 * row's description would promise on-device transcription that shell cannot
 * deliver.
 *
 * Keyed on the capability rather than the product flag: a browser tab has the
 * phone's lack of a local host and the desktop's `mobileApp === false`, so the
 * flag answers this question wrongly there.
 */
export function isVoiceInputRowAvailable(
  context: SettingsAvailabilityContext,
): boolean {
  return context.runnerHost !== null && context.runnerHost.hasLocalHost;
}

/**
 * Prevent sleep — its only consumer holds an OS power-save blocker through
 * the desktop power bridge, so the row is keyed on the very bridge that
 * consumer resolves. Feature-detected rather than read as a field, because
 * `power` is a duck-typed extra a shell installs and not a typed
 * `IRunnerHost` member; keyed on the bridge rather than the product flag for
 * the same reason as voice input, since a browser tab has no bridge either.
 */
export function isPreventSleepRowAvailable(
  context: SettingsAvailabilityContext,
): boolean {
  return (
    context.runnerHost !== null &&
    resolveDesktopPowerBridge(context.runnerHost) !== null
  );
}

/** General › Experimental — the desktop feature-settings bridge. */
export function isExperimentalGroupAvailable(
  context: SettingsAvailabilityContext,
): boolean {
  return context.featureSettings !== null;
}

/** Appearance › Zoom — the desktop zoom bridge. */
export function isZoomRowAvailable(
  context: SettingsAvailabilityContext,
): boolean {
  return (
    context.runnerHost !== null &&
    resolveDesktopZoomBridge(context.runnerHost) !== null
  );
}

/** Notifications › System — the OS notification-settings pointer. */
export function isSystemNotificationsGroupAvailable(
  context: SettingsAvailabilityContext,
): boolean {
  return (
    context.runnerHost !== null &&
    context.runnerHost.notifications.systemSettings !== null
  );
}

/** Notifications › This phone — the OS push permission of a phone shell. */
export function isPushPermissionGroupAvailable(
  context: SettingsAvailabilityContext,
): boolean {
  return (
    context.runnerHost !== null && context.runnerHost.pushPermission !== null
  );
}
