import { useMemo } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import {
  providerPackBlocksExecution,
  providerPackPreparingByHarnessId,
  providerPackPreparingLabel,
  type ProviderPackPreparing,
} from "@/components/providers/provider-pack-readiness";
import { providerDisplayName } from "@/lib/provider-ordering";
import { guiHarnessIdToProviderId } from "@/lib/provider-ordering";
import { useChatOpencodeLine } from "@/hooks/harnesses/chat-opencode-line-context";

export interface ProviderPackGate {
  /**
   * True when this harness CANNOT RUN right now - its managed pack is
   * downloading or stuck AND nothing else would spawn. Surfaces fold this into
   * their existing disabled/canSubmit expression - they must NOT branch on it
   * separately, or the button and the hint drift apart.
   */
  readonly blocked: boolean;
  /**
   * User-facing reason, or null when nothing is blocked. Every consumer feeds
   * this straight into a DISABLED-state hint, so it stays null whenever
   * `blocked` is false - a non-blocking install has progress to show, but it
   * has no business explaining why a live button is dead.
   */
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
 * "Can this harness start a turn right now?" on the composer's own host.
 *
 * The settled UX decision, applied at send time: a provider that CANNOT RUN
 * gates the AFFORDANCE - the submit button is disabled and says
 * `Preparing… X%` - rather than accepting the turn and failing, or queueing it
 * and hoping. "Cannot run" is the whole condition, and it is not the same as
 * "a download is in flight": a host with bundled bytes, a PATH install or a
 * custom path spawns while the managed pack downloads, so it blocks nothing.
 *
 * This is UX only. The host resolver is the authoritative backstop and throws
 * a typed `preparing` outcome regardless of what any client does. So this
 * gate fails OPEN by construction: while `providers.list` is still loading
 * nothing blocks, and the host has the final word.
 *
 * `active` carries the caller's focus state, and it gates the `providers.list`
 * SUBSCRIPTION rather than the gate's answer - the same treatment
 * `useProviderReauthGate` and `useProfileRateLimitSwitchPrompt` already get in
 * the chat composer, where only the focused top-level surface owns its catalog
 * subscriptions. An unfocused split partner renders its body but cannot send,
 * so a live subscription there buys nothing and costs a per-host stream.
 *
 * Passing `false` is not a behaviour change for the common case: two tiles on
 * the SAME host share one query key, so the focused tile's subscription keeps
 * the cache warm and the unfocused one still reads it. Only a tile bound to a
 * host no focused surface is watching goes without data, and that resolves to
 * the documented fail-open - nothing blocks, and the host resolver's typed
 * `preparing` outcome remains the authoritative backstop.
 */
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
  const opencodeLine = useChatOpencodeLine();
  return useMemo(() => {
    if (providers === undefined || harnessId === null) return NOT_BLOCKED;
    const preparing = providerPackPreparingByHarnessId(
      providers,
      opencodeLine,
    ).get(harnessId);
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
  }, [harnessId, opencodeLine, providers]);
}
