/** Desktop-aware `Go back` / `Go forward` palette entries. */
import { useMemo } from "react";
import type { CommandItem, ReactCommandSource } from "@/lib/commands/types";

export const historyNavigationSource: ReactCommandSource = {
  id: "history-navigation",
  useItems: (ctx) => {
    // Availability is static per app lifetime (a host's history is branded for
    // its whole session), so it is a safe `useMemo` dependency.
    const available = ctx.router.isHistoryNavAvailable();
    return useMemo<ReadonlyArray<CommandItem>>(() => {
      if (!available) return [];
      // `shortcut` is null: back/forward has no keyboard chord (both mod/alt +Arrow collide with native caret movement in the chat composer).
      // The palette row, header arrows, and mouse buttons are the only affordances.
      return [
        {
          id: "history:back",
          label: "Go back",
          description: null,
          keywords: ["back", "history", "navigate", "previous"],
          group: "navigation",
          scope: "actions",
          shortcut: null,
          actionId: null,
          run: () => ctx.router.goBack(),
          subpage: null,
        },
        {
          id: "history:forward",
          label: "Go forward",
          description: null,
          keywords: ["forward", "history", "navigate", "next"],
          group: "navigation",
          scope: "actions",
          shortcut: null,
          actionId: null,
          run: () => ctx.router.goForward(),
          subpage: null,
        },
      ];
    }, [available, ctx.router]);
  },
};
