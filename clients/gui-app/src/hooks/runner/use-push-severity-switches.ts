import type { PushSeverity } from "@traycer-clients/shared/platform/runner-host";
import { usePushMutedSeveritiesMutation } from "@/hooks/runner/use-push-muted-severities-mutation";
import { usePushMutedSeveritiesQuery } from "@/hooks/runner/use-push-muted-severities-query";
import { usePushPermissionQuery } from "@/hooks/runner/use-push-permission-query";
import { useAuthStore } from "@/stores/auth/auth-store";

export interface PushSeveritySwitches {
  /** A switch's position: on while its severity is NOT muted. */
  readonly delivers: (severity: PushSeverity) => boolean;
  /** Whether the switches move at all right now. */
  readonly editable: boolean;
  readonly setDelivered: (severity: PushSeverity, delivered: boolean) => void;
}

/**
 * The phone's per-severity push switches, as Settings → Alerts draws them in
 * its Push column. Each shows what the phone stored for the signed-in account.
 * The switches only narrow what the hosts already send, so they move only
 * while pushes are on: in every other state there is nothing for them to
 * narrow, and the Push notifications row says why.
 *
 * They also move only once this account's set has been read since they
 * started showing it. A toggle sends a whole set derived from the loaded one,
 * so an answer still in flight - or one cached before a change made while the
 * switches were not showing - must not be the base it is derived from.
 *
 * Reaches the runner host, so only a shell with push may call it.
 */
export function usePushSeveritySwitches(): PushSeveritySwitches {
  const permission = usePushPermissionQuery().data;
  const granted =
    permission?.permission === "granted" &&
    permission.registration === "registered";
  const userId = useAuthStore((state) => state.contextMetadata?.userId ?? null);
  const query = usePushMutedSeveritiesQuery();
  const mutation = usePushMutedSeveritiesMutation();
  const loaded =
    query.isSuccess && query.isFetchedAfterMount ? query.data : undefined;
  const editing =
    !granted || mutation.isPending || userId === null || loaded === undefined
      ? null
      : { userId, muted: loaded };
  const shown = query.data ?? [];
  return {
    delivers: (severity) => !shown.includes(severity),
    editable: editing !== null,
    setDelivered: (severity, delivered) => {
      if (editing === null) return;
      mutation.mutate({
        userId: editing.userId,
        severities: nextMutedSeverities(editing.muted, severity, delivered),
      });
    },
  };
}

function nextMutedSeverities(
  muted: readonly PushSeverity[],
  severity: PushSeverity,
  delivered: boolean,
): readonly PushSeverity[] {
  const others = muted.filter((entry) => entry !== severity);
  return delivered ? others : [...others, severity];
}
