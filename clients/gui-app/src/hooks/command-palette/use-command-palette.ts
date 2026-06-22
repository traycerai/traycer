/**
 * React bridge between the `app.palette.open` keybinding action and
 * the palette store. Mirrors the pattern used by the sidebar-toggle
 * bridge in `sidebar-keybinding-bridge.tsx`: mount an effect that
 * registers a dynamic handler, and return the dispose fn.
 */
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

/**
 * Registers the `app.palette.open` action's handler while mounted.
 * The live toggle fn is parked in a ref (written inside an effect
 * so React's strict compiler doesn't flag a write-during-render) and
 * read through the ref in the dispatcher closure so identity churn
 * on the controller doesn't thrash the registry.
 */
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
