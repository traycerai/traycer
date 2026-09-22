import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { v4 as uuidv4 } from "uuid";
import type { AgentMessagePeer } from "@traycer/protocol/host/agent/message-peer";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { tileIntent } from "@/lib/canvas/tile-open/intent";
import { useOpenEpicId } from "@/lib/epic-selectors";
import { activateTabIntent, resourceEpicTabIntent } from "@/lib/tab-navigation";
import type { EpicArtifactRef } from "@/stores/epics/canvas/types";

export function useOpenA2AMessagePeer(): (
  peer: AgentMessagePeer,
  name: string,
) => void {
  const epicId = useOpenEpicId();
  const { openTile } = useEpicTileNavigation();
  const navigate = useNavigate();
  return useCallback(
    (peer, name) => {
      const node: EpicArtifactRef = {
        id: peer.agentId,
        instanceId: uuidv4(),
        type: peer.surface === "gui" ? "chat" : "terminal-agent",
        name,
        hostId: peer.hostId,
      };
      if (peer.epicId === epicId) {
        openTile(tileIntent(node, { epicId }, "explicit", "direct_ui"));
        return;
      }
      // Tile placement alone does not activate another task's header tab.
      activateTabIntent(
        navigate,
        resourceEpicTabIntent({
          epicId: peer.epicId,
          tabId: null,
          name: undefined,
          focus: {
            focusedAt: undefined,
            focusArtifactId: undefined,
            focusThreadId: undefined,
            migrationSource: undefined,
          },
          preparation: { kind: "open-tile", node, gesture: "explicit" },
          includeNestedFocus: true,
        }),
        undefined,
      );
    },
    [epicId, navigate, openTile],
  );
}
