/**
 * Production palette mount. Builds the `CommandContext` + pulls
 * items from every registered source (sync + React-backed), then
 * hands both to the shell. Tests use `CommandPaletteTestShell`
 * instead so they skip React sources.
 *
 * Pathname is read non-reactively from the router adapter: the
 * palette mounts above `RouterProvider` in `traycer-app.tsx`, so
 * `useRouterState` isn't available here. Selections that navigate
 * also close the palette, so a stale pathname can't surface.
 */
import { useMemo } from "react";
import {
  CommandPaletteShell,
  RootView,
  type PaletteRootListProps,
} from "@/components/command-palette/command-palette-shell";
import { useCommandPaletteRouter } from "@/components/command-palette/command-palette-context";
import { useFocusedComposerKind } from "@/hooks/command-palette/use-focused-composer-kind";
import { buildCommandContext } from "@/lib/commands/context";
import { useCommandItems } from "@/lib/commands/use-command-items";

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

export function CommandPalette() {
  const router = useCommandPaletteRouter();
  const focusedComposerKind = useFocusedComposerKind();

  const ctx = useMemo(
    () => buildCommandContext({ router, focusedComposerKind }),
    [router, focusedComposerKind],
  );

  return <CommandPaletteShell ctx={ctx} RootList={PaletteRootList} />;
}
