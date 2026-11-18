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

let phoneLayoutOnly = false;

/**
 * LAYOUT policy: "is this a bundle that ships only the phone layout?"
 *
 * A fourth signal, and deliberately not a synonym for the one above. The
 * installed app is a phone-layout product on every device, an iPad as much as
 * an iPhone, and its stylesheet disables every Tailwind breakpoint to match
 * (`clients/mobile/src/web/index.native.css`). This flag is how JS agrees
 * with that CSS, so `useIsMobileViewport()` reads it and `isMobileApp()`
 * keeps deciding no layout at all.
 *
 * The mobile entry sets both from `Capacitor.isNativePlatform()`, because it
 * is served to TWO runtimes: the installed Capacitor app, and a plain browser
 * tab, which the internal launcher serves as its `gui-app` dev stream. That
 * tab gets neither flag - it is not the product, and it loads the stylesheet
 * with the real breakpoints, so width decides its layout like any other
 * window. Keep the two flags apart all the same: a surface that is phone-only
 * without being the installed app, or the reverse, must not have to lie to one
 * to get the other.
 */
export function setPhoneLayoutOnly(value: boolean): void {
  phoneLayoutOnly = value;
}

export function isPhoneLayoutOnly(): boolean {
  return phoneLayoutOnly;
}

/** The native shells the installed app ships in. */
export type MobileAppPlatform = "ios" | "android";

let mobileAppPlatform: MobileAppPlatform | null = null;

/**
 * WHICH native shell this installed app is, set alongside `setMobileApp` by
 * the Capacitor entry and `null` everywhere else - including the mobile
 * stream's dev browser tab, which is native to neither store.
 *
 * Same discipline as the flag above: product copy that must name the right
 * update channel (TestFlight / the App Store vs Google Play) reads this;
 * layout reads the viewport and capabilities read `IRunnerHost`. A `null`
 * platform is answered with store-neutral copy, never a guess.
 */
export function setMobileAppPlatform(value: MobileAppPlatform | null): void {
  mobileAppPlatform = value;
}

export function getMobileAppPlatform(): MobileAppPlatform | null {
  return mobileAppPlatform;
}
