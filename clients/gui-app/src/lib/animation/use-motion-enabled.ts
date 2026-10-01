import { usePaneVisible } from "@/components/epic-tabs/pane-visibility-context";
import { useReducedMotion } from "@/lib/animation/status-animation-clock";
import { useThemeLibraryStore } from "@/stores/settings/theme-library-store";

/**
 * The one gate a transient, React-rendered animation asks before it runs.
 *
 * The app states "no motion" in three independent places and, until now, no
 * React consumer read all three:
 *
 * 1. The OS query, through the live `useReducedMotion` on the shared status
 *    clock - not `motion/react`'s hook of the same name, which is the media
 *    query alone and is what left `AnimatedPinnedInteger` animating the
 *    context-usage number with the app's own switch turned off.
 * 2. The app's own "Panel animations" switch (`theme-library-store`), which
 *    `theme-applier.ts` mirrors onto `<html data-reduce-panel-motion>` for
 *    the stylesheet and which `usePanelAnimationDuration` and
 *    `lib/layout/editor-motion.ts` already combine with the OS query. This
 *    hook is the boolean form of the same pairing: the duration hook answers
 *    "how long", which a slider can legitimately set to 0, and cannot say
 *    whether motion is wanted at all.
 * 3. Pane visibility. `TopLevelTabHost` keeps inactive tabs mounted under
 *    `display: none`, and an animation in a pane that cannot paint is the
 *    exact always-on cost `status-animation-clock.ts` exists to avoid.
 *
 * This is a gate, not a duration: a caller that needs the panel duration
 * still reads `usePanelAnimationDuration`.
 */
export function useMotionEnabled(): boolean {
  const reducedMotion = useReducedMotion();
  const panelAnimations = useThemeLibraryStore(
    (state) => state.panelAnimations,
  );
  const paneVisible = usePaneVisible();
  return !reducedMotion && panelAnimations && paneVisible;
}
