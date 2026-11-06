import { useMobileHeaderActive } from "@/components/layout/header/use-mobile-header-active";
import { soundtrackOffered } from "@/lib/soundtrack/manifest";

/**
 * Whether the top row has anything to carry: the soundtrack's toggle, in a
 * build with something to play. Nothing otherwise, so a window without it
 * gives up no height and no tab width for it. The phone has no soundtrack
 * yet. Decided as the header decides it, not by width: a zoomed desktop window
 * narrower than the phone breakpoint keeps its desktop chrome, so it keeps
 * this row.
 */
export function useSoundtrackTopRowDrawn(): boolean {
  const phoneLayout = useMobileHeaderActive();
  return soundtrackOffered() && !phoneLayout;
}
