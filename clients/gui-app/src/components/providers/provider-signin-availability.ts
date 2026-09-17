import type {
  ProviderCliState,
  ProviderLoginFailure,
} from "@traycer/protocol/host/provider-schemas";
import {
  providerPackBlocksExecution,
  providerPackPreparingForProvider,
  providerPackPreparingLabel,
  type ProviderPackPreparing,
} from "@/components/providers/provider-pack-readiness";
import { providerDisplayName } from "@/lib/provider-ordering";

/**
 * Whether this provider can actually be signed in from a real terminal, rather
 * than through a headless browser-OAuth child.
 *
 * ONE helper, five consumers (this module's two exports, the composer re-auth
 * banner's `deriveLoginOptions`, the picker's `resolveCreateProfileGate`, and
 * the picker's setup CTA via `resolveProviderTerminalSetup`) so a surface
 * cannot drift into offering the headless button for a provider the host will
 * refuse, or the terminal one for a provider it cannot open.
 *
 * It reads `terminalLogin` ALONE. The command the terminal runs is host-owned
 * (the host's `CliProfile.terminalLaunchArgs`), not `oauthArgs`: `oauthArgs`
 * is the HEADLESS command, and the providers whose sign-in lives inside their
 * own TUI (Qwen, Droid, OMP, OpenCode) ship `terminalLogin` with
 * `oauthArgs: null` precisely so a client that predates this field never
 * offers them a headless button. Requiring `oauthArgs` here - which this
 * helper once did, when Copilot and Reasonix were the only terminal-login
 * providers and both happened to carry one - hid the terminal button for
 * exactly those four. Every consumer's own `oauthArgs` branch is therefore
 * ordered AFTER this check, never before it: a terminal-login provider with
 * `oauthArgs: null` must not fall into a "no browser sign-in, use its CLI"
 * sentence when Traycer can open that CLI for the user.
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
  return terminalLogin !== null && terminalLogin !== undefined;
}

/**
 * The pack state that BLOCKS a terminal sign-in right now, or `null` when the
 * host would spawn the provider's CLI.
 *
 * A terminal login spawns that CLI exactly as a chat turn does, so it is gated
 * by the same question (`providerPackBlocksExecution`, which reads
 * `fallbackRunnable`). The headless path already folds this into
 * `providerSignInUnavailableHint` below - but that helper answers the terminal
 * case FIRST, with a permanent "signed in from a terminal" sentence, so the
 * pack check there is never reached for a terminal-login provider. Every
 * terminal action (the picker's setup CTA on both of its surfaces, the composer
 * banner's row) asks this instead, so none of them can offer a button whose
 * only possible answer is the host's `preparing` error.
 *
 * `null` state (the `providers.list` row has not arrived) reads as not blocked:
 * the same fail-open every pack gate takes, with the host resolver's typed
 * outcome as the backstop.
 */
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
 * A login capability as it can ARRIVE, which is not the same shape as one that
 * has been parsed. `remoteSafe` is a required key carrying `.catch(null)`, so
 * anything that went through the schema has it - but the response decoders skip
 * the parse entirely when the peers agree on the major and the client's minor
 * is not ahead (`rpc-codec.ts` / `ws-rpc-client.ts`, `clientCanonical.minor <=
 * hostCanonical.minor`), returning the payload by cast.
 *
 * `providers.list@9.1` is unreleased and was widened in place, so a host built
 * before the marker landed answers on that very same 9.1 with no `remoteSafe`
 * key at all, and no upgrade bridge runs to fill one - by version, the two
 * peers already agree. Spelling the marker optional here is what forces every
 * reader to decide what absence means instead of inheriting a promise the wire
 * does not keep.
 */
export type ReceivedLoginCapability = Omit<
  NonNullable<ProviderCliState["loginCapability"]>,
  "remoteSafe" | "selfOpensBrowser"
> &
  Partial<
    Pick<
      NonNullable<ProviderCliState["loginCapability"]>,
      "remoteSafe" | "selfOpensBrowser"
    >
  >;

/**
 * Headless `providers.startLogin` that does not need a localhost callback on
 * the host: Claude's paste-code page, or a flow the host marks remote-safe.
 * Terminal login is a different button (composer), so it is not this.
 */
export function providerLoginIsRemoteSafe(
  loginCapability: ReceivedLoginCapability | null | undefined,
): boolean {
  if (loginCapability === null || loginCapability === undefined) return false;
  if (loginCapability.codePaste !== null) return true;
  // Compare against PRESENCE, not against `null` - see `ReceivedLoginCapability`
  // for why absence is reachable on a wire this key is not guaranteed on. The
  // tempting spelling is `remoteSafe !== null`, and it is wrong in the one
  // direction that costs something: a capability that never carried the key at
  // all satisfies it, advertising a remote sign-in for a provider whose
  // callback lives on the machine the user is not sitting at. Refusing a
  // sign-in that would have worked costs a click; offering one that cannot
  // complete strands the user - so absence resolves to `false`.
  //
  // This reads the marker and nothing else. The `--device-auth` inference this
  // replaced now lives in the v8->v9 upgrade bridge (`registry.ts`), which is
  // where a fact about OLD hosts belongs; a host that models the key answers
  // for itself.
  return Boolean(loginCapability.remoteSafe);
}

