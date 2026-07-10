import { useCallback, useMemo, useState } from "react";
import type {
  ProviderCliState,
  ProviderId,
} from "@traycer/protocol/host/provider-schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useAcknowledgeAmbientDriftForClient } from "@/hooks/providers/use-acknowledge-ambient-drift-mutation";

export interface AmbientDriftSendNotice {
  readonly key: string;
  readonly providerId: ProviderId;
  readonly currentEmail: string | null;
  readonly previousEmail: string | null;
}

function resolveAmbientDriftNotice(
  state: ProviderCliState | null,
  profileId: string | null,
): AmbientDriftSendNotice | null {
  if (profileId !== null || state === null) return null;
  const ambient = state.profiles.find((profile) => profile.kind === "ambient");
  if (ambient === undefined || ambient.ambientDriftNotice === null) {
    return null;
  }
  return {
    key: `${state.providerId}:${ambient.profileId}:${ambient.ambientDriftNotice.changedAt}`,
    providerId: state.providerId,
    currentEmail: ambient.identity?.email ?? null,
    previousEmail: ambient.ambientDriftNotice.previousEmail,
  };
}

interface AmbientDriftGate {
  /** Non-null exactly while the send-time confirm banner should show for the
   *  CURRENT drift notice (the user hasn't acknowledged this specific key). */
  readonly pendingNotice: AmbientDriftSendNotice | null;
  /** Wraps a submit action: blocks it and surfaces the confirm banner on an
   *  unacknowledged drift, otherwise submits immediately. */
  readonly guardSubmit: (submit: () => void) => void;
  /** Acknowledges the pending notice, then runs `after` (e.g. the caller's
   *  own remaining gates + the actual submit). No-ops with nothing pending. */
  readonly acknowledge: (after: () => void) => void;
  /** Acknowledges the pending notice without submitting (the banner's
   *  "Dismiss" action). No-ops with nothing pending. */
  readonly dismiss: () => void;
}

/**
 * Owns the "Terminal account changed" send-time confirmation (multi-profile
 * ambient-drift feature): a profile-less (ambient) send whose terminal
 * account just changed identity is held back once per drift `key` until the
 * user explicitly continues or dismisses.
 *
 * Acknowledgment has two layers: a local `useState` that applies instantly
 * (and is what `guardSubmit` actually gates on - it must never wait on a
 * round trip), plus a best-effort `providers.setEnabled` RPC
 * (`acknowledgeAmbientDrift`) that durably clears the notice host-side so it
 * does not resurface after this composer remounts or `providers.list`
 * refetches. The RPC is fire-and-forget: Continue submits immediately
 * without awaiting it, and a failure (including an older host that doesn't
 * yet support the `@2.2` `profileAction` variant) never blocks or reverts
 * the local acknowledgment.
 */
export function useAmbientDriftGate(
  hostClient: HostClient<HostRpcRegistry> | null,
  state: ProviderCliState | null,
  profileId: string | null,
): AmbientDriftGate {
  const notice = resolveAmbientDriftNotice(state, profileId);
  const noticeKey = notice?.key ?? null;
  const [acknowledgedKey, setAcknowledgedKey] = useState<string | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const pendingNotice =
    notice !== null && pendingKey === notice.key ? notice : null;
  const acknowledgeMutation = useAcknowledgeAmbientDriftForClient(hostClient);

  const guardSubmit = useCallback(
    (submit: () => void): void => {
      if (noticeKey !== null && acknowledgedKey !== noticeKey) {
        setPendingKey(noticeKey);
        return;
      }
      submit();
    },
    [noticeKey, acknowledgedKey],
  );
  const acknowledge = useCallback(
    (after: () => void): void => {
      if (pendingNotice === null) return;
      setAcknowledgedKey(pendingNotice.key);
      setPendingKey(null);
      acknowledgeMutation.mutate({ providerId: pendingNotice.providerId });
      after();
    },
    [pendingNotice, acknowledgeMutation],
  );
  const dismiss = useCallback((): void => {
    acknowledge(() => {});
  }, [acknowledge]);

  return useMemo(
    () => ({ pendingNotice, guardSubmit, acknowledge, dismiss }),
    [pendingNotice, guardSubmit, acknowledge, dismiss],
  );
}
