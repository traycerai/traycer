import type { QueryClient } from "@tanstack/react-query";
import {
  PROFILE_SYNC_MAX_BATCHES,
  PROFILE_SYNC_MAX_LIST_ITEMS,
  PROFILE_SYNC_MAX_RULES,
  type ProfileSyncBatch,
  type ProfileSyncItem,
  type ProfileSyncList,
  type ProfileSyncRule,
} from "@traycer/protocol/host/profile-sync-schemas";
import {
  reconcileProfileCopyRetryOutcome,
  type ProfileCopyAttempt,
  type ProfileCopyOutcome,
} from "@/lib/profile-copy/profile-copy-model";
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
      // A batch answer carries no rule information. Keep an unknown list unknown.
      if (previous === undefined) return previous;
      const candidates = [
        ...previous.batches.filter((prior) => prior.batchId !== batch.batchId),
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
      return { rules: previous.rules, batches: batches.reverse() };
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
      // A single rule likewise cannot establish the rest of an unknown list.
      if (previous === undefined) return previous;
      const current = previous.rules.find(
        (prior) => prior.destinationHostId === rule.destinationHostId,
      );
      // A poll can observe this rule stopped/replaced while Save is in transit.
      if (
        (current === undefined && submitted !== undefined) ||
        (current !== undefined &&
          (current.ruleId !== rule.ruleId || current.revision >= rule.revision))
      )
        return previous;
      const others = previous.rules.filter(
        (prior) =>
          prior.ruleId !== rule.ruleId &&
          prior.destinationHostId !== rule.destinationHostId,
      );
      return {
        batches: previous.batches,
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

export interface ProfileSyncRetryReceipt {
  readonly batchId: string;
  readonly requested: ProfileCopyAttempt;
  readonly outcome: ProfileCopyOutcome;
}

const RETRY_PRESERVED_STATES: ReadonlySet<ProfileSyncItem["state"]> = new Set([
  "synced",
  "already-present",
  "paused",
  "conflict",
  "source-removed",
]);

function retrySyncState(outcome: ProfileCopyOutcome): ProfileSyncItem["state"] {
  switch (outcome.state) {
    case "already-present":
      return "queued";
    case "outcome-unknown":
      return "unconfirmed";
    case "signed-in":
    case "used-without-verification":
      return "queued";
    case "preparing":
    case "signing-in":
    case "verifying":
      return "copying";
    default:
      return "needs-action";
  }
}

/** Retry updates a copy receipt; it does not confirm applied sync settings. */
export function reconcileSyncRetryBatch(
  batch: ProfileSyncBatch,
  receipt: ProfileSyncRetryReceipt,
): ProfileSyncBatch {
  if (
    batch.batchId !== receipt.batchId ||
    batch.sourceHostId !== receipt.requested.sourceHostId
  )
    return batch;
  const items = batch.items.map((item) => {
    if (
      item.operationId !== receipt.requested.operationId ||
      item.outcome === null
    )
      return item;
    const outcome = reconcileProfileCopyRetryOutcome(
      item.outcome,
      receipt.requested,
      receipt.outcome,
    );
    if (outcome === item.outcome) return item;
    return {
      ...item,
      outcome,
      state:
        item.identityChanged || RETRY_PRESERVED_STATES.has(item.state)
          ? item.state
          : retrySyncState(outcome),
    };
  });
  return items.some((item, index) => item !== batch.items[index])
    ? { ...batch, items }
    : batch;
}
/** A destination draft can advance before the source driver has polled it. */
export function reconcileSyncListBatch(
  observed: ProfileSyncBatch,
  retained: ProfileSyncBatch,
): ProfileSyncBatch {
  const items = observed.items.map((item) => {
    const prior = retained.items.find(
      (candidate) => candidate.operationId === item.operationId,
    );
    if (
      prior?.outcome === null ||
      prior?.outcome === undefined ||
      item.outcome === null ||
      prior.outcome.attempt.attemptId !== item.outcome.attempt.attemptId ||
      prior.outcome.revision <= item.outcome.revision
    )
      return item;
    return (
      reconcileSyncRetryBatch(
        { ...observed, items: [item] },
        {
          batchId: observed.batchId,
          requested: item.outcome.attempt,
          outcome: prior.outcome,
        },
      ).items[0] ?? item
    );
  });
  return items.some((item, index) => item !== observed.items[index])
    ? { ...observed, items }
    : observed;
}
