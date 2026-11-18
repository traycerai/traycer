/**
 * Page editing conventions follow the character, unlike configurable app
 * bindings, which follow the physical code. History must reach the focused
 * editor even when its Z key occupies a reserved app shortcut's position.
 */
export function isTextHistoryShortcut(
  event: {
    readonly key: string;
    readonly ctrlKey: boolean;
    readonly metaKey: boolean;
    readonly shiftKey: boolean;
    readonly altKey: boolean;
  },
  isMac: boolean,
): boolean {
  if (event.altKey) return false;
  if (
    isMac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey
  ) {
    return false;
  }
  const key = event.key.toLowerCase();
  return key === "z" || (!isMac && key === "y" && !event.shiftKey);
}
