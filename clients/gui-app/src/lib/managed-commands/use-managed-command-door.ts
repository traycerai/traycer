import { use, useCallback } from "react";
import { TabHostContext } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useMaybeOpenEpicHandle } from "@/providers/use-open-epic-handle";
import { useOpenManagedCommandOutput } from "@/lib/managed-commands/use-open-managed-command-output";

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
export function useManagedCommandDoor(): ((commandId: string) => void) | null {
  const hostId = use(TabHostContext);
  const epicHandle = useMaybeOpenEpicHandle();
  const epicId = epicHandle?.epicId ?? null;
  const openOutput = useOpenManagedCommandOutput(epicId ?? "");

  const open = useCallback(
    (commandId: string) => {
      if (hostId === null) return;
      openOutput({ commandId, hostId });
    },
    [hostId, openOutput],
  );

  if (hostId === null || epicId === null) return null;
  return open;
}
