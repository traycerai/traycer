import { use, useCallback } from "react";
import { TabHostContext } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useMaybeOpenEpicHandle } from "@/providers/use-open-epic-handle";
import { useOpenManagedCommandOutput } from "@/lib/managed-commands/use-open-managed-command-output";

/**
 * Opens a shell's output window. `hostId` is the host the shell RUNS on when
 * that is not the tab's own - a shell the agent created through a cross-host
 * dial keeps its log there, and the window streams from that host. `null` is
 * every other shell: the tab's host, as before.
 */
export type ManagedCommandDoor = (
  commandId: string,
  hostId: string | null,
) => void;

/**
 * The door as a chat-side surface can use it. A chip and a resume divider sit
 * deep inside a chat transcript with neither the epic id nor the host in hand,
 * but both are already in scope as context: the tile's `TabHostProvider` names
 * the host the chat is bound to, and the epic session names the epic.
 *
 * Returns `null` when either is missing (a transcript rendered outside a tile),
 * so the surface renders its plain marker rather than a button that would open
 * nothing.
 */
export function useManagedCommandDoor(): ManagedCommandDoor | null {
  const tabHostId = use(TabHostContext);
  const epicHandle = useMaybeOpenEpicHandle();
  const epicId = epicHandle?.epicId ?? null;
  const openOutput = useOpenManagedCommandOutput(epicId ?? "");

  const open = useCallback<ManagedCommandDoor>(
    (commandId, hostId) => {
      if (tabHostId === null) return;
      openOutput({ commandId, hostId: hostId ?? tabHostId });
    },
    [tabHostId, openOutput],
  );

  if (tabHostId === null || epicId === null) return null;
  return open;
}

/**
 * The door for a surface whose shells always run on the tab's own host - the
 * start/restart cards and the running-work panel, which only ever list shells
 * this host owns - so it takes the command id alone.
 */
export function localManagedCommandDoor(
  door: ManagedCommandDoor | null,
): ((commandId: string) => void) | null {
  if (door === null) return null;
  return (commandId) => {
    door(commandId, null);
  };
}
