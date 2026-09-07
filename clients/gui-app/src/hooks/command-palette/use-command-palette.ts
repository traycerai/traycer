/** React bridge between the `app.palette.open` keybinding action and the palette store. */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { registerDynamicActionHandler } from "@/lib/keybindings/dispatch";
import { useCommandPaletteStore } from "@/stores/command-palette/command-palette-store";

interface CommandPaletteController {
  readonly open: () => void;
  readonly close: () => void;
  readonly toggle: () => void;
}

function useCommandPaletteController(): CommandPaletteController {
  const setOpen = useCommandPaletteStore((state) => state.setOpen);

  const open = useCallback(() => {
    setOpen(true);
  }, [setOpen]);

  const close = useCallback(() => {
    setOpen(false);
  }, [setOpen]);

  const toggle = useCallback(() => {
    const { open: isOpen } = useCommandPaletteStore.getState();
    setOpen(!isOpen);
  }, [setOpen]);

  return useMemo(() => ({ open, close, toggle }), [open, close, toggle]);
}

/** Registers the `app.palette.open` action's handler while mounted. */
export function usePaletteKeybindingBridge(): void {
  const { toggle } = useCommandPaletteController();
  const toggleRef = useRef<() => void>(toggle);

  useEffect(() => {
    toggleRef.current = toggle;
  }, [toggle]);

  useEffect(() => {
    const dispose = registerDynamicActionHandler("app.palette.open", () => {
      toggleRef.current();
    });
    return dispose;
  }, []);
}
