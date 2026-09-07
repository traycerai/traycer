import { useCallback, useRef, type KeyboardEvent, type RefObject } from "react";

type NotificationCenterOpenModality = "pointer" | "keyboard" | "programmatic";

export interface NotificationCenterOpenLifecycleInput {
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  readonly headingRef: RefObject<HTMLHeadingElement | null>;
}

export interface NotificationCenterOpenLifecycle {
  readonly onTriggerPointerDown: () => void;
  readonly onTriggerKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  readonly onContentOpenAutoFocus: (event: Event) => void;
  readonly onContentEscapeKeyDown: () => void;
  readonly onContentCloseAutoFocus: (event: Event) => void;
  /** Called by the keybinding chord when it toggles a center closed whose own surface currently holds focus - without it that focus would be destroyed with the popover and land on `<body>`. */
  readonly markKeyboardDismiss: () => void;
}

/** Capture modality on the trigger; reset to programmatic after so a later non-trigger open is not a stale pointer open.
 * Keyboard/programmatic open focuses the heading; pointer open does not steal focus. */
export function useNotificationCenterOpenLifecycle(
  input: NotificationCenterOpenLifecycleInput,
): NotificationCenterOpenLifecycle {
  const modalityRef = useRef<NotificationCenterOpenModality>("programmatic");
  const closeReasonRef = useRef<"escape" | "other">("other");

  const onTriggerPointerDown = useCallback(() => {
    modalityRef.current = "pointer";
  }, []);

  const onTriggerKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === "Enter" || event.key === " ") {
        modalityRef.current = "keyboard";
      }
    },
    [],
  );

  const onContentOpenAutoFocus = useCallback(
    (event: Event) => {
      event.preventDefault();
      const modality = modalityRef.current;
      modalityRef.current = "programmatic";
      if (modality !== "pointer") {
        input.headingRef.current?.focus();
      }
    },
    [input.headingRef],
  );

  const markKeyboardDismiss = useCallback(() => {
    closeReasonRef.current = "escape";
  }, []);

  const onContentEscapeKeyDown = markKeyboardDismiss;

  const onContentCloseAutoFocus = useCallback(
    (event: Event) => {
      event.preventDefault();
      if (closeReasonRef.current === "escape") {
        input.triggerRef.current?.focus();
      }
      closeReasonRef.current = "other";
    },
    [input.triggerRef],
  );

  return {
    onTriggerPointerDown,
    onTriggerKeyDown,
    onContentOpenAutoFocus,
    onContentEscapeKeyDown,
    onContentCloseAutoFocus,
    markKeyboardDismiss,
  };
}
