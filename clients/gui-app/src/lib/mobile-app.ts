/**
 * PRODUCT signal: "is this the installed Traycer mobile app?" (the Capacitor
 * bundle) - as opposed to Electron desktop or a plain browser tab.
 *
 * This is one of THREE distinct device/shell signals; picking the wrong one
 * causes subtle bugs, so choose by the question you are asking:
 *
 * - "Would resizing the window change this?" -> `useIsMobileViewport()`
 *   (`@/hooks/ui/use-mobile-viewport`). Pure layout, flips live with the
 *   media query. A narrow DESKTOP browser gets the mobile layout - correct,
 *   and it must NOT inherit mobile-app product behavior.
 * - "Is this the installed mobile app, as a product?" -> `isMobileApp()`
 *   (this file). Set once by the Capacitor entry before render, immutable
 *   afterwards - resizing can never flip it. UX-policy divergence only,
 *   e.g. the single-composer draft model.
 * - "Can this shell physically do X?" -> capability fields on `IRunnerHost`
 *   (e.g. `workspaceFolders.canPickNatively`). Abilities, not identity: a
 *   desktop browser also lacks a native folder dialog without being the
 *   mobile app.
 */

let mobileApp = false;

/**
 * Called exactly once, by the mobile (Capacitor) bundle's entry point,
 * before the first render. Tests may flip it back.
 */
export function setMobileApp(value: boolean): void {
  mobileApp = value;
}

export function isMobileApp(): boolean {
  return mobileApp;
}
