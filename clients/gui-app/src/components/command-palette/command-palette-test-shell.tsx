/**
 * Test-only palette mount. Includes every source that only reads
 * from non-host / non-query stores - pure sources
 * (`getAllItems`) plus the React sources whose hooks stay safe
 * outside a full provider stack (`actionsSource`, `navigationSource`,
 * `helpSource` - they read keybinding / desktop-dialog stores only).
 * Skips `epicsSource` + `composerSource` so palette tests can
 * exercise shell mechanics without mounting
 * `HostRuntimeProvider` or `QueryClientProvider`.
 */
import { useMemo } from "react";
import {
  CommandPaletteShell,
  RootView,
  type PaletteRootListProps,
} from "@/components/command-palette/command-palette-shell";
import { useCommandPaletteRouter } from "@/components/command-palette/command-palette-context";
import { buildCommandContext } from "@/lib/commands/context";
import { getAllItems } from "@/lib/commands/registry";
import { actionsSource } from "@/lib/commands/sources/actions.source";
import { helpSource } from "@/lib/commands/sources/help.source";
import { navigationSource } from "@/lib/commands/sources/navigation.source";
import type { CommandContext, CommandItem } from "@/lib/commands/types";

// Mirror of the prod `PaletteRootList`, restricted to the provider-free sources
// (sync + keybinding-only React sources); mounted by the shell only when open.
function TestRootList(props: PaletteRootListProps) {
  const syncItems = useMemo(() => getAllItems(props.ctx), [props.ctx]);
  const actionItems = actionsSource.useItems(props.ctx);
  const navItems = navigationSource.useItems(props.ctx);
  const helpItems = helpSource.useItems(props.ctx);
  const items = useMemo<ReadonlyArray<CommandItem>>(
    () => [...syncItems, ...actionItems, ...navItems, ...helpItems],
    [syncItems, actionItems, navItems, helpItems],
  );
  return <RootView {...props} items={items} loading={false} />;
}

export function CommandPaletteTestShell() {
  const router = useCommandPaletteRouter();
  const ctx = useMemo<CommandContext>(
    () => buildCommandContext({ router, focusedComposerKind: null }),
    [router],
  );
  return <CommandPaletteShell ctx={ctx} RootList={TestRootList} />;
}
