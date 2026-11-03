/**
 * Production palette mount. Builds the `CommandContext` + pulls
 * items from every registered source (sync + React-backed), then
 * hands both to the shell. Tests use `CommandPaletteTestShell`
 * instead so they skip React sources.
 *
 * Pathname is read non-reactively from the router adapter: the
 * palette mounts above `RouterProvider` in `traycer-app.tsx`, so
 * `useRouterState` isn't available here. The context is built again
 * each time the palette opens (`useOpenedCommandContext`), and
 * selections that navigate also close it, so a stale pathname can't
 * surface.
 */
import { useState } from "react";
import {
  CommandPaletteShell,
  RootView,
  type PaletteRootListProps,
} from "@/components/command-palette/command-palette-shell";
import { useCommandPaletteRouter } from "@/components/command-palette/command-palette-context";
import { useFocusedComposerKind } from "@/hooks/command-palette/use-focused-composer-kind";
import { buildCommandContext } from "@/lib/commands/context";
import type { CommandContext, FocusedComposerKind } from "@/lib/commands/types";
import { useCommandItems } from "@/lib/commands/use-command-items";
import type { KeybindingRouter } from "@/lib/keybindings/dispatch";
import { useCommandPaletteStore } from "@/stores/command-palette/command-palette-store";

/**
 * Computes items from every source and renders the root list. The shell mounts
 * this only inside the open dialog, so the source subscriptions (canvas tabs,
 * keybindings, host, history) - and the per-change item rebuild - run only
 * while the palette is open, never behind a closed dialog.
 */
function PaletteRootList(props: PaletteRootListProps) {
  const { items, loading } = useCommandItems(props.ctx);
  return <RootView {...props} items={items} loading={loading} />;
}

interface BuiltCommandContext {
  readonly open: boolean;
  readonly router: KeybindingRouter;
  readonly focusedComposerKind: FocusedComposerKind | null;
  readonly ctx: CommandContext;
}

/**
 * The context the sources and the runs see, built again whenever the palette
 * opens or closes. The path and the active tab are read when it is built, not
 * subscribed to, and the palette stays mounted while closed, so a context kept
 * from an earlier opening describes the page that opening was on. `open` is
 * compared, not listed as a memo dependency: the compiler drops a dependency
 * the callback never reads, and caches a build by the values it does read.
 */
function useOpenedCommandContext(
  router: KeybindingRouter,
  focusedComposerKind: FocusedComposerKind | null,
): CommandContext {
  const open = useCommandPaletteStore((state) => state.open);
  const [built, setBuilt] = useState<BuiltCommandContext>(() => ({
    open,
    router,
    focusedComposerKind,
    ctx: buildCommandContext({ router, focusedComposerKind }),
  }));
  if (
    built.open !== open ||
    built.router !== router ||
    built.focusedComposerKind !== focusedComposerKind
  ) {
    // An updater, so the build runs when React applies it and is never served
    // from the compiler's cache of an earlier build on the same router: React
    // renders again with it before anything here is committed.
    setBuilt(() => ({
      open,
      router,
      focusedComposerKind,
      ctx: buildCommandContext({ router, focusedComposerKind }),
    }));
  }
  return built.ctx;
}

export function CommandPalette() {
  const router = useCommandPaletteRouter();
  const focusedComposerKind = useFocusedComposerKind();
  const ctx = useOpenedCommandContext(router, focusedComposerKind);

  return <CommandPaletteShell ctx={ctx} RootList={PaletteRootList} />;
}
