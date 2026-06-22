/**
 * Single entry point for "run this command". Every path - click,
 * keyboard enter, recent-row re-activation - goes through
 * `runCommandItem`. That guarantees:
 *
 *   - action-id items route through `dispatchAction` so shortcut and
 *     palette never diverge;
 *   - recents get recorded exactly once per successful dispatch;
 *   - the palette always closes after a dispatch (unless the item
 *     opts out, which v1 does not use).
 */
import { dispatchAction } from "@/lib/keybindings/dispatch";
import type { CommandContext, CommandItem } from "@/lib/commands/types";

export interface RunCommandItemHooks {
  readonly recordUse: (itemId: string) => void;
  readonly close: () => void;
}

/**
 * Fire a command. Sync items resolve on the next tick; async items
 * await their handler. Recording use happens only on success so a
 * failed run doesn't pollute recents; the palette always closes via
 * `finally` so a crashed handler can't strand the dialog open.
 * Errors propagate to the caller untouched - we do not log-and-
 * swallow here (matches the repo's boundary-only logging rule).
 */
export async function runCommandItem(
  item: CommandItem,
  ctx: CommandContext,
  hooks: RunCommandItemHooks,
): Promise<void> {
  try {
    if (item.actionId !== null) {
      dispatchAction(item.actionId, ctx.router);
    } else {
      await item.run(ctx);
    }
    hooks.recordUse(item.id);
  } finally {
    hooks.close();
  }
}
