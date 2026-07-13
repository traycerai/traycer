import { useMemo } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  WorktreeBinding,
  WorktreeBindingOwnerKind,
  WorktreeIntent,
} from "@traycer/protocol/host/worktree-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import { buildOwnerWorkspaceInheritanceSeed } from "@/lib/worktree/owner-workspace-inheritance-seed";
import type { ForkWorkspaceSeed } from "@/lib/worktree/fork-workspace-seed";
import { emptyLandingDraftWorkspaceSnapshot } from "@/stores/home/landing-draft-store";
import {
  useWorktreeIntentStagingStore,
  worktreeStagingKeyString,
  type WorktreeStagingKey,
} from "@/stores/worktree/worktree-intent-staging-store";
import { useWorktreeGetBinding } from "./use-worktree-get-binding-query";

// While the parent binding read is still in flight we must hand the picker a
// non-null but EMPTY workspace seed rather than `null`. `null` makes
// `useResolvedWorkspaceFolders` fall back to the global (start-page) folders,
// which the picker's auto-seed effect then stages as a default intent under the
// launch staging key - and that staged default both slips past the launch gate
// and blocks the real parent seed (via `alreadyStaged`) once it arrives. An
// empty snapshot resolves to zero folders, so nothing auto-stages and the
// launch gate stays blocked until the binding settles. Frozen at module scope
// for referential stability so the picker's seed identity does not churn while
// pending.
const PENDING_OWNER_WORKSPACE_INHERITANCE_SEED: ForkWorkspaceSeed = {
  intent: null,
  workspace: emptyLandingDraftWorkspaceSnapshot(),
};

export function resolveOwnerWorkspaceInheritanceSeed(input: {
  readonly enabled: boolean;
  readonly bindingReadEnabled: boolean;
  readonly bindingResultReady: boolean;
  readonly binding: WorktreeBinding | null;
  readonly stagedIntent: WorktreeIntent | null;
  readonly fallbackWorkspaceFolders: readonly string[];
}): ForkWorkspaceSeed | null {
  if (!input.enabled) return null;
  if (input.bindingReadEnabled && !input.bindingResultReady) {
    return PENDING_OWNER_WORKSPACE_INHERITANCE_SEED;
  }
  return buildOwnerWorkspaceInheritanceSeed({
    binding: input.binding,
    stagedIntent: input.stagedIntent,
    fallbackWorkspaceFolders: input.fallbackWorkspaceFolders,
  });
}

export function useOwnerWorkspaceInheritanceSeed(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly epicId: string;
  readonly ownerId: string;
  readonly ownerKind: WorktreeBindingOwnerKind | null;
  readonly enabled: boolean;
  readonly fallbackWorkspaceFolders: readonly string[];
}): {
  readonly seed: ForkWorkspaceSeed | null;
  readonly pending: boolean;
  readonly unavailable: boolean;
} {
  const bindingReadEnabled =
    args.enabled && args.client !== null && args.ownerKind !== null;
  const bindingQuery = useWorktreeGetBinding({
    client: args.client,
    epicId: args.epicId,
    ownerId: args.ownerId,
    ownerKind: args.ownerKind ?? "chat",
    enabled: bindingReadEnabled,
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchInterval: false,
  });
  const ownerStagingKey = useMemo<WorktreeStagingKey | null>(() => {
    if (!args.enabled || args.ownerKind === null) return null;
    return {
      surface: "owner",
      epicId: args.epicId,
      ownerKind: args.ownerKind,
      ownerId: args.ownerId,
    };
  }, [args.enabled, args.epicId, args.ownerId, args.ownerKind]);
  const ownerStagingKeyId =
    ownerStagingKey === null ? null : worktreeStagingKeyString(ownerStagingKey);
  const stagedIntent = useWorktreeIntentStagingStore<WorktreeIntent | null>(
    (state) =>
      ownerStagingKeyId === null
        ? null
        : (state.intentByKey[ownerStagingKeyId] ?? null),
  );
  const bindingResultReady =
    !bindingReadEnabled || bindingQuery.data !== undefined;
  const seed = useMemo(
    () =>
      resolveOwnerWorkspaceInheritanceSeed({
        enabled: args.enabled,
        bindingReadEnabled,
        bindingResultReady,
        binding: bindingQuery.data?.binding ?? null,
        stagedIntent,
        fallbackWorkspaceFolders: args.fallbackWorkspaceFolders,
      }),
    [
      args.enabled,
      args.fallbackWorkspaceFolders,
      bindingReadEnabled,
      bindingResultReady,
      bindingQuery.data?.binding,
      stagedIntent,
    ],
  );
  return {
    seed,
    pending:
      bindingReadEnabled &&
      bindingQuery.data === undefined &&
      bindingQuery.isPending,
    unavailable:
      bindingReadEnabled &&
      bindingQuery.data === undefined &&
      bindingQuery.isError,
  };
}
