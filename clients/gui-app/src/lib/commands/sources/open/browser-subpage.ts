import { useMemo } from "react";
import { toast } from "sonner";
import { useBrowserSessionsContext } from "@/components/epic-canvas/renderers/browser-sessions-context";
import { openTileIntoTargetGroup } from "@/lib/commands/actions";
import {
  DEFAULT_BROWSER_TILE_URL,
  makeBrowserSessionTileRef,
} from "@/stores/epics/canvas/tile-schema/browser-tile";
import { openerActionLeaf } from "@/lib/commands/sources/open/open-leaf";
import type { CommandContext, CommandItem } from "@/lib/commands/types";

export function useBrowserOpenerItems(
  ctx: CommandContext,
): ReadonlyArray<CommandItem> {
  const sessions = useBrowserSessionsContext();

  return useMemo<ReadonlyArray<CommandItem>>(
    () => [
      openerActionLeaf({
        id: "open:browser:new",
        label: "New browser",
        keywords: ["new", "browser", "web", "page"],
        run: () => {
          if (sessions.lifecycle !== "live" || sessions.hostId === null) {
            toast.error("Browsers are not connected yet.");
            return;
          }
          const hostId = sessions.hostId;
          void sessions
            .openTab(null, DEFAULT_BROWSER_TILE_URL)
            .then((opened) => {
              openTileIntoTargetGroup({
                tabId: ctx.activeTabId,
                groupId: ctx.targetGroupId,
                navigateNestedFocus: ctx.router.navigateNestedFocus,
                ref: makeBrowserSessionTileRef({
                  hostId,
                  sessionId: opened.sessionId,
                  tabId: opened.tabId,
                }),
              });
            })
            .catch((cause: unknown) => {
              toast.error(
                cause instanceof Error
                  ? cause.message
                  : "Couldn't open a browser.",
              );
            });
        },
      }),
    ],
    [
      ctx.activeTabId,
      ctx.router.navigateNestedFocus,
      ctx.targetGroupId,
      sessions,
    ],
  );
}
