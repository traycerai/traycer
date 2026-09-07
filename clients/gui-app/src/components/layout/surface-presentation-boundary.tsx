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

/** That unmount runs Radix's close-autofocus, which would restore focus to the pane's trigger and bounce
 * activation back. */
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

  // An already-focused descendant of the portal host keeps DOM focus even after the host is hidden + made inert
  // (Chrome does not blur on hide/inert), so keyboard would still target the background pane.
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
