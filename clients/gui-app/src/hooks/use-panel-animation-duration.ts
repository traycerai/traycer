import { useReducedMotion } from "@/lib/animation/status-animation-clock";
import { useThemeLibraryStore } from "@/stores/settings/theme-library-store";

/** Effective panel duration in milliseconds, matching the shared CSS surface rule. */
export function usePanelAnimationDuration(): number {
  const reducedMotion = useReducedMotion();
  const duration = useThemeLibraryStore((state) =>
    state.panelAnimations ? state.panelAnimationDuration : 0,
  );
  return reducedMotion ? 0 : duration;
}
