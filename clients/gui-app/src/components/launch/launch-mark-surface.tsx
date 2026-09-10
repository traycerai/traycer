import type { ReactNode } from "react";
import { BrandEntrance } from "@/components/auth/brand-entrance";
import { useLaunchMark } from "@/hooks/launch/use-launch-mark";
import { cn } from "@/lib/utils";
import "@/styles/auth-arrival.css";

/**
 * The one mark a launch shows, from the first React frame until the app is
 * ready to be looked at.
 *
 * MOUNTED ABOVE `HostRuntimeProvider`, and that placement is the whole point.
 * The provider swaps its fallback for its children when the binding arrives,
 * and the router swaps the sign-in page in after that - two remounts. Anything
 * rendered inside either of them is a DIFFERENT element on each side of the
 * swap, which is what made a launch read as three surfaces: a mark on the boot
 * card, then a mark on the splash, then the sign-in page's own. From up here it
 * is one element with one clock, and the swaps happen underneath it.
 *
 * `fixed inset-0`, so it covers regardless of what the tree below is doing, and
 * on the same dark ground the sign-in page uses so the crossfade has nothing to
 * travel over.
 *
 * No text, in any phase. The copy that used to be here ("Starting Traycer…")
 * belongs to the host boot card, which says it when a host really is starting -
 * and which takes this screen back if a launch stalls.
 */
export function LaunchMarkSurface(): ReactNode {
  const phase = useLaunchMark();
  if (phase === "done") return null;

  return (
    <div
      data-testid="launch-mark-surface"
      data-phase={phase}
      aria-hidden="true"
      className={cn(
        // `text-white` is load-bearing, not decoration: the mark's paths are
        // `fill="currentColor"`, and the sign-in page it crossfades into sets
        // the same colour on the same ground. Inheriting whatever the theme
        // happened to provide would make the mark change shade at the handoff.
        "fixed inset-0 z-50 flex items-center justify-center bg-zinc-950 text-white",
        // Input passes through only while the mark is LEAVING. During the hold
        // the page underneath is invisible, and letting a tap through would
        // fire a control the user cannot see; during the crossfade the page is
        // visibly arriving, so swallowing the tap is the wrong half of the
        // trade. Scoped to the fade for that reason rather than applied
        // throughout.
        phase === "exit" && "launch-mark-exit pointer-events-none",
      )}
    >
      <div className="launch-mark-settle">
        <BrandEntrance size="hero">{null}</BrandEntrance>
      </div>
    </div>
  );
}
