import { useEffect } from "react";
import { ignoreError } from "@/lib/browser-view/ignore-error";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useSettingsStore } from "@/stores/settings/settings-store";

export function BrowserLabsMarkerSync() {
  const runnerHost = useRunnerHost();
  const browserView = runnerHost.browserView;

  useEffect(() => {
    if (browserView === null) return;

    const sync = (inAppBrowserBetaEnabled: boolean): void => {
      void browserView
        .setLabsState({ inAppBrowserBetaEnabled })
        .catch(ignoreError);
    };

    sync(useSettingsStore.getState().inAppBrowserBetaEnabled);
    const unsubscribeStore = useSettingsStore.subscribe((state, prevState) => {
      if (state.inAppBrowserBetaEnabled === prevState.inAppBrowserBetaEnabled) {
        return;
      }
      sync(state.inAppBrowserBetaEnabled);
    });
    const unsubscribeHydration = useSettingsStore.persist.onFinishHydration(
      (state) => {
        sync(state.inAppBrowserBetaEnabled);
      },
    );

    return () => {
      unsubscribeStore();
      unsubscribeHydration();
    };
  }, [browserView]);

  return null;
}
