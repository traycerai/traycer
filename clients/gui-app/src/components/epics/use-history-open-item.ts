import { useCallback } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import type { HistoryItem } from "@/components/home/data/home-page.data";
import { openEpicFromList as openEpicFromCommand } from "@/lib/commands/actions/open-epic-from-list";
import {
  activateTabIntent,
  openPhaseMigrationIntent,
} from "@/lib/tab-navigation";

export interface HistoryOpenItemArgs {
  /** Called immediately before normal row navigation. */
  readonly onSelectEpic: ((epicId: string) => void) | null;
  /** The complete item is provided so callers can preserve the distinct Epic and legacy Phase activation paths. */
  readonly onOpenItem: ((item: HistoryItem) => void) | null;
}

/** A Phase can only be opened through its migration route, which a plain canvas tab cannot carry. */
export function useHistoryOpenItem(
  args: HistoryOpenItemArgs,
): (item: HistoryItem) => void {
  const { onSelectEpic, onOpenItem } = args;
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return useCallback(
    (item: HistoryItem) => {
      if (onOpenItem !== null) {
        onOpenItem(item);
        return;
      }
      onSelectEpic?.(item.epicId);
      if (item.taskType === "phase") {
        activateTabIntent(
          navigate,
          openPhaseMigrationIntent({
            phaseId: item.epicId,
            name: item.title,
            focus: {
              focusedAt: undefined,
              focusArtifactId: undefined,
              focusThreadId: undefined,
              migrationSource: "phase",
            },
          }),
          undefined,
        );
        return;
      }
      openEpicFromCommand(navigate, item.epicId, pathname, {
        title: item.title,
        source: "direct_ui",
      });
    },
    [navigate, onOpenItem, onSelectEpic, pathname],
  );
}
