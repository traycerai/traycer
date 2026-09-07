/**
 * PRODUCT signal: "is this the installed Traycer mobile app?" (the Capacitor bundle) - as opposed to Electron desktop or a plain browser tab.
 */

let mobileApp = false;

/**
 * Called exactly once, by the mobile (Capacitor) bundle's entry point, before the first render.
 * Tests may flip it back.
 */
export function setMobileApp(value: boolean): void {
  mobileApp = value;
}

export function isMobileApp(): boolean {
  return mobileApp;
}

/** The native shells the installed app ships in. */
export type MobileAppPlatform = "ios" | "android";

let mobileAppPlatform: MobileAppPlatform | null = null;

/**
 * WHICH native shell this installed app is, set alongside `setMobileApp` by the Capacitor entry and `null` everywhere else - including the mobile stream's dev browser tab, which is native to neither store.
 */
export function setMobileAppPlatform(value: MobileAppPlatform | null): void {
  mobileAppPlatform = value;
}

export function getMobileAppPlatform(): MobileAppPlatform | null {
  return mobileAppPlatform;
}
