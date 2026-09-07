import { useEffect, type RefObject } from "react";
import { handleNotificationFeedKeyboardNavigation } from "@/lib/notifications/notification-feed-keyboard-navigation";

/**
 * Native key listener on the shell, not a JSX `onKeyDown`. The container stays inert in the a11y tree; rows are the interactive widgets.
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
