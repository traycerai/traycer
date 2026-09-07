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
  providerPackBlocksExecution,
  providerPackPreparingByHarnessId,
  providerPackPreparingLabel,
  type ProviderPackPreparing,
} from "@/components/providers/provider-pack-readiness";
import { providerDisplayName } from "@/lib/provider-ordering";
import { guiHarnessIdToProviderId } from "@/lib/provider-ordering";

export interface ProviderPackGate {
  /** True when this harness CANNOT RUN right now - its managed pack is downloading or stuck AND nothing else would spawn.
   * Surfaces fold this into their existing disabled/canSubmit expression - they must NOT branch on it separately, or the button and the hint drift apart. */
  readonly blocked: boolean;
  /** Every consumer feeds this straight into a DISABLED-state hint, so it stays null whenever `blocked` is false - a non-blocking install has progress to show, but it has no business explaining why a live button is dead. */
  readonly hint: string | null;
  /** Raw state, for surfaces that render their own progress affordance. */
  readonly preparing: ProviderPackPreparing | null;
}

const NOT_BLOCKED: ProviderPackGate = {
  blocked: false,
  hint: null,
  preparing: null,
};

/** Gate on cannot-run, not managedInstallState. Fail open while providers.list is loading. */
export function useProviderPackGate(
  harnessId: GuiHarnessId | null,
): ProviderPackGate {
  const providersQuery = useProvidersList({ enabled: true, subscribed: true });
  return usePackGateFromProviders(providersQuery.data?.providers, harnessId);
}

/** active gates the providers.list subscription, not the answer. Fail open with no data. */
export function useProviderPackGateForClient(
  client: HostClient<HostRpcRegistry> | null,
  harnessId: GuiHarnessId | null,
  active: boolean,
): ProviderPackGate {
  const providersQuery = useProvidersListForClient(client, {
    enabled: active,
    subscribed: active,
  });
  return usePackGateFromProviders(providersQuery.data?.providers, harnessId);
}

function usePackGateFromProviders(
  providers: ReadonlyArray<ProviderCliState> | undefined,
  harnessId: GuiHarnessId | null,
): ProviderPackGate {
  return useMemo(() => {
    if (providers === undefined || harnessId === null) return NOT_BLOCKED;
    const preparing =
      providerPackPreparingByHarnessId(providers).get(harnessId);
    if (preparing === undefined) return NOT_BLOCKED;
    // Reported, not hidden: the caller still gets `preparing` so a surface that
    // wants to show background install progress can, without any of them
    // having to re-derive whether it counts as blocking.
    if (!providerPackBlocksExecution(preparing)) {
      return { blocked: false, hint: null, preparing };
    }
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
