import { useMemo } from "react";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import { getFeatureSettingsBridge } from "@/lib/desktop-feature-settings";
import { isMobileApp } from "@/lib/mobile-app";
import type { SettingsAvailabilityContext } from "@/lib/settings/settings-availability";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";
import { useLayoutStore } from "@/stores/settings/layout-store";
import { useSettingsStore } from "@/stores/settings/settings-store";

/**
 * The shell facts every settings availability predicate reads, resolved the
 * same way for a panel and for the search box so the two can never disagree.
 *
 * `OrNull` because the search rail and several panels also render in
 * host-less shells, where "no bridges" is the true answer. The two window-level
 * facts — `isMobileApp()` and the feature-settings bridge — are read on every
 * render rather than held in a module constant, and the result is memoized on
 * their values so a consumer can key its own memo on the context.
 *
 * `mobileFooter` is the one SUBSCRIBED member, and the subscription is the
 * point: it decides whether the installed app's footer strip exists, so every
 * panel and the search box have to be re-asked the moment its switch flips.
 * Read through the store hook rather than `getState()` for exactly that
 * reason — a snapshot would freeze the answer until something else re-rendered
 * the consumer, and Settings is where the flip happens.
 *
 * `customizeEditor` is subscribed for the same reason and is the one member
 * that reads the WINDOW's width. The Customize editor replaces the Layout page
 * only on a desktop-width window (D22) — a narrow one keeps the full page
 * however the switch is set — so the availability question has no answer from
 * the switch alone. `useIsMobileViewport()` and not `isMobileApp()`: this is a
 * fact about the window, and a responsively-narrow desktop window must get the
 * same page a phone does. Do not read the viewport for any other member — the
 * rest of this context describes the shell, which resizing does not change.
 */
export function useSettingsAvailabilityContext(): SettingsAvailabilityContext {
  const runnerHost = useRunnerHostOrNull();
  const featureSettings = getFeatureSettingsBridge();
  const mobileApp = isMobileApp();
  const mobileFooter = useLayoutStore((state) => state.statusBar.mobileFooter);
  const visualLayoutEditorEnabled = useSettingsStore(
    (state) => state.visualLayoutEditorEnabled,
  );
  const narrowViewport = useIsMobileViewport();
  const customizeEditor = visualLayoutEditorEnabled && !narrowViewport;
  return useMemo(
    () => ({
      runnerHost,
      featureSettings,
      mobileApp,
      mobileFooter,
      customizeEditor,
    }),
    [runnerHost, featureSettings, mobileApp, mobileFooter, customizeEditor],
  );
}
