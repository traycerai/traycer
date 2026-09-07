/** Mount the palette once and register app.palette.open. Sources dispatch through CommandPaletteRouterContext, same seam as the keybinding dispatcher. */
import { useMemo, type ReactNode } from "react";
import { CommandPalette } from "@/components/command-palette/command-palette";
import { CommandPaletteRouterContext } from "@/components/command-palette/command-palette-context";
import { CommandPaletteTestShell } from "@/components/command-palette/command-palette-test-shell";
import { usePaletteKeybindingBridge } from "@/hooks/command-palette/use-command-palette";
import type { KeybindingRouter } from "@/lib/keybindings/dispatch";
import { routerAdapterFor } from "@/lib/keybindings/router-adapter";
import type { AppRouter } from "@/router";

interface CommandPaletteProviderProps {
  readonly router: AppRouter;
  readonly children: ReactNode;
}

export function CommandPaletteProvider(props: CommandPaletteProviderProps) {
  const adapter = useMemo(() => routerAdapterFor(props.router), [props.router]);
  return (
    <CommandPaletteRouterContext.Provider value={adapter}>
      <PaletteKeybindingBridge />
      {props.children}
      <CommandPalette />
    </CommandPaletteRouterContext.Provider>
  );
}

interface CommandPaletteRootProps {
  readonly adapter: KeybindingRouter;
  readonly children: ReactNode;
}

/** Test seam: pre-built adapter + CommandPaletteTestShell. Production always goes through CommandPaletteProvider. */
export function CommandPaletteRoot(props: CommandPaletteRootProps) {
  return (
    <CommandPaletteRouterContext.Provider value={props.adapter}>
      <PaletteKeybindingBridge />
      {props.children}
      <CommandPaletteTestShell />
    </CommandPaletteRouterContext.Provider>
  );
}

function PaletteKeybindingBridge() {
  usePaletteKeybindingBridge();
  return null;
}
