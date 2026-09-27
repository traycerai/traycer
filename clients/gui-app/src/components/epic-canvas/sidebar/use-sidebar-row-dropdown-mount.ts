import { useId, useState, type KeyboardEvent, type PointerEvent } from "react";

/** Shared opening path for the sidebar's more and add-child dropdowns. */
export function useSidebarRowDropdownMount() {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const triggerId = useId();
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
    openFirstTime();
  };
  const onClick = (): void => {
    // Assistive activations and test helpers can issue click alone.
    if (!mounted) openFirstTime();
  };
  return {
    mounted,
    open,
    setOpen,
    triggerId,
    onPointerDown,
    onKeyDown,
    onClick,
  };
}
