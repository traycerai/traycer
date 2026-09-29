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
 * The menu root mounts on first use. A pointer's first open happens on the
 * CLICK, never the pointerdown: Base's trigger toggles on click, so a menu
 * opened on the pointerdown would be closed again by the click that follows
 * it, once the root had mounted in between.
 *
 * A keyboard's first open (Enter, Space, ArrowDown) mounts the root closed and
 * then clicks the real trigger, so the menu opens through Base's own trigger as
 * a keyboard open - which is what highlights the first item for the next
 * Enter. The key itself is swallowed, so a native button does not also turn it
 * into a click.
 *
 * `disabled` closes a menu that is open when its trigger becomes disabled. The
 * disabled trigger renders without the menu root, so nothing else resets
 * `open`, and enabling the trigger again would reopen the menu with no gesture.
 */
export function useSidebarRowDropdownMount(disabled: boolean) {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  if (disabled && open) setOpen(false);
  const triggerId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const keyboardOpenRef = useRef(false);
  // A passive effect, after the menu root's own: the trigger is Base's by now.
  useEffect(() => {
    if (!mounted || !keyboardOpenRef.current) return;
    keyboardOpenRef.current = false;
    triggerRef.current?.click();
  }, [mounted]);
  const openFirstTime = (): void => {
    setMounted(true);
    setOpen(true);
  };
  // A touch or pen press on the trigger is the trigger's, never the row's:
  // the row's long-press timer stands down on a default-prevented pointerdown.
  // Not for a mouse, whose press the row never times.
  const onPointerDown = (event: PointerEvent<HTMLButtonElement>): void => {
    if (event.pointerType !== "mouse") event.preventDefault();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (mounted || !["Enter", " ", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    keyboardOpenRef.current = true;
    setMounted(true);
  };
  const onClick = (): void => {
    if (!mounted) openFirstTime();
  };
  return {
    mounted,
    open,
    setOpen,
    // Spread onto the trigger. The menu's trigger sets its own id once
    // mounted, and the menu's aria-labelledby names that one, so ours is
    // absent then rather than `id: undefined`, which would replace it.
    triggerIdProps: mounted ? {} : { id: triggerId },
    triggerRef,
    onPointerDown,
    onKeyDown,
    onClick,
  };
}
