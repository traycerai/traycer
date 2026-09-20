import { useSettingsStore } from "@/stores/settings/settings-store";
import { isMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import { SampleWorkspaceBody } from "./sample-workspace-body";
import { useEffect } from "react";
import {
  enterCustomize,
  exitCustomize,
  getSampleWorkspaceOpener,
} from "@/lib/customize/enter-exit";
import { useTabsStore } from "@/stores/tabs/store";
import { useCustomizeStore } from "@/stores/customize/customize-store";

// A window has one canonical sample tab; a replacement mount takes ownership.
let activationGeneration = 0;

export function SampleWorkspaceSurface({ tabId }: { readonly tabId: string }) {
  const active = useTabsStore(
    (state) => state.activeItemId === `tab:sample-workspace:${tabId}`,
  );
  useEffect(() => {
    const generation = ++activationGeneration;
    if (!active) return;
    enterCustomize({
      scene: "sample",
      opener: getSampleWorkspaceOpener(),
      target: null,
    });
    const session = useCustomizeStore.getState().session;
    return () => {
      // StrictMode immediately sets up the same activation again. A real
      // unmount has no next setup and releases ownership in this microtask.
      queueMicrotask(() => {
        if (
          activationGeneration === generation &&
          session?.scene === "sample" &&
          useCustomizeStore.getState().session === session
        )
          exitCustomize("studio-closed");
      });
    };
  }, [active]);
  useEffect(() => {
    const closeIfUnavailable = () => {
      if (
        useSettingsStore.getState().visualLayoutEditorEnabled &&
        !isMobileViewport()
      )
        return;
      if (useCustomizeStore.getState().session?.scene === "sample")
        exitCustomize(isMobileViewport() ? "below-md" : "switch-off");
      tabCommandCoordinator.closeRefAfterConfirmed({
        kind: "sample-workspace",
        id: tabId,
      });
    };
    const unsubscribe = useSettingsStore.subscribe(closeIfUnavailable);
    window.addEventListener("resize", closeIfUnavailable);
    closeIfUnavailable();
    return () => {
      unsubscribe();
      window.removeEventListener("resize", closeIfUnavailable);
    };
  }, [tabId]);
  return (
    <div className="flex h-full min-h-0 flex-col" data-sample-workspace>
      <p className="shrink-0 border-b px-4 py-2 text-ui-sm text-muted-foreground">
        Sample content. Changes apply to your layout.
      </p>
      <SampleWorkspaceBody />
    </div>
  );
}
