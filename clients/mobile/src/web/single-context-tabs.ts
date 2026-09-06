import { Capacitor } from "@capacitor/core";
import { suppressTabsLocalRestore } from "@/stores/tabs/tabs-local-restore-policy";

/**
 * Declares, before anything else in this bundle runs, whether this shell may
 * restore a persisted tab layout.
 *
 * Platform-derived, like every other browser-vs-native difference this entry
 * settles. An installed app is alone on the screen, owns its whole origin, and
 * a cold launch restoring the arrangement it was last left in is exactly what
 * a person expects - so it keeps the restore. The same bundle opened as a
 * browser TAB does not: its contexts come from the tab bar around it, and a
 * layout persisted per ORIGIN would hand a freshly opened tab the surface of a
 * different one.
 *
 * THE ORDER IS THE MECHANISM. The tab store rehydrates from `localStorage`
 * while its module is being evaluated - before a component mounts, before an
 * effect runs - so a shell that says this any later has already had the read
 * happen behind it. Modules evaluate in import order, so this file must stay
 * the FIRST import of the entry, ahead of anything that reaches the shared
 * renderer.
 *
 * `@capacitor/core` is safe to reach for from here precisely because it is a
 * leaf as far as this app is concerned: its only dependency is `tslib`, so
 * importing it cannot pull the store in ahead of the decision below.
 */
if (!Capacitor.isNativePlatform()) {
  suppressTabsLocalRestore();
}
