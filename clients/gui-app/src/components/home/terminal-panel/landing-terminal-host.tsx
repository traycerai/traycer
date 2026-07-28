import { useLandingTerminalStore } from "@/stores/home/landing-terminal-store";
import { useTabsStore } from "@/stores/tabs/store";
import {
  selectHostActiveSurfaceRefs,
  selectHostFocusedRef,
} from "@/stores/tabs/selectors";
import { LandingTerminalPanel } from "./landing-terminal-panel";
import { LandingTerminalGestureProvider } from "./landing-terminal-gesture-provider";

/**
 * The one landing-terminal mount for this window. Draft slots project their
 * focused draft (or visible draft partner) into this existing subsystem. The
 * gesture provider is the single reader of live host/client/folder state; the
 * panel below consumes only the projected target.
 */
export function LandingTerminalHost() {
  const draftId = useTabsStore((state) => {
    const focused = selectHostFocusedRef(state);
    if (focused?.kind === "draft") return focused.id;
    return (
      selectHostActiveSurfaceRefs(state).find((ref) => ref.kind === "draft")
        ?.id ?? null
    );
  });
  const panelOpen = useLandingTerminalStore((state) => state.panelOpen);

  if (draftId === null && !panelOpen) return null;
  return (
    <LandingTerminalGestureProvider draftId={draftId}>
      <LandingTerminalPanel />
    </LandingTerminalGestureProvider>
  );
}
