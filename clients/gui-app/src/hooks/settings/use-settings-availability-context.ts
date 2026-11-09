import { useMemo } from "react";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import { getFeatureSettingsBridge } from "@/lib/desktop-feature-settings";
import { isMobileApp } from "@/lib/mobile-app";
import { soundtrackOffered } from "@/lib/soundtrack/manifest";
import { desktopRecordingChannel } from "@/lib/soundtrack/recording-bridge";
import type { SettingsAvailabilityContext } from "@/lib/settings/settings-availability";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";
import { useSettingsStore } from "@/stores/settings/settings-store";

/**
 * The shell facts every settings availability predicate reads, resolved the
 * same way for a panel and for the search box so the two can never disagree.
 *
 * `OrNull` because the search rail and several panels also render in
 * host-less shells, where "no bridges" is the true answer. The two window-level
 * facts - `isMobileApp()` and the feature-settings bridge - are read on every
 * render rather than held in a module constant, and the result is memoized on
 * their values so a consumer can key its own memo on the context.
 * `phoneLayout` and `soundtrackOn` are subscribed rather than read, because each
 * flips while the page is open and a row keyed on it must flip with it.
 */
export function useSettingsAvailabilityContext(): SettingsAvailabilityContext {
  const runnerHost = useRunnerHostOrNull();
  const featureSettings = getFeatureSettingsBridge();
  const mobileApp = isMobileApp();
  const phoneLayout = useIsMobileViewport();
  const offered = soundtrackOffered();
  const recordingOffered = desktopRecordingChannel() !== null;
  const soundtrackOn = useSettingsStore((state) => state.soundtrackEnabled);
  return useMemo(
    () => ({
      runnerHost,
      featureSettings,
      mobileApp,
      phoneLayout,
      soundtrackOffered: offered,
      soundtrackRecordingOffered: recordingOffered,
      soundtrackOn,
    }),
    [
      runnerHost,
      featureSettings,
      mobileApp,
      phoneLayout,
      offered,
      recordingOffered,
      soundtrackOn,
    ],
  );
}
