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
}

/**
 * Owns the T04 focus/modality contract for the bell-anchored popover:
 * keyboard and programmatic opens move focus to the surface's heading;
 * pointer opens do not steal focus. Escape restores focus to the trigger;
 * every other close reason (successful activation, settings navigation,
 * outside click) leaves focus wherever the resulting action put it.
 *
 * The trigger/heading refs are owned by the caller (created via `useRef`
 * directly in the rendering component) and passed in - this hook only
 * returns event-handler callbacks, never refs, so the DOM nodes stay
 * directly traceable to their `useRef()` call sites.
 *
 * Trigger modality is captured on the trigger element itself (`pointerdown`
 * fires before `click`; a keyboard activation's `keydown` fires before the
 * synthesized click too), so it is always current by the time Radix's
 * `onOpenAutoFocus` reads it - then reset to the "programmatic" default so a
 * later open triggered from outside the trigger (e.g. a native-notification
 * bridge calling the store directly) is not attributed to a stale pointer/
 * keyboard flag from a previous open.
 */
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

  const onContentEscapeKeyDown = useCallback(() => {
    closeReasonRef.current = "escape";
  }, []);

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
  };
}
