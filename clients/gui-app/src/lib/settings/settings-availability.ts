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
 *
 * Every member here is a fact about the shell, never a stored preference: a
 * preference has no shell-wide answer the moment it is per host or per
 * surface, and a predicate that reads one withholds a row from search while
 * its control is on screen. The one layout value that decides whether a
 * surface exists, `arrangement.mobileFooter`, is read by the row that writes
 * it (`layout-settings-panel.tsx`) rather than by a predicate.
 */
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import type { FeatureSettingsBridge } from "@/lib/desktop-feature-settings";
import { resolveDesktopZoomBridge } from "@/lib/windows/desktop-capabilities";

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
 * Voice input — the mobile app refuses dictation outright
 * (`useDictationAvailability`), so the toggle would control nothing.
 */
export function isVoiceInputRowAvailable(
  context: SettingsAvailabilityContext,
): boolean {
  return !context.mobileApp;
}

/**
 * Prevent sleep — its only consumer holds an OS power-save blocker through
 * the desktop power bridge, which the mobile app does not have.
 */
export function isPreventSleepRowAvailable(
  context: SettingsAvailabilityContext,
): boolean {
  return !context.mobileApp;
}

/**
 * Layout › Status bar ▸ "Show the status bar on small screens" - the one
 * surface-level row (L-51), which exists only where the footer is withheld by
 * default. Every region section on the page is drawn in every shell: a region
 * the strip does not host is hosted by the header instead, so there is nothing
 * for a second gate to withhold.
 */
export function isMobileFooterRowAvailable(
  context: SettingsAvailabilityContext,
): boolean {
  return context.mobileApp;
}

/**
 * Layout › Customize layout - the canvas editor, and every door that offers it
 * by name. It needs a window wider than the phone layout ever draws
 * (`LAYOUT_EDITOR_MIN_WIDTH`), and the installed app is a phone-layout product
 * on every device, so there it can never open. A narrow DESKTOP window keeps
 * it: widening the window is the way in, and the page says so.
 */
export function isLayoutEditorAvailable(
  context: SettingsAvailabilityContext,
): boolean {
  return !context.mobileApp;
}

/**
 * Layout › Chat › Minimap ▸ Side - the installed app never draws the edge
 * rail (the chat minimap is withheld on the phone layout, the artifact one
 * needs a fine pointer): its minimap is the tile bar's bottom drawer, which has
 * no side. The region's Shown switch still decides the drawer.
 */
export function isMinimapSideRowAvailable(
  context: SettingsAvailabilityContext,
): boolean {
  return !context.mobileApp;
}

/** General › Experimental — the desktop feature-settings bridge. */
export function isExperimentalGroupAvailable(
  context: SettingsAvailabilityContext,
): boolean {
  return context.featureSettings !== null;
}

/**
 * General › When you quit Traycer — the desktop's host lifecycle bridge.
 * Present in every desktop launch, including one with no local host (where
 * it is the only way back), and absent on the phone and in the browser.
 */
export function isHostLifecycleGroupAvailable(
  context: SettingsAvailabilityContext,
): boolean {
  return (
    !context.mobileApp &&
    context.runnerHost !== null &&
    context.runnerHost.hostLifecycle !== null
  );
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
