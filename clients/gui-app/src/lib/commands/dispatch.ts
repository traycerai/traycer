/**
 * Single entry point for "run this command". Every path - click,
 * keyboard enter, recent-row re-activation - goes through
 * `runCommandItem`. That guarantees:
 *
 *   - action-id items route through `dispatchAction` so shortcut and
 *     palette never diverge;
 *   - recents get recorded exactly once per successful dispatch;
 *   - the palette closes after a dispatch unless an inline action opts out.
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
 * failed run doesn't pollute recents; ordinary actions close via `finally`.
 * Inline actions keep their picker mounted, including its query observers,
 * so a retry is not cancelled by closing the surface that requested it.
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
    if (item.keepOpen !== true) hooks.close();
  }
}
