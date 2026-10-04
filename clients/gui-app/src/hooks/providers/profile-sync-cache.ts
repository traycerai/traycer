import type { QueryClient } from "@tanstack/react-query";
import {
  PROFILE_SYNC_MAX_BATCHES,
  PROFILE_SYNC_MAX_LIST_ITEMS,
  PROFILE_SYNC_MAX_RULES,
  type ProfileSyncBatch,
  type ProfileSyncList,
  type ProfileSyncRule,
} from "@traycer/protocol/host/profile-sync-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";

export function profileSyncListKey(sourceHostId: string): readonly unknown[] {
  return hostQueryKeys.method<
    HostRpcRegistry,
    "providers.profileCopy.sync.list"
  >(sourceHostId, "providers.profileCopy.sync.list", { sourceHostId });
}

/** Publish an accepted run before its dialog can close. Keep whole batches. */
export function writeProfileSyncBatch(
  queryClient: QueryClient,
  batch: ProfileSyncBatch,
): void {
  queryClient.setQueryData<ProfileSyncList>(
    profileSyncListKey(batch.sourceHostId),
    (previous) => {
      const candidates = [
        ...(previous?.batches.filter(
          (prior) => prior.batchId !== batch.batchId,
        ) ?? []),
        batch,
      ];
      let items = 0;
      const batches: ProfileSyncBatch[] = [];
      for (const candidate of candidates.toReversed()) {
        if (
          batches.length >= PROFILE_SYNC_MAX_BATCHES ||
          items + candidate.items.length > PROFILE_SYNC_MAX_LIST_ITEMS
        )
          break;
        batches.push(candidate);
        items += candidate.items.length;
      }
      return { rules: previous?.rules ?? [], batches: batches.reverse() };
    },
  );
}

export function writeProfileSyncSavedRule(
  queryClient: QueryClient,
  rule: ProfileSyncRule,
  submitted: ProfileSyncRule | undefined,
): void {
  queryClient.setQueryData<ProfileSyncList>(
    profileSyncListKey(rule.sourceHostId),
    (previous) => {
      const current = previous?.rules.find(
        (prior) => prior.destinationHostId === rule.destinationHostId,
      );
      // A poll can observe this rule stopped/replaced while Save is in transit.
      if (
        (current === undefined && submitted !== undefined) ||
        (current !== undefined &&
          (current.ruleId !== rule.ruleId || current.revision >= rule.revision))
      )
        return previous;
      const others =
        previous?.rules.filter(
          (prior) =>
            prior.ruleId !== rule.ruleId &&
            prior.destinationHostId !== rule.destinationHostId,
        ) ?? [];
      return {
        batches: previous?.batches ?? [],
        rules: [...others.slice(-(PROFILE_SYNC_MAX_RULES - 1)), rule],
      };
    },
  );
}

export function writeProfileSyncStoppedRule(
  queryClient: QueryClient,
  sourceHostId: string,
  ruleId: string,
  response: ProfileSyncList,
): void {
  queryClient.setQueryData<ProfileSyncList>(
    profileSyncListKey(sourceHostId),
    (previous) => ({
      batches: previous?.batches ?? response.batches,
      // Stop confirms one removal; its sibling snapshot may predate another write.
      rules: (previous?.rules ?? response.rules).filter(
        (rule) => rule.ruleId !== ruleId,
      ),
    }),
  );
}

/** A read sent before an accepted write must not supersede its response. */
export function cancelProfileSyncList(
  queryClient: QueryClient,
  sourceHostId: string,
): Promise<void> {
  return queryClient.cancelQueries({
    queryKey: hostQueryKeys.methodScope(
      sourceHostId,
      "providers.profileCopy.sync.list",
    ),
  });
}

export async function refreshProfileSyncAfterWrite(
  queryClient: QueryClient,
  sourceHostId: string,
  publish: (() => void) | null,
): Promise<void> {
  await cancelProfileSyncList(queryClient, sourceHostId);
  publish?.();
  void queryClient.invalidateQueries({
    queryKey: hostQueryKeys.methodScope(
      sourceHostId,
      "providers.profileCopy.sync.list",
    ),
  });
  void queryClient.invalidateQueries({
    queryKey: hostQueryKeys.methodScope(
      sourceHostId,
      "providers.profileCopy.sync.preview",
    ),
  });
}
