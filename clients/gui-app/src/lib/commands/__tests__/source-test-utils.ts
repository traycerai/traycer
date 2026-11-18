/**
 * Test-only helper. Narrows a `CommandSource.getItems` result (which
 * is typed as `ReadonlyArray<CommandItem> | Promise<...>` to cover
 * both sync and async sources) down to its sync branch so tests can
 * read `items[i].id` / `.shortcut` / etc without fighting the
 * strict-lint rules that treat the union as `any` once it flows
 * through expressions.
 */
import type { CommandItem } from "@/lib/commands/types";

export function readSyncItems(
  result: ReadonlyArray<CommandItem> | Promise<ReadonlyArray<CommandItem>>,
): ReadonlyArray<CommandItem> {
  if (result instanceof Promise) {
    throw new Error(
      "readSyncItems: source returned a Promise; use an async helper instead",
    );
  }
  return result;
}
