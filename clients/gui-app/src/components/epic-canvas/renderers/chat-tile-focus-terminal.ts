import { useCallback } from "react";
import { v4 as uuidv4 } from "uuid";
import { DEFAULT_EPIC_NODE_NAMES } from "@/lib/artifacts/node-display";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import type { NestedFocusTarget } from "@/lib/epic-nested-focus-route";
import {
  findOpenArtifactInTab,
  useEpicCanvasStore,
} from "@/stores/epics/canvas/store";
import type { EpicTerminalRef } from "@/stores/epics/canvas/types";
import { recordSetupTerminal } from "@/stores/worktree/setup-terminals";

/**
 * Ref fields a caller may set on the tile it is opening. Applied on the OPEN
 * path only: an already-open tile keeps the ref it was opened with and is
 * merely activated, which is the honest behaviour - a tile's origin is a fact
 * about the session behind it, not about who focused it.
 */
export interface EpicTerminalRefOverrides {
  readonly name: string;
  readonly origin: EpicTerminalRef["origin"];
  readonly originProviderId: EpicTerminalRef["originProviderId"];
}

// Calling with `null` is a no-op so callers can pass through whatever id
// the latest setup event carried (or didn't, for missing-metadata frames)
// without branching at every call site.
export function useFocusEpicTerminalSession(
  viewTabId: string,
): (
  terminalSessionId: string | null,
  cwd: string,
  overrides: EpicTerminalRefOverrides | null,
) => void {
  const navigateNested = useEpicNestedFocusNavigation();
  const prepareOpenTileInTabFocusTarget = useEpicCanvasStore(
    (s) => s.prepareOpenTileInTabFocusTarget,
  );
  const prepareSetActiveTileTabFocusTarget = useEpicCanvasStore(
    (s) => s.prepareSetActiveTileTabFocusTarget,
  );
  // Setup-event terminals inherit the bound host of the chat tile
  // that emitted the event - same artifact, same host binding.
  const activeHostId = useTabHostId();
  return useCallback(
    (terminalSessionId, cwd, overrides) => {
      if (terminalSessionId === null) return;
      if (terminalSessionId.length === 0) return;
      if (overrides?.origin === "setup") {
        recordSetupTerminal({
          hostId: activeHostId,
          sessionId: terminalSessionId,
        });
      }
      // This is a committed user open/focus, so the nested route search must
      // become the new focus authority - otherwise route sync re-applies the
      // stale target and the tab opens without ever becoming visible.
      const epicId =
        useEpicCanvasStore.getState().tabsById[viewTabId]?.epicId ?? null;
      const commit = (prepare: () => NestedFocusTarget | null): void => {
        if (epicId === null) {
          prepare();
          return;
        }
        navigateNested(epicId, viewTabId, prepare);
      };
      const found = findOpenArtifactInTab(viewTabId, terminalSessionId);
      if (found !== null) {
        // `found` is keyed by content id; activate by the tab's instanceId.
        commit(() =>
          prepareSetActiveTileTabFocusTarget(
            viewTabId,
            found.paneId,
            found.instanceId,
          ),
        );
        return;
      }
      commit(() =>
        prepareOpenTileInTabFocusTarget(viewTabId, {
          id: terminalSessionId,
          instanceId: uuidv4(),
          type: "terminal",
          name: overrides?.name ?? DEFAULT_EPIC_NODE_NAMES.terminal,
          titleSource: "manual",
          hostId: activeHostId,
          cwd,
          origin: overrides?.origin,
          originProviderId: overrides?.originProviderId,
        }),
      );
    },
    [
      activeHostId,
      navigateNested,
      prepareOpenTileInTabFocusTarget,
      prepareSetActiveTileTabFocusTarget,
      viewTabId,
    ],
  );
}
