import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { Slot } from "radix-ui";
import {
  DropdownMenu,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** Keep closed menu providers out of transcript rows and composer mounts. */
export function LazyDropdownMenu({
  trigger,
  children,
}: {
  readonly trigger: ReactElement;
  readonly children: ReactNode;
}) {
  const [armed, setArmed] = useState(false);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef(false);
  const openingKeyRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!armed || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    triggerRef.current?.focus({ preventScroll: true });
  }, [armed]);

  useEffect(() => {
    const key = openingKeyRef.current;
    if (!armed || key === null) return;
    openingKeyRef.current = null;
    // Replay after Radix installs its document keyboard listener, so the
    // first key opens with keyboard focus behavior as subsequent keys do.
    triggerRef.current?.focus({ preventScroll: true });
    triggerRef.current?.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  }, [armed]);

  if (!armed) {
    return (
      <Slot.Root
        aria-haspopup="menu"
        aria-expanded={false}
        data-state="closed"
        onFocus={() => {
          restoreFocusRef.current = true;
          setArmed(true);
        }}
        onPointerDown={(event) => {
          if (
            event.currentTarget.matches(":disabled") ||
            event.defaultPrevented ||
            event.button !== 0 ||
            event.ctrlKey
          )
            return;
          event.preventDefault();
          setOpen(true);
          setArmed(true);
        }}
        onKeyDown={(event) => {
          if (
            event.currentTarget.matches(":disabled") ||
            event.defaultPrevented ||
            !["Enter", " ", "ArrowDown"].includes(event.key)
          )
            return;
          event.preventDefault();
          openingKeyRef.current = event.key;
          setArmed(true);
        }}
        onClick={(event) => {
          if (
            event.currentTarget.matches(":disabled") ||
            event.defaultPrevented
          ) {
            return;
          }
          setOpen(true);
          setArmed(true);
        }}
      >
        {trigger}
      </Slot.Root>
    );
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild ref={triggerRef}>
        {trigger}
      </DropdownMenuTrigger>
      {children}
    </DropdownMenu>
  );
}
