import { useEffect, type RefObject } from "react";
import { handleNotificationFeedKeyboardNavigation } from "@/lib/notifications/notification-feed-keyboard-navigation";

/**
 * Binds feed traversal (Up/Down/Home/End) to the notification center's shell.
 *
 * Attached natively rather than through a JSX `onKeyDown`: the shell is a
 * layout container, and hanging a key handler on it as a prop makes it a
 * static element with interactions - a genuine a11y smell for anything that
 * IS an interactive widget, and the wrong shape here, where the interactive
 * things are the rows the traversal moves focus between. Listening on the
 * element keeps the container inert in the accessibility tree while still
 * catching keys from anywhere inside the surface.
 */
export function useNotificationFeedKeyboardNavigation(
  shellRef: RefObject<HTMLDivElement | null>,
): void {
  useEffect(() => {
    const shell = shellRef.current;
    if (shell === null) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      handleNotificationFeedKeyboardNavigation(shell, event);
    };
    shell.addEventListener("keydown", onKeyDown);
    return () => shell.removeEventListener("keydown", onKeyDown);
  }, [shellRef]);
}
