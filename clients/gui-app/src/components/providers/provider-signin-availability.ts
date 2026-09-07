import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import {
  providerPackBlocksExecution,
  providerPackPreparingForProvider,
  providerPackPreparingLabel,
  type ProviderPackPreparing,
} from "@/components/providers/provider-pack-readiness";
import { providerDisplayName } from "@/lib/provider-ordering";

/** Every consumer's own `oauthArgs` branch is therefore ordered after this check, never before it: a
 * terminal-login provider with `oauthArgs. */
export function providerSupportsTerminalLogin(
  loginCapability: ProviderCliState["loginCapability"] | undefined,
): boolean {
  const terminalLogin = loginCapability?.terminalLogin;
  return terminalLogin !== null && terminalLogin !== undefined;
}

/** The pack state that blocks a terminal sign-in right now, or `null` when the host would spawn the provider's
 * CLI. */
export function providerTerminalLoginPackBlock(
  state: ProviderCliState | null,
): ProviderPackPreparing | null {
  if (state === null) return null;
  const preparing = providerPackPreparingForProvider(state);
  if (preparing === null || !providerPackBlocksExecution(preparing)) {
    return null;
  }
  return preparing;
}

/** The login gate. Folded into the existing capability gate rather than added as a parallel check, so there is
 * one answer to "can this provider start an OAuth login" and the Sign in affordance cannot disagree with it. */
export function providerCanStartProfileOauth(
  state: ProviderCliState,
  isSelectedHostLocal: boolean,
): boolean {
  return providerSignInUnavailableHint(state, isSelectedHostLocal) === null;
}

/** Derived from the same three facts the boolean is, and the boolean is now derived from this. */
export function providerSignInUnavailableHint(
  state: ProviderCliState,
  isSelectedHostLocal: boolean,
): string | null {
  if (providerSupportsTerminalLogin(state.loginCapability)) {
    // A permanent provider property, so it outranks every situational reason below.
    return `${providerDisplayName(state.providerId)} is signed in from a terminal. Use the sign-in option in the chat composer.`;
  }
  const oauthArgs = state.loginCapability?.oauthArgs ?? null;
  if (oauthArgs === null || oauthArgs.length === 0) {
    // A permanent property of the provider, so it outranks the situational reasons below: telling this user to
    // switch hosts would waste their time.
    const name = providerDisplayName(state.providerId);
    if (state.providerId === "traycer") {
      return `${name} does not support browser sign-in.`;
    }
    return `${name} does not support browser sign-in. Authenticate with its own CLI, or set an API key on the Account tab.`;
  }
  if (!isSelectedHostLocal) {
    return "Signing in opens a browser on the machine running Traycer, so it is only available on a local host.";
  }
  const packPreparing = providerPackPreparingForProvider(state);
  // Blocking, not merely preparing: a login spawns whatever the resolver spawns, so a managed pack downloading
  // behind a runnable bundled/PATH/custom binary takes nothing away.
  if (packPreparing !== null && providerPackBlocksExecution(packPreparing)) {
    return providerPackPreparingLabel(
      packPreparing,
      providerDisplayName(state.providerId),
    );
  }
  return null;
}
