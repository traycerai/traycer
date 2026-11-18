import type { MobileAppPlatform } from "@/lib/mobile-app";

/** Null is a dev browser tab, which belongs to neither mobile store. */
export function mobileStoreUpdateNote(
  platform: MobileAppPlatform | null,
): string {
  if (platform === "ios") {
    return "Update the Traycer app in TestFlight or the App Store, then reopen it.";
  }
  if (platform === "android") {
    return "Update the Traycer app in Google Play, then reopen it.";
  }
  return "Update the Traycer app from the store you installed it from, then reopen it.";
}
