import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import { useEffect, type ReactNode } from "react";
import { useCustomizeStore } from "@/stores/customize/customize-store";
import { SampleSceneContext } from "./sample-scene-context";
/** Covers the real shell as well as the sample body. */
export function SampleSceneProvider({
  children,
}: {
  readonly children: ReactNode;
}) {
  const enabled = useSettingsStore((state) => state.visualLayoutEditorEnabled);
  const mobile = useIsMobileViewport();
  useEffect(() => {
    if (!enabled || mobile)
      tabCommandCoordinator.closeRefAfterConfirmed({
        kind: "sample-workspace",
        id: "sample-workspace",
      });
  }, [enabled, mobile]);
  const sample = useCustomizeStore(
    (state) => state.session?.scene === "sample",
  );
  return (
    <SampleSceneContext.Provider value={sample}>
      {children}
    </SampleSceneContext.Provider>
  );
}
