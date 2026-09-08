import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { providerIdToGuiHarnessId } from "@/lib/provider-ordering";
import { providerSupportsTerminalLogin } from "@/components/providers/provider-signin-availability";

/**
 * S8/D22: capability-gated "Create new profile" support for the picker. It
 * mirrors Settings' `providerCanStartProfileOauth` gate
 * (`providers-settings-panel.tsx`) minus the locality conjunct D22 removed.
 * Host LOCALITY is not resolved here at all: it decides the flow's default
 * sign-in mode, not its admission, and the one place that needs it
 * (`ProviderProfileAddFlowSession`) resolves it from the captured host with
 * `useHostDirectoryEntry`. One derivation, at its only caller.
 */

export const EMPTY_LOGIN_CAPABILITY_BY_HARNESS_ID: ReadonlyMap<
  GuiHarnessId,
  ProviderCliState["loginCapability"]
> = new Map();

export function loginCapabilityByHarnessIdFromProviderStates(
  providers: ReadonlyArray<ProviderCliState>,
): ReadonlyMap<GuiHarnessId, ProviderCliState["loginCapability"]> {
  return new Map(
    providers.map((provider) => [
      providerIdToGuiHarnessId(provider.providerId),
      provider.loginCapability,
    ]),
  );
}

/**
 * D22: locality is no longer an admission conjunct - the device mode needs no
 * loopback, so a remote host is not refused here. This gate only answers
 * whether the provider itself can be signed into at all.
 */
export function resolveCreateProfileGate(
  loginCapability: ProviderCliState["loginCapability"] | undefined,
): { readonly disabled: boolean; readonly reason: string | undefined } {
  // A terminal-login provider is answered before the `oauthArgs` gate below,
  // whichever way its `oauthArgs` point. Copilot carries real ones (its
  // headless command exists, the host just refuses it), so without this it
  // would read as gate-passing and offer a "Create new profile" flow the host
  // refuses; Qwen, Droid, OMP and OpenCode carry none, and would fall to the
  // generic copy - which names browser sign-in, exactly the thing none of
  // these providers do. Ordering is safe against a null/absent capability
  // because the helper answers false for both.
  if (providerSupportsTerminalLogin(loginCapability)) {
    return {
      disabled: true,
      reason: "This provider is signed in from a terminal, not the browser.",
    };
  }
  const oauthArgs = loginCapability?.oauthArgs ?? null;
  const disabled = oauthArgs === null || oauthArgs.length === 0;
  return {
    disabled,
    reason: disabled
      ? "This provider does not support browser sign-in."
      : undefined,
  };
}
