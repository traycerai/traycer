/**
 * Mounts the command palette exactly once, beside the keybinding
 * provider, and registers the `app.palette.open` action handler so
 * the chord is live anywhere the app shell is rendered. Also
 * publishes the shared router adapter via
 * `CommandPaletteRouterContext` so sources can dispatch through the
 * same narrow seam the keybinding dispatcher uses.
 */
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

/**
 * Test seam - accepts a pre-built adapter so tests don't construct
 * a full TanStack `AppRouter`, and mounts `CommandPaletteTestShell`
 * so they don't need `HostRuntimeProvider` / `QueryClientProvider`
 * just to exercise palette mechanics. Production always goes through
 * `CommandPaletteProvider`, which renders the full palette with
 * every source (including React-backed ones).
 */
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
