import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import {
  providerPackBlocksExecution,
  providerPackPreparingForProvider,
  providerPackPreparingLabel,
} from "@/components/providers/provider-pack-readiness";
import { providerDisplayName } from "@/lib/provider-ordering";

/**
 * The login gate. A provider login SPAWNS that provider's CLI, so it needs the
 * managed pack exactly as much as a chat turn does - and unlike a chat turn it
 * has no composer in front of it to explain the wait.
 *
 * Folded into the existing capability gate rather than added as a parallel
 * check, so there is one answer to "can this provider start an OAuth login"
 * and the Sign in affordance cannot disagree with it.
 */
export function providerCanStartProfileOauth(
  state: ProviderCliState,
  isSelectedHostLocal: boolean,
): boolean {
  return providerSignInUnavailableHint(state, isSelectedHostLocal) === null;
}

/**
 * WHY sign-in is unavailable, or null when it is available.
 *
 * The tooltip used to be one hardcoded sentence - "Sign in requires a local
 * host with browser sign-in available" - shown for every reason the button was
 * disabled. On a local host, which is most of them, that sentence is simply
 * false, and it is the same misdirection class `providerCliNotFoundMessage`
 * exists to kill: a user reads a precondition they already satisfy and has
 * nowhere to go.
 *
 * Derived from the same three facts the boolean is, and the boolean is now
 * derived from THIS - so the affordance and its explanation cannot disagree
 * about whether sign-in is possible, which is how the stale sentence survived.
 */
export function providerSignInUnavailableHint(
  state: ProviderCliState,
  isSelectedHostLocal: boolean,
): string | null {
  const oauthArgs = state.loginCapability?.oauthArgs ?? null;
  if (oauthArgs === null || oauthArgs.length === 0) {
    // A permanent property of the provider, so it outranks the situational
    // reasons below: telling this user to switch hosts would waste their time.
    return `${providerDisplayName(state.providerId)} does not support browser sign-in. Authenticate with its own CLI, or set an API key above.`;
  }
  if (!isSelectedHostLocal) {
    return "Signing in opens a browser on the machine running Traycer, so it is only available on a local host.";
  }
  const packPreparing = providerPackPreparingForProvider(state);
  // Blocking, not merely preparing: a login spawns whatever the resolver
  // spawns, so a managed pack downloading behind a runnable bundled/PATH/custom
  // binary takes nothing away. Withholding Sign in there would strand a user
  // whose CLI works, on a screen that shows them it works.
  if (packPreparing !== null && providerPackBlocksExecution(packPreparing)) {
    return providerPackPreparingLabel(
      packPreparing,
      providerDisplayName(state.providerId),
    );
  }
  return null;
}
