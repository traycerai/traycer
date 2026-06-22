/**
 * Exposes a `KeybindingRouter` inside the palette's component tree
 * so `CommandPalette` can build a `CommandContext` without taking
 * the TanStack `AppRouter` as a prop. The provider sets this once
 * from the same adapter `KeybindingProvider` uses - both surfaces
 * therefore share one narrow router seam.
 */
import { createContext, use } from "react";
import type { KeybindingRouter } from "@/lib/keybindings/dispatch";

export const CommandPaletteRouterContext =
  createContext<KeybindingRouter | null>(null);

export function useCommandPaletteRouter(): KeybindingRouter {
  const router = use(CommandPaletteRouterContext);
  if (router === null) {
    throw new Error(
      "useCommandPaletteRouter must be used inside CommandPaletteProvider",
    );
  }
  return router;
}
