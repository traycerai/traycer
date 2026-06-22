/**
 * Explicit source registration. Sources split into two kinds:
 *
 *   - `SOURCES` - framework-free `getItems(ctx)`. Called from both
 *     React and non-React code paths. Synchronous.
 *   - `REACT_SOURCES` - each `useItems(ctx)` is a hook. Called
 *     from `useCommandItems` under the rules of hooks.
 *
 * Adding a new source: write a file under `./sources/` that
 * exports a `CommandSource` (pure) or `ReactCommandSource`
 * (hook-backed), import it here, and append to the matching list.
 */
import type {
  CommandContext,
  CommandItem,
  CommandSource,
} from "@/lib/commands/types";
import { themeSource } from "@/lib/commands/sources/theme.source";
import { openSource } from "@/lib/commands/sources/open.source";
const SOURCES: ReadonlyArray<CommandSource> = [themeSource, openSource];

/**
 * Every pure source's items for the given context, flattened into
 * a single array in registration order. React-backed sources are
 * NOT included - call them via `REACT_SOURCES[i].useItems` inside a
 * React component and merge the results.
 */
export function getAllItems(ctx: CommandContext): ReadonlyArray<CommandItem> {
  return SOURCES.flatMap((source) => source.getItems(ctx));
}

/**
 * Opener category entries for the in-pane opener. The open source emits them
 * only when `ctx.targetGroupId !== null`, so callers must build a ctx bound to
 * the target pane's group.
 */
export function getOpenerItems(
  ctx: CommandContext,
): ReadonlyArray<CommandItem> {
  return openSource.getItems(ctx);
}