/**
 * Whether the GUI should open `startLogin`'s URL itself.
 *
 * Two independent questions, in this order:
 *
 *  1. Is the host remote? Then the host's browser is on a machine the user
 *     cannot see, so the GUI always opens the URL - whatever the child does
 *     there is invisible and irrelevant. This branch does NOT read the
 *     capability, which is why a provider's marker is only ever observable on
 *     a LOCAL host.
 *  2. On a local host, open only if the child does not already open one.
 *     Opening the same URL twice double-opens a consent page on one `state`.
 *
 * `selfOpensBrowser` replaced `userCode !== null` as the answer to (2), and
 * the swap was forced by a measured counterexample rather than by tidiness.
 * The old premise - "device-auth children do not open a browser, so the GUI
 * must" - held for Codex and Grok and was FALSE for Kimi, which runs a
 * device-code flow and opens the browser itself. The moment the host keyed
 * Kimi device-auth, every local Kimi sign-in opened a second consent tab.
 *
 * The same docblock used to name Claude and Antigravity together as children
 * that "may already open a browser". Claude does; Antigravity does not - its
 * server prints a consent link the GUI has to open, which is why the host
 * holds `startLogin` open for that line (`EXTERNAL_LOGIN_URL_GRACE_MS`). One
 * proxy, wrong in both directions; the fact now travels per provider.
 *
 * An absent or null marker means "not known to open its own browser", so this
 * returns true and the user gets a tab. That is the fail-safe direction: a
 * duplicate tab is a nuisance, a missing one is a dead end.
 */
export function shouldAutoOpenLoginUrl(
  isLocalHost: boolean,
  loginCapability: ProviderCliState["loginCapability"] | undefined,
): boolean {
  if (!isLocalHost) return true;
  return (loginCapability?.selfOpensBrowser ?? null) === null;
}

/**
 * Locality for auto-open: a missing directory row fails closed (treat as
 * local) so we do not open a second consent tab on this machine. `null`
 * captured host id means follow the app-wide default, which may be remote.
 */
export function hostIsLocalForLoginAutoOpen(
  directory: ReadonlyArray<{ readonly hostId: string; readonly kind: string }>,
  capturedHostId: string | null,
  defaultActiveHostId: string | null,
): boolean {
  const effectiveHostId = capturedHostId ?? defaultActiveHostId;
  if (effectiveHostId === null) return true;
  return (
    directory.find((entry) => entry.hostId === effectiveHostId)?.kind !==
    "remote"
  );
}

const DEVICE_AUTH_UNAVAILABLE_MESSAGE =
  "Device-code login is not enabled for this ChatGPT account. Enable it in ChatGPT security settings (personal) or workspace permissions (admin), then retry.";
const DEVICE_CODE_MISSING_MESSAGE =
  "Sign-in did not print a device code in time. Try again.";

/** Copy for a typed `providers.startLogin` failure, or `notStarted` when none. */
export function providerStartLoginFailureMessage(
  failure: ProviderLoginFailure | null | undefined,
  notStarted: string,
): string {
  if (failure === "device_auth_unavailable") {
    return DEVICE_AUTH_UNAVAILABLE_MESSAGE;
  }
  if (failure === "device_code_missing") {
    return DEVICE_CODE_MISSING_MESSAGE;
  }
  return notStarted;
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
  if (providerSupportsTerminalLogin(state.loginCapability)) {
    // A permanent provider property, so it outranks every situational reason
    // below - and it has to precede the "no browser sign-in" branch too: a
    // terminal-login provider may ship `oauthArgs: null` (Qwen, Droid, OMP
    // and OpenCode have no headless command at all), and that branch would
    // send its user to "its own CLI" when Traycer can open that CLI for them.
    // It is also FALSE for the host check: a device flow needs no loopback,
    // so terminal login works on a remote host.
    const hint = `${providerDisplayName(state.providerId)} is signed in from a terminal. Open its model picker in a chat or on the start page and use the terminal sign-in there.`;
    return state.apiKey.supported
      ? `${hint} Or set an API key on the Account tab.`
      : hint;
  }
  const oauthArgs = state.loginCapability?.oauthArgs ?? null;
  // `null` alone, NOT `null || length === 0`. An EMPTY argv is a real headless
  // sign-in for the ACP-authenticate providers: the host spawns the server and
  // drives the ACP `authenticate` method rather than a login subcommand, so
  // the argv it needs is genuinely empty (antigravity's `agy_acp_server`;
  // Devin's `["acp"]` is non-empty only by accident of its binary layout).
  // Which providers those are is the HOST's table, invisible from here, so the
  // only honest client-side reading of a non-null argv is "the host declares a
  // headless path". An argv that is empty AND inert is refused by the host with
  // its own error, which is where that judgement belongs - a client-side
  // `length === 0` guess instead hid the button, disabled Create profile, and
  // stripped the reauth banner's OAuth option, with no way for the user to
  // discover why.
  if (oauthArgs === null) {
    // A permanent property of the provider, so it outranks the situational
    // reasons below: telling this user to switch hosts would waste their time.
    // Unreachable today for profile-capable providers (they all ship
    // oauthArgs) and for zero-profile hosts the profile section returns null
    // before calling this — kept accurate so a future call site is not wrong.
    // "Above" is intentionally gone: the API key field lives on the Account
    // tab after the providers tab split, not above this hint.
    const name = providerDisplayName(state.providerId);
    if (state.providerId === "traycer") {
      return `${name} does not support browser sign-in.`;
    }
    return `${name} does not support browser sign-in. Authenticate with its own CLI, or set an API key on the Account tab.`;
  }
  if (
    !isSelectedHostLocal &&
    !providerLoginIsRemoteSafe(state.loginCapability)
  ) {
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
