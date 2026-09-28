import { LAYOUT_MEMBER_ATTRIBUTE } from "@/components/layout-editor/canvas/canvas-attributes";
import { cn } from "@/lib/utils";

/**
 * A divider in the rail: a gap at rest, a handle while the user is customizing
 * (L-140, L-155).
 *
 * At rest it draws no line, no box and no name - but it is NOT nothing. A
 * divider the user added has to be visible as what it is, and what it is is
 * space: this adds the rail's own `gap-1` again between the icons on either
 * side of it, so two icons a divider separates sit three gaps apart instead of
 * one. A user who never opens the editor and has added none sees the rail they
 * always had, since the rail then holds no dividers to draw (R3-04).
 *
 * In a session it becomes the thing the user grabs: a short lit rule, and the
 * member attributes a canvas drop places by. `editing` is passed in rather
 * than read here so the gate is asked once per rail rather than once per
 * divider (see {@link useRailDividersEditing}).
 *
 * One component for both rails - the epic sidebar's and the sample
 * workspace's - because it draws the same fact about `arrangement.rail` in
 * both.
 *
 * It is a member of the rail's order without being a region, so it carries the
 * member id the drop places by rather than a `data-layout-region`. A region's
 * NAME outlives the session (L-129); a divider has none to outlive it with,
 * which is why the app at rest can see nothing here but the space.
 */
export function LeftPanelRailDivider(props: {
  readonly dividerId: string;
  readonly orientation: "vertical" | "horizontal";
  readonly editing: boolean;
}) {
  const { dividerId, orientation, editing } = props;
  if (!editing) {
    return (
      <div
        aria-hidden
        data-testid="epic-rail-divider"
        data-rail-divider-resting
        className={cn(
          "pointer-events-none shrink-0",
          orientation === "vertical" ? "h-1 w-full" : "h-full w-1",
        )}
      />
    );
  }
  return (
    <div
      aria-hidden
      data-testid="epic-rail-divider"
      {...{ [LAYOUT_MEMBER_ATTRIBUTE]: dividerId }}
      data-layout-group="rail"
      data-layout-draggable="1"
      // No grab cursor here: `layout-editor.css` puts it on every
      // `[data-layout-draggable]` inside an editing column, which is the one
      // place a region's own grab cursor comes from too.
      className={cn(
        "flex shrink-0 items-center justify-center",
        orientation === "vertical" ? "h-2 w-full" : "h-full w-2",
      )}
    >
      {/* The prototype's `.rail-div i` at the app's own scale: a short rule,
        lit rather than hairline, so it reads as something to pick up next to
        the icons it spaces apart. */}
      <span
        className={cn(
          "rounded-full bg-muted-foreground/50",
          orientation === "vertical" ? "h-0.5 w-5" : "h-5 w-0.5",
        )}
      />
    </div>
  );
}
