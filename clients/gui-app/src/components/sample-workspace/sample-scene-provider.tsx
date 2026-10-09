import { useLayoutEditorFitsWindow } from "@/lib/layout/editor-width";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import { useEffect, type ReactNode } from "react";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import { TooltipsSuppressedProvider } from "@/components/ui/tooltip-wrapper";
import { SampleSceneContext } from "./sample-scene-context";
/** Covers the real shell as well as the sample body. */
export function SampleSceneProvider({
  children,
}: {
  readonly children: ReactNode;
}) {
  // The sample workspace is a desktop-width scene: below the editor's width
  // threshold the full-width Layout page is the form, so a sample tab left
  // open on a narrow window has nothing to be a canvas for. The SAME threshold
  // the door and the session watcher read (L-64), never a second breakpoint.
  const fits = useLayoutEditorFitsWindow();
  useEffect(() => {
    if (!fits)
      tabCommandCoordinator.closeRefAfterConfirmed({
        kind: "sample-workspace",
        id: "sample-workspace",
      });
  }, [fits]);
  // A live session IS the sample scene (L-87): the tab and the session have
  // one lifetime, so there is no second thing to ask about.
  const sample = useLayoutEditorStore((state) => state.session !== null);
  return (
    <SampleSceneContext.Provider value={sample}>
      {/* The shell under a live session is being shown, not used, so its own
          hover labels must not open over the canvas - see the wrapper's own
          comment. Published here rather than around the sample BODY because
          the canvas is the whole column: the status bar's segments, the tab
          strip and the sidebar rail are regions too, and they are outside that
          body. The inspector republishes `false` for itself; it is the
          instrument, not the picture. */}
      <TooltipsSuppressedProvider value={sample}>
        {children}
      </TooltipsSuppressedProvider>
    </SampleSceneContext.Provider>
  );
}
