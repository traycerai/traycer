import type { LayoutArrangement } from "@/lib/layout/layout-arrangement";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import { useLayoutStore } from "@/stores/layout/layout-store";

/**
 * Every arrangement write, as ONE recorded gesture.
 *
 * The one writer every section shares - the inspector's rows, the canvas's
 * drag, the rail's own "Move sidebar to..." item (S-32, `rail-view.ts`'s
 * `setSidebarSide`) - so a write that skipped `recordGesture` would be a
 * change the undo stack never saw, invisible until someone pressed undo and
 * the wrong thing moved. It is also what makes a whole drag one step: the
 * reflow is paint, and the drop calls this exactly once.
 *
 * Lives in `lib/layout/`, not beside the editor's own component code
 * (`components/layout-editor/layout-gestures.ts`), because the rail's
 * writers are a `lib/` module and cannot import from a component module;
 * `layout-gestures.ts` imports this the same way every other caller does.
 */
export function writeArrangement(arrangement: LayoutArrangement): void {
  useLayoutEditorStore.getState().recordGesture(() => {
    useLayoutStore.getState().setArrangement(arrangement);
  });
}

/**
 * One arrangement field, written against the arrangement as it is NOW. The
 * surface placements' one writer: the dock's rows, the canvas's placement bar
 * and its drop to an edge all call this, so the three can never write the
 * same pick two ways (D14).
 */
export function writeArrangementField<K extends keyof LayoutArrangement>(
  key: K,
  value: LayoutArrangement[K],
): void {
  writeArrangement({ ...useLayoutStore.getState().arrangement, [key]: value });
}
