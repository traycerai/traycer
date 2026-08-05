import { useMemo } from "react";
import type { WorktreeBindingOwnerKind } from "@traycer/protocol/host/worktree-schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { useWorktreeGetBinding } from "@/hooks/worktree/use-worktree-get-binding-query";
import { useActiveEpicProjection } from "@/lib/commands/sources/open/use-active-epic-projection";
import type { ForkWorkspaceSeed } from "@/lib/worktree/fork-workspace-seed";
import { buildForkWorkspaceSeed } from "@/lib/worktree/fork-workspace-seed";
import type { OpenEpicState } from "@/stores/epics/open-epic/store";
import {
  useWorktreeIntentStagingStore,
  worktreeStagingKeyString,
  type WorktreeStagingKey,
} from "@/stores/worktree/worktree-intent-staging-store";

export interface LatestConversationWorkspaceSeed extends ForkWorkspaceSeed {
  readonly sourceOwnerId: string;
  readonly sourceOwnerKind: WorktreeBindingOwnerKind;
}

export interface ConversationWorkspaceOwner {
  readonly id: string;
  readonly ownerKind: WorktreeBindingOwnerKind;
  readonly createdAt: number;
  readonly hostId: string | null;
}

/**
 * A caller that will create the chat on a specific host (a pinned
 * new-conversation modal) passes that host here so the seed is read from and
 * about the SAME host - seeding from the app-wide active host would suggest a
 * worktree that may not exist where the chat is actually created. `null`
 * keeps the historical behavior: active host, active client.
 */
export interface ConversationSeedHostPin {
  readonly hostId: string;
  readonly hostClient: HostClient<HostRpcRegistry> | null;
}

export function useLatestConversationWorkspaceSeed(
  epicId: string | null,
  pin: ConversationSeedHostPin | null,
): LatestConversationWorkspaceSeed | null {
  const projection = useActiveEpicProjection(epicId);
  const latestOwner = useMemo(
    () => latestCreatedConversationOwner(projection),
    [projection],
  );
  const activeHostId = useReactiveActiveHostId();
  const activeClient = useHostClient();
  const seedHostId = pin === null ? activeHostId : pin.hostId;
  const client = pin === null ? activeClient : pin.hostClient;
  const canReadBinding =
    epicId !== null &&
    latestOwner !== null &&
    seedHostId !== null &&
    (latestOwner.hostId === null || latestOwner.hostId === seedHostId);

  const bindingQuery = useWorktreeGetBinding({
    client,
    epicId: epicId ?? "",
    ownerId: latestOwner?.id ?? "",
    ownerKind: latestOwner?.ownerKind ?? "chat",
    enabled: canReadBinding,
    staleTime: 0,
    refetchOnWindowFocus: false,
    poll: false,
  });

  const stagingKey = useMemo<WorktreeStagingKey | null>(() => {
    if (epicId === null || latestOwner === null) return null;
    return {
      surface: "owner",
      epicId,
      ownerKind: latestOwner.ownerKind,
      ownerId: latestOwner.id,
    };
  }, [epicId, latestOwner]);
  const stagingKeyId =
    stagingKey === null ? null : worktreeStagingKeyString(stagingKey);
  const stagedIntent = useWorktreeIntentStagingStore((state) =>
    stagingKeyId === null ? null : (state.intentByKey[stagingKeyId] ?? null),
  );
  const binding = bindingQuery.data?.binding ?? null;

  return useMemo(() => {
    if (!canReadBinding) return null;
    const seed = buildForkWorkspaceSeed({
      binding,
      stagedIntent,
    });
    if (seed.intent === null) return null;
    return {
      ...seed,
      sourceOwnerId: latestOwner.id,
      sourceOwnerKind: latestOwner.ownerKind,
    };
  }, [binding, canReadBinding, latestOwner, stagedIntent]);
}

export function latestCreatedConversationOwner(
  projection: Pick<OpenEpicState, "chats" | "tuiAgents"> | null,
): ConversationWorkspaceOwner | null {
  if (projection === null) return null;
  const chatOwners = projection.chats.allIds.map((id) => {
    const chat = projection.chats.byId[id];
    return {
      id: chat.id,
      ownerKind: "chat" as const,
      createdAt: chat.createdAt,
      hostId: chat.hostId,
    };
  });
  const terminalAgentOwners = projection.tuiAgents.allIds.map((id) => {
    const agent = projection.tuiAgents.byId[id];
    return {
      id: agent.id,
      ownerKind: "terminal-agent" as const,
      createdAt: agent.createdAt,
      hostId: agent.hostId,
    };
  });
  return [
    ...chatOwners,
    ...terminalAgentOwners,
  ].reduce<ConversationWorkspaceOwner | null>((latest, owner) => {
    if (latest === null) return owner;
    if (owner.createdAt > latest.createdAt) return owner;
    if (owner.createdAt < latest.createdAt) return latest;
    return ownerKey(owner) > ownerKey(latest) ? owner : latest;
  }, null);
}

function ownerKey(owner: ConversationWorkspaceOwner): string {
  return `${owner.ownerKind}:${owner.id}`;
}
