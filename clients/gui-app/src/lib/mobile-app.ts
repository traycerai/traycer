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
 *   (e.g. `workspaceFolders.canPickNatively`, `hasLocalHost`, the duck-typed
 *   desktop bridges). Abilities, not identity: a desktop browser also lacks a
 *   native folder dialog without being the mobile app. A gate that means "this
 *   shell cannot keep the promise this UI makes" belongs here, NOT on the
 *   product flag - dictation and prevent-sleep both keyed on the flag while
 *   the phone was the only shell without the ability, and both mis-offered the
 *   moment a browser shell existed.
 *
 * Which shell it IS, for telemetry, is a fourth question none of the three can
 * answer - the browser app and the in-browser dev loop are identical on every
 * one of them. That answer is DECLARED by the shell's bootstrap
 * (`setAnalyticsAppSurface` in `lib/analytics.ts`); it is a reporting label
 * only and must never become a gate.
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
