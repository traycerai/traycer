/**
 * Marks an element that opens an app right-click menu of its own from inside
 * a wider one. The layout menus around the chrome stand down for links and
 * selections by stopping the event before React sees it, so the OS menu can
 * show; without this mark they would starve the inner menu the same way.
 */
export const NESTED_CONTEXT_MENU_PROPS = {
  "data-nested-context-menu": "",
} as const;

export function opensNestedContextMenu(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest("[data-nested-context-menu]") !== null
  );
}
