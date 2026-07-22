import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  PaneFocusProbeContext,
  PanePortalContainerContext,
  PaneSurfaceActivityContext,
  PaneVisibilityContext,
  runPresentationLossBlur,
} from "@/components/epic-tabs/pane-visibility-context";

const CONTENTS_STYLE: CSSProperties = { display: "contents" };
const HIDDEN_CONTAINER_STYLE: CSSProperties = {
  visibility: "hidden",
  pointerEvents: "none",
};

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
 * Portals keep their typed state (no unmount).
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

  // An already-focused descendant of the portal host keeps DOM focus even after
  // the host is hidden + made inert (Chrome does not blur on hide/inert), so
  // keyboard would still target the background pane. Blur it explicitly, without
  // unmounting (typed draft state survives). The blur runs under
  // `runPresentationLossBlur` so a blur-as-commit consumer (e.g. the artifact-
  // link editor) can tell this synthetic relinquish-blur from a real user blur
  // and NOT commit/close/refocus — otherwise backgrounding would destroy its
  // in-progress draft.
  useEffect(() => {
    if (props.focused) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && container?.contains(active)) {
      runPresentationLossBlur(() => active.blur());
    }
  }, [props.focused, container]);

  return (
    <PaneFocusProbeContext.Provider value={isPaneFocused}>
      <PaneSurfaceActivityContext.Provider value={activity}>
        <PaneVisibilityContext.Provider value={props.visible}>
          <PanePortalContainerContext.Provider value={container}>
            <div
              ref={probeRef}
              data-pane-focused={props.focused ? "true" : "false"}
              style={CONTENTS_STYLE}
            >
              {props.children}
            </div>
            <div
              ref={setContainer}
              data-slot="pane-portal-host"
              aria-hidden={!props.focused}
              inert={!props.focused}
              hidden={!props.visible}
              style={props.focused ? undefined : HIDDEN_CONTAINER_STYLE}
            />
          </PanePortalContainerContext.Provider>
        </PaneVisibilityContext.Provider>
      </PaneSurfaceActivityContext.Provider>
    </PaneFocusProbeContext.Provider>
  );
}
