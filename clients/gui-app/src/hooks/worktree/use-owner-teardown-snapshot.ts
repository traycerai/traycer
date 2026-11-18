import { useCallback } from "react";
import type { WorktreeBindingOwnerKind } from "@traycer/protocol/host/worktree-schemas";
import { getChatSessionRegistry } from "@/lib/registries/chat-session-registry";
import {
  snapshotOwnerTeardown,
  type OwnerTeardownShell,
  type OwnerTeardownSnapshot,
} from "@/lib/worktree/owner-teardown-snapshot";

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
 * Gesture-time snapshot getter. Shells are read from live stores at call
 * time (not picker-open time) so disclosure content is never stale relative
 * to the click.
 */
export function useOwnerTeardownSnapshot(
  args: OwnerTeardownSnapshotArgs,
): (droppedRunDirectories: readonly string[]) => OwnerTeardownSnapshot {
  const {
    epicId,
    hostId,
    ownerKind,
    ownerId,
    ownerLabel,
    hasActiveTurn,
    ptyLive,
  } = args;
  return useCallback(
    (droppedRunDirectories: readonly string[]) =>
      snapshotOwnerTeardown({
        ownerRef: { epicId, ownerKind, ownerId },
        ownerLabel,
        hasActiveTurn,
        ptyLive,
        shells: collectOwnerShells({
          epicId,
          hostId,
          ownerKind,
          ownerId,
          ownerLabel,
          hasActiveTurn,
          ptyLive,
        }),
        droppedRunDirectories,
        ...collectOwnerAgentStopEvidence({
          epicId,
          hostId,
          ownerKind,
          ownerId,
          ownerLabel,
          hasActiveTurn,
          ptyLive,
        }),
      }),
    [epicId, hasActiveTurn, hostId, ownerId, ownerKind, ownerLabel, ptyLive],
  );
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
  return [...byId.values()];
}

function collectOwnerAgentStopEvidence(args: OwnerTeardownSnapshotArgs): {
  readonly queuedMessageCount: number;
  readonly backgroundItemCount: number;
} {
  if (args.ownerKind !== "chat") {
    return { queuedMessageCount: 0, backgroundItemCount: 0 };
  }
  const handle = getChatSessionRegistry().peek(
    args.epicId,
    args.ownerId,
    args.hostId,
  );
  const state = handle?.store.getState();
  return {
    queuedMessageCount: state?.queue.items.length ?? 0,
    backgroundItemCount: state?.backgroundItems?.length ?? 0,
  };
}
