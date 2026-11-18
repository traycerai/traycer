import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import {
  PaneFocusProbeContext,
  PanePortalContainerContext,
  PaneSurfaceActivityContext,
  PaneVisibilityContext,
  usePanePortalHostPresentation,
} from "@/components/epic-tabs/pane-visibility-context";

/**
 * One generic focused-presentation boundary around EVERY top-level `TabSurface`
 * (Epic/Draft/History/Settings), not just the Epic pane. It publishes the pane's
 * `{ visible, focused }` activity to every consumer, plus a per-pane portal
 * container that pane-local kept-mounted portals (comment composer, artifact-
 * link editor, mention/hover popovers) render into.
 *
 * When the pane is unfocused the container is:
 *   - hidden (visibility) so it cannot cover a focused split partner,
 *   - `inert` so its kept-mounted portals cannot be tabbed into or clicked, and
 *   - actively blurred (an already-focused descendant keeps `document.active-
 *     Element` even under `inert`/`visibility:hidden` in Chrome, so keyboard
 *     would otherwise still target it).
 * Portals keep their typed state (no unmount). Those three are
 * `usePanePortalHostPresentation`, which the expanded artifact's own comment
 * host takes as well - its surface is in the top layer, out of this host's
 * reach, so it carries a host of its own under the same rules.
 *
 * Modal-family Radix primitives (Dialog/Popover/Select/Dropdown/Context) instead
 * un-present by unmounting their content when unfocused (the only way to drop
 * their document-wide `hideOthers`/scroll-lock reach). That unmount runs Radix's
 * close-autofocus, which would restore focus to the pane's trigger and bounce
 * activation back; `usePaneCloseAutoFocusGuard` reads `data-pane-focused` off
 * this boundary at unmount time and `preventDefault`s the restore.
 *
 * App-global hosts (command palette, global confirms, toasts/banners) live
 * OUTSIDE any pane, read the default-`true` activity, and portal to
 * `document.body` unchanged.
 */
export function SurfacePresentationBoundary(props: {
  readonly visible: boolean;
  readonly focused: boolean;
  readonly children: ReactNode;
}): ReactNode {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const probeRef = useRef<HTMLDivElement | null>(null);
  const isPaneFocused = useCallback(
    () => probeRef.current?.dataset.paneFocused === "true",
    [],
  );
  const activity = useMemo(
    () => ({ visible: props.visible, focused: props.focused }),
    [props.visible, props.focused],
  );

  // The concealment and the blur that goes with it, in one place: the expanded
  // artifact's comment host takes the same ones.
  const hostProps = usePanePortalHostPresentation(container, activity);

  return (
    <PaneFocusProbeContext.Provider value={isPaneFocused}>
      <PaneSurfaceActivityContext.Provider value={activity}>
        <PaneVisibilityContext.Provider value={props.visible}>
          <PanePortalContainerContext.Provider value={container}>
            <div
              ref={probeRef}
              data-pane-focused={props.focused ? "true" : "false"}
              className="contents"
            >
              {props.children}
            </div>
            <div
              ref={setContainer}
              data-slot="pane-portal-host"
              {...hostProps}
            />
          </PanePortalContainerContext.Provider>
        </PaneVisibilityContext.Provider>
      </PaneSurfaceActivityContext.Provider>
    </PaneFocusProbeContext.Provider>
  );
}
