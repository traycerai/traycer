import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

/**
 * Shared opening path for the sidebar's more and add-child dropdowns.
 *
 * `disabled` closes a menu that is open when its trigger becomes disabled. The
 * disabled trigger renders without the Radix root, so nothing else resets
 * `open`, and enabling the trigger again would reopen the menu with no gesture.
 */
export function useSidebarRowDropdownMount(disabled: boolean) {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  if (disabled && open) setOpen(false);
  const triggerId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const replayKeyRef = useRef<string | null>(null);
  // A PASSIVE effect, after the Radix menu root's own: its document keydown
  // listener is what marks the open as keyboard-driven, which is what moves
  // focus to the first item. A key pressed before the root existed never
  // reached it, so the key is replayed on the new trigger once it does.
  useEffect(() => {
    if (!mounted || replayKeyRef.current === null) return;
    const key = replayKeyRef.current;
    replayKeyRef.current = null;
    triggerRef.current?.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, [mounted]);
  const openFirstTime = (): void => {
    setMounted(true);
    setOpen(true);
  };
  const onPointerDown = (event: PointerEvent<HTMLButtonElement>): void => {
    if (mounted || event.button !== 0 || event.ctrlKey) return;
    event.preventDefault();
    openFirstTime();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (mounted || !["Enter", " ", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    replayKeyRef.current = event.key;
    setMounted(true);
  };
  const onClick = (): void => {
    // Assistive activations and test helpers can issue click alone.
    if (!mounted) openFirstTime();
  };
  return {
    mounted,
    open,
    setOpen,
    // Spread onto the trigger. Radix's trigger sets its own id once mounted,
    // and the menu's aria-labelledby names that one. Slot lets a child prop
    // win, so ours - even an `id: undefined` - would replace it: it is absent.
    triggerIdProps: mounted ? {} : { id: triggerId },
    triggerRef,
    onPointerDown,
    onKeyDown,
    onClick,
  };
}
