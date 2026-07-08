/**
 * React hook that aggregates items from every registered source
 * for the given `CommandContext`. Pure sources resolve through
 * `getAllItems`; React sources are consumed via their
 * `useItems(ctx)` hooks - each hook called explicitly here so the
 * rules of hooks are obvious to both React and eslint.
 *
 * Adding a React source:
 *   1. Append it to `REACT_SOURCES` in `./registry.ts`;
 *   2. Add a `const xItems = xSource.useItems(ctx)` line here;
 *   3. Include `xItems` in the merge memo.
 */
import { useMemo } from "react";
import { getAllItems } from "@/lib/commands/registry";
import { actionsSource } from "@/lib/commands/sources/actions.source";
import { composerSource } from "@/lib/commands/sources/composer.source";
import { epicsSource } from "@/lib/commands/sources/epics.source";
import { helpSource } from "@/lib/commands/sources/help.source";
import { historyNavigationSource } from "@/lib/commands/sources/history-navigation.source";
import { navigationSource } from "@/lib/commands/sources/navigation.source";
import type { CommandContext, CommandItem } from "@/lib/commands/types";

export interface UseCommandItemsResult {
  readonly items: ReadonlyArray<CommandItem>;
  readonly loading: boolean;
}

export function useCommandItems(ctx: CommandContext): UseCommandItemsResult {
  const syncItems = useMemo(() => getAllItems(ctx), [ctx]);
  const actionItems = actionsSource.useItems(ctx);
  const navItems = navigationSource.useItems(ctx);
  const historyNavItems = historyNavigationSource.useItems(ctx);
  const epicItems = epicsSource.useItems(ctx);
  const composerItems = composerSource.useItems(ctx);
  const helpItems = helpSource.useItems(ctx);

  const items = useMemo<ReadonlyArray<CommandItem>>(
    () => [
      ...syncItems,
      ...actionItems,
      ...navItems,
      ...historyNavItems,
      ...epicItems,
      ...composerItems,
      ...helpItems,
    ],
    [
      syncItems,
      actionItems,
      navItems,
      historyNavItems,
      epicItems,
      composerItems,
      helpItems,
    ],
  );

  return { items, loading: false };
}
