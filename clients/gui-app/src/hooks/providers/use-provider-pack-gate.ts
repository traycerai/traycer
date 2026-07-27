import { useMemo } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import {
  useProvidersList,
  useProvidersListForClient,
} from "@/hooks/providers/use-providers-list-query";
import {
  providerPackPreparingByHarnessId,
  providerPackPreparingLabel,
  type ProviderPackPreparing,
} from "@/components/providers/provider-pack-readiness";
import { providerDisplayName } from "@/lib/provider-ordering";
import { guiHarnessIdToProviderId } from "@/lib/provider-ordering";

export interface ProviderPackGate {
  /**
   * True when this harness's managed pack is downloading or stuck. Surfaces
   * fold this into their existing disabled/canSubmit expression - they must
   * NOT branch on it separately, or the button and the hint drift apart.
   */
  readonly blocked: boolean;
  /** User-facing reason, or null when nothing is blocked. */
  readonly hint: string | null;
  /** Raw state, for surfaces that render their own progress affordance. */
  readonly preparing: ProviderPackPreparing | null;
}

const NOT_BLOCKED: ProviderPackGate = {
  blocked: false,
  hint: null,
  preparing: null,
};

/**
 * "Can this harness start a turn right now?" for the app-wide default host.
 *
 * The settled UX decision, applied at send time: a provider whose managed pack
 * is not ready gates the AFFORDANCE - the submit button is disabled and says
 * `Preparing… X%` - rather than accepting the turn and failing, or queueing it
 * and hoping. The dictation mic does exactly this while its on-device model
 * downloads.
 *
 * This is UX only. The host resolver is the authoritative backstop and throws a
 * typed `preparing` outcome regardless of what any client does, which is what
 * keeps old GUIs, terminal launches and direct RPCs honest. So this gate fails
 * OPEN by construction: while `providers.list` is still loading there is no
 * data, nothing blocks, and the host has the final word.
 */
export function useProviderPackGate(
  harnessId: GuiHarnessId | null,
): ProviderPackGate {
  const providersQuery = useProvidersList({ enabled: true, subscribed: true });
  return usePackGateFromProviders(providersQuery.data?.providers, harnessId);
}

/** Client-scoped variant, for tab-bound surfaces that must gate on THEIR host. */
export function useProviderPackGateForClient(
  client: HostClient<HostRpcRegistry> | null,
  harnessId: GuiHarnessId | null,
): ProviderPackGate {
  const providersQuery = useProvidersListForClient(client, {
    enabled: true,
    subscribed: true,
  });
  return usePackGateFromProviders(providersQuery.data?.providers, harnessId);
}

function usePackGateFromProviders(
  providers: ReadonlyArray<ProviderCliState> | undefined,
  harnessId: GuiHarnessId | null,
): ProviderPackGate {
  return useMemo(() => {
    if (providers === undefined || harnessId === null) return NOT_BLOCKED;
    const preparing = providerPackPreparingByHarnessId(providers).get(
      harnessId,
    );
    if (preparing === undefined) return NOT_BLOCKED;
    const providerId = guiHarnessIdToProviderId(harnessId);
    const label =
      providerId === null ? harnessId : providerDisplayName(providerId);
    return {
      blocked: true,
      hint: providerPackPreparingLabel(preparing, label),
      preparing,
    };
  }, [harnessId, providers]);
}
