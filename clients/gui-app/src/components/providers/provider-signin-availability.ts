import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import {
  providerPackBlocksExecution,
  providerPackPreparingForProvider,
  providerPackPreparingLabel,
} from "@/components/providers/provider-pack-readiness";
import { providerDisplayName } from "@/lib/provider-ordering";

/**
 * Whether this provider can actually be signed in from a real terminal, rather
 * than through a headless browser-OAuth child.
 *
 * ONE helper, four consumers (this module's two exports, the composer re-auth
 * banner's `deriveLoginOptions`, and the picker's `resolveCreateProfileGate`)
 * so a surface cannot drift into offering the headless button for a provider
 * the host will refuse.
 *
 * It answers CAN, not merely `terminalLogin !== null`, because the command the
 * terminal runs is `oauthArgs` - a provider advertising `terminalLogin` with no
 * command has no terminal sign-in to offer. Folding that in here rather than
 * re-checking it per call site is what makes the consumers agree: they check
 * this in different orders relative to their own `oauthArgs` branches, and with
 * a laxer predicate those orders disagree about the same provider.
 *
 * The `!== null && !== undefined` spelling is load-bearing, not defensive
 * noise, though not for the reason it is tempting to assume. An old host's
 * payload arrives with the key filled to `null` by the v6 -> v7 upgrade bridge
 * (`registry.ts`), not absent. `undefined` comes from the optional chain: a
 * provider whose `loginCapability` is itself `null` (Cursor, Traycer) or not
 * yet loaded (a map lookup before `providers.list` resolves). A bare `!== null`
 * would read those as "supports terminal login" and tell every such provider's
 * user to sign in from a composer affordance that will never appear. `!= null`
 * would be equivalent but `eqeqeq: ["error", "always"]` forbids it.
 */
export function providerSupportsTerminalLogin(
  loginCapability: ProviderCliState["loginCapability"] | undefined,
): boolean {
  const terminalLogin = loginCapability?.terminalLogin;
  if (terminalLogin === null || terminalLogin === undefined) return false;
  const oauthArgs = loginCapability?.oauthArgs ?? null;
  return oauthArgs !== null && oauthArgs.length > 0;
}

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
  if (providerSupportsTerminalLogin(state.loginCapability)) {
    // Also a permanent provider property, and it outranks the host check
    // below for the same reason - and additionally because it is FALSE there:
    // a device flow needs no loopback, so terminal login works on a remote
    // host. Reached only with real `oauthArgs` (both this branch and the one
    // above require them), so the command exists; it just cannot run
    // headlessly.
    return `${providerDisplayName(state.providerId)} is signed in from a terminal. Use the sign-in option in the chat composer.`;
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
