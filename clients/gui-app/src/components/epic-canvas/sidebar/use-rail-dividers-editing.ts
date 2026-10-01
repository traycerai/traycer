import { usePaneVisible } from "@/components/epic-tabs/pane-visibility-context";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";

/**
 * Whether THIS rail's dividers are live handles right now.
 *
 * One gate, asked once per rail rather than once per divider, and it is the
 * same gate `useLayoutRegion` applies to a region's drag attributes: a
 * session, and the pane this rail is in being the visible one (L-109, R3-06).
 * A retained background epic tab keeps its rail mounted, and without the
 * visibility half its dividers would answer `[data-layout-group="rail"]` for
 * the duration of every session - a second set of members the editor does not
 * own.
 *
 * Its own module rather than a second export beside `LeftPanelRailDivider`, so
 * the component file stays a component file.
 */
export function useRailDividersEditing(): boolean {
  const session = useLayoutEditorStore((state) => state.session !== null);
  const visible = usePaneVisible();
  return session && visible;
}
