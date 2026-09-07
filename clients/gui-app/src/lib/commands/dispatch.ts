/**
 * Single entry point for "run this command".
 * Every path - click, keyboard enter, recent-row re-activation - goes through `runCommandItem`.
 */
import { dispatchAction } from "@/lib/keybindings/dispatch";
import type { CommandContext, CommandItem } from "@/lib/commands/types";

export interface RunCommandItemHooks {
  readonly recordUse: (itemId: string) => void;
  readonly close: () => void;
}

/**
 * Fire a command.
 * Sync items resolve on the next tick; async items await their handler.
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
