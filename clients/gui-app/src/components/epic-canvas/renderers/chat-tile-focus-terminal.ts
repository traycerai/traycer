import { useCallback } from "react";
import { v4 as uuidv4 } from "uuid";
import { DEFAULT_EPIC_NODE_NAMES } from "@/lib/artifacts/node-display";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import {
  findOpenArtifactInTab,
  useEpicCanvasStore,
} from "@/stores/epics/canvas/store";

// Calling with `null` is a no-op so callers can pass through whatever id
// the latest setup event carried (or didn't, for missing-metadata frames)
// without branching at every call site.
export function useFocusEpicTerminalSession(
  viewTabId: string,
): (terminalSessionId: string | null, cwd: string) => void {
  const openTileInTab = useEpicCanvasStore((s) => s.openTileInTab);
  const setActiveTileTab = useEpicCanvasStore((s) => s.setActiveTileTab);
  const setActiveTilePane = useEpicCanvasStore((s) => s.setActiveTilePane);
  // Setup-event terminals inherit the bound host of the chat tile
  // that emitted the event - same artifact, same host binding.
  const activeHostId = useTabHostId();
  return useCallback(
    (terminalSessionId, cwd) => {
      if (terminalSessionId === null) return;
      if (terminalSessionId.length === 0) return;
      const found = findOpenArtifactInTab(viewTabId, terminalSessionId);
      if (found !== null) {
        // `found` is keyed by content id; activate by the tab's instanceId.
        setActiveTilePane(viewTabId, found.paneId);
        setActiveTileTab(viewTabId, found.paneId, found.instanceId);
        return;
      }
      openTileInTab(viewTabId, {
        id: terminalSessionId,
        instanceId: uuidv4(),
        type: "terminal",
        name: DEFAULT_EPIC_NODE_NAMES.terminal,
        titleSource: "manual",
        hostId: activeHostId,
        cwd,
      });
    },
    [
      activeHostId,
      openTileInTab,
      setActiveTilePane,
      setActiveTileTab,
      viewTabId,
    ],
  );
}
