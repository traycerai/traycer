import { useEffect, useLayoutEffect, useRef } from "react";

type PrimaryActionGetter = () => () => void;

// Window-scoped primary actions are stacked so a newer overlay owns the chord
// without also firing an older surface underneath it. The action itself stays
// behind a ref: changing form state must not move an older owner back to the
// top of the stack.
const ownerStack: PrimaryActionGetter[] = [];
let listenerInstalled = false;

function isPrimaryActionShortcut(event: KeyboardEvent): boolean {
  return (
    event.key === "Enter" &&
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey
  );
}

function handleKeyDown(event: KeyboardEvent): void {
  if (!isPrimaryActionShortcut(event)) return;
  const owner = ownerStack.at(-1);
  if (owner === undefined) return;

  // Claim the chord even when the primary action is currently gated. This
  // mirrors a disabled button and prevents the shortcut from reaching a
  // composer or terminal underneath the active overlay.
  event.preventDefault();
  event.stopPropagation();
  if (event.repeat || event.isComposing) return;
  owner()();
}

function installListener(): void {
  if (listenerInstalled) return;
  window.addEventListener("keydown", handleKeyDown, { capture: true });
  listenerInstalled = true;
}

function removeListener(): void {
  if (!listenerInstalled) return;
  window.removeEventListener("keydown", handleKeyDown, { capture: true });
  listenerInstalled = false;
}

/**
 * Gives the active surface ownership of Cmd/Ctrl+Enter. The latest active
 * owner wins, matching the visual stacking order of dialogs and popovers.
 * Callers pass the same guarded callback used by their primary button.
 */
export function usePrimaryActionShortcut(
  active: boolean,
  action: () => void,
): void {
  const actionRef = useRef(action);
  useLayoutEffect(() => {
    actionRef.current = action;
  }, [action]);

  useEffect(() => {
    if (!active) return;
    const getter: PrimaryActionGetter = () => actionRef.current;
    ownerStack.push(getter);
    installListener();
    return () => {
      const index = ownerStack.lastIndexOf(getter);
      if (index >= 0) ownerStack.splice(index, 1);
      if (ownerStack.length === 0) removeListener();
    };
  }, [active]);
}
