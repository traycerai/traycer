import { Info } from "lucide-react";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import { SampleWorkspaceBody } from "./sample-workspace-body";
import { SampleStripLiveAgents } from "./sample-strip-live-agents";
import { useEffect } from "react";
import { useTabsStore } from "@/stores/tabs/store";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";

// A window has one canonical sample tab; a replacement mount takes ownership.
let activationGeneration = 0;

/**
 * The editor's canvas (L-87), which exists only for a live session.
 *
 * The editor's one door opens this tab; this surface owns the other end of
 * that lifetime. Closing the tab ends the session, and a session that ended
 * elsewhere (Done, Discard, a lost lease) closes the tab - so the two can
 * never be left disagreeing about whether the editor is open.
 *
 * The width threshold is NOT read here: `SampleSceneProvider` covers the real
 * shell as well as this body, and closes the tab on a narrow window.
 */
export function SampleWorkspaceSurface({ tabId }: { readonly tabId: string }) {
  const active = useTabsStore(
    (state) => state.activeItemId === `tab:sample-workspace:${tabId}`,
  );
  useEffect(() => {
    const generation = ++activationGeneration;
    if (!active) return;
    const session = useLayoutEditorStore.getState().session;
    return () => {
      // StrictMode immediately sets up the same activation again. A real
      // unmount has no next setup and releases ownership in this microtask.
      queueMicrotask(() => {
        if (
          activationGeneration === generation &&
          session !== null &&
          useLayoutEditorStore.getState().session === session
        )
          useLayoutEditorStore.getState().endSession();
      });
    };
  }, [active]);
  useEffect(() => {
    const closeWithoutSession = (): void => {
      if (useLayoutEditorStore.getState().session !== null) return;
      tabCommandCoordinator.closeRefAfterConfirmed({
        kind: "sample-workspace",
        id: tabId,
      });
    };
    return useLayoutEditorStore.subscribe(closeWithoutSession);
  }, [tabId]);
  return (
    <div className="flex h-full min-h-0 flex-col" data-sample-workspace>
      {/* The sample notice: the third half of the amber signal with the
          Customizing tab and the frame (design craft 2.3). Not dimmed, for the
          same reason the tab is not. */}
      <div
        data-sample-notice
        className="flex h-7 shrink-0 items-center justify-between gap-3 border-b border-warning-foreground/40 bg-warning-foreground/14 px-3 text-ui-xs font-medium text-warning-foreground"
      >
        <span className="flex min-w-0 items-center gap-2">
          <Info aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate">
            Sample workspace. Changes apply to your layout.
          </span>
        </span>
        <span className="truncate font-normal opacity-80">
          Point at any part of the app to change it.
        </span>
      </div>
      <SampleWorkspaceBody />
      <SampleStripLiveAgents tabId={tabId} />
    </div>
  );
}
