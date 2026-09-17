import { useMemo } from "react";
import { getFeatureSettingsBridge } from "@/lib/desktop-feature-settings";
import { isMobileApp } from "@/lib/mobile-app";
import type { SettingsAvailabilityContext } from "@/lib/settings/settings-availability";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";
import { useLayoutStore } from "@/stores/settings/layout-store";

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
 */
export function useSettingsAvailabilityContext(): SettingsAvailabilityContext {
  const runnerHost = useRunnerHostOrNull();
  const featureSettings = getFeatureSettingsBridge();
  const mobileApp = isMobileApp();
  const mobileFooter = useLayoutStore((state) => state.statusBar.mobileFooter);
  return useMemo(
    () => ({ runnerHost, featureSettings, mobileApp, mobileFooter }),
    [runnerHost, featureSettings, mobileApp, mobileFooter],
  );
}
