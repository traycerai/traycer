import { useMemo } from "react";
import type { WorktreeBindingOwnerKind } from "@traycer/protocol/host/worktree-schemas";
import type { WorktreePrReference } from "@/components/worktree/worktree-pr-metadata-model";
import { ownerPrReferences } from "@/components/worktree/worktree-pr-metadata-model";
import { useHostDirectoryEntryForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostStreamClientFor } from "@/hooks/host/use-host-stream-client-for";
import { usePrListSubscriptionForClient } from "@/hooks/pr/use-pr-list-subscription";
import { useStreamAuthRevalidator } from "@/lib/host/stream-auth-revalidator";
import { useStreamMethodSupportFor } from "@/lib/host/stream-runtime-context";

export interface OwnerPrReferencesResult {
  readonly references: readonly WorktreePrReference[];
  readonly isPending: boolean;
  readonly error: boolean;
  readonly sendRefresh: () => void;
}

/**
 * The single owner-association view used by chat UI. Membership comes from
 * `pr.subscribeListForEpic` - the same host projection that feeds the PR
 * sidebar - while the transport is pinned to the owner's host rather than the
 * app-wide effective host.
 */
export function useOwnerPrReferences(args: {
  readonly hostId: string;
  readonly epicId: string;
  readonly ownerId: string;
  readonly ownerKind: WorktreeBindingOwnerKind;
  readonly enabled: boolean;
}): OwnerPrReferencesResult {
  const resolvedTarget = useHostDirectoryEntryForHostId(args.hostId);
  const target = args.enabled ? resolvedTarget : null;
  const auth = useStreamAuthRevalidator();
  const client = useHostStreamClientFor(target, auth);
  const methodSupport = useStreamMethodSupportFor(
    client,
    "pr.subscribeListForEpic",
  );
  const subscription = usePrListSubscriptionForClient({
    hostId: args.hostId,
    epicId: args.epicId,
    mode: "background",
    enabled: args.enabled && methodSupport !== "unsupported",
    client,
  });
  const references = useMemo(
    () =>
      ownerPrReferences(
        subscription.data?.items ?? [],
        args.ownerId,
        args.ownerKind,
      ),
    [subscription.data?.items, args.ownerId, args.ownerKind],
  );
  return {
    references,
    isPending: subscription.isPending,
    error: subscription.error !== null,
    sendRefresh: subscription.sendRefresh,
  };
}
