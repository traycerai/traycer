import { useCallback, useRef } from "react";
import type { WorktreeBusyHolder } from "@traycer/protocol/framework/worktree-busy-holders";
import type { WorktreeBindingOwnerKind } from "@traycer/protocol/host/worktree-schemas";
import { getChatSessionRegistry } from "@/lib/registries/chat-session-registry";
import {
  snapshotOwnerTeardownHolders,
  type OwnerTeardownShell,
} from "@/lib/worktree/owner-teardown-snapshot";
import { resourcesRegistry } from "@/stores/resources/resources-registry";

export type OwnerTeardownSnapshotArgs = {
  readonly epicId: string;
  readonly hostId: string;
  readonly ownerKind: WorktreeBindingOwnerKind;
  readonly ownerId: string;
  readonly ownerLabel: string;
  readonly hasActiveTurn: boolean;
  readonly ptyLive: boolean;
};

/**
 * Gesture-time snapshot getter. Reads live stores at call time (not render
 * time / picker-open time) so disclosure content is never stale relative to
 * the click.
 */
export function useOwnerTeardownSnapshot(
  args: OwnerTeardownSnapshotArgs,
): (droppedRunDirectories: readonly string[]) => readonly WorktreeBusyHolder[] {
  const argsRef = useRef(args);
  argsRef.current = args;
  return useCallback((droppedRunDirectories: readonly string[]) => {
    const live = argsRef.current;
    return snapshotOwnerTeardownHolders({
      ownerRef: {
        epicId: live.epicId,
        ownerKind: live.ownerKind,
        ownerId: live.ownerId,
      },
      ownerLabel: live.ownerLabel,
      hasActiveTurn: live.hasActiveTurn,
      ptyLive: live.ptyLive,
      shells: collectOwnerShells(live),
      droppedRunDirectories,
    });
  }, []);
}

function collectOwnerShells(
  args: OwnerTeardownSnapshotArgs,
): readonly OwnerTeardownShell[] {
  const byId = new Map<string, OwnerTeardownShell>();
  if (args.ownerKind === "chat") {
    const handle = getChatSessionRegistry().peek(
      args.epicId,
      args.ownerId,
      args.hostId,
    );
    for (const command of handle?.store.getState().managedCommands ?? []) {
      const live =
        command.status.state === "running" ||
        command.status.state === "interrupted";
      byId.set(command.id, {
        id: command.id,
        description: command.description,
        command: command.command,
        cwd: command.cwd,
        live,
      });
    }
  }
  const resourceOwners =
    resourcesRegistry.get(args.epicId)?.store.getState().owners ??
    new Map();
  for (const snapshot of resourceOwners.values()) {
    if (snapshot.owner.kind !== "managed-command") continue;
    const managed = snapshot.managedCommand;
    if (managed === null) continue;
    if (managed.createdByAgentId !== args.ownerId) continue;
    if (byId.has(managed.commandId)) continue;
    byId.set(managed.commandId, {
      id: managed.commandId,
      description: managed.description,
      command: null,
      cwd: null,
      live: true,
    });
  }
  return [...byId.values()];
}
