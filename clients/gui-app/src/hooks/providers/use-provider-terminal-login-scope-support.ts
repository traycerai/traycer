import { useHostMethodSchemaVersion } from "@/hooks/host/use-host-supports-method";
import type { ProviderTerminalLoginSurface } from "@/lib/providers/provider-terminal-login-surface";

/** The method whose negotiated MAJOR decides which scopes a host can be sent. */
export const START_TERMINAL_LOGIN_METHOD = "providers.startTerminalLogin";

/**
 * The first major that carries a `scope`, and therefore the first that can
 * express the INDEPENDENT scope the landing panel lists. `@1.0` has no scope
 * field at all - it is epic-only by construction - so the client's downgrade
 * path refuses an independent request with `DOWNGRADE_UNSUPPORTED` rather than
 * silently filing the terminal under an epic.
 */
const SCOPED_START_TERMINAL_LOGIN_MAJOR = 2;

/**
 * Whether a host can be sent the scope a surface needs - three-valued, because
 * the copy that follows makes a POSITIVE claim on `"unsupported"` ("this
 * host's version can open the sign-in from a chat, but not from the start
 * page") and that claim is only true of a host that negotiated the pre-scope
 * major. An unrecorded manifest, or no host at all, proves nothing and must
 * not be described as if it did.
 */
export type ProviderTerminalLoginScopeSupport =
  | "supported"
  /** The host negotiated the pre-scope major: the epic action works, the
   *  landing action cannot. */
  | "unsupported"
  /** No host to ask, or its manifest is not recorded yet. */
  | "unknown";

/**
 * Whether `hostId` can be sent the scope `surface` needs.
 *
 * The provider row's `terminalLogin` capability answers "does this PROVIDER
 * have a terminal sign-in", which is a different question from "can this HOST
 * be asked for one HERE". They diverge on exactly one host: the release
 * immediately preceding the scope bump advertises `terminalLogin` and
 * negotiates `providers.startTerminalLogin@1.0`. There the epic action still
 * works - `@1.0` represents an epic scope natively - while the landing action
 * is a button that can only ever fail, and for a provider on the generic
 * guidance (Copilot) `manualCommand` is `null`, so the failure leaves the user
 * with no route at all. Hiding it hands them the guidance instead.
 *
 * `null` surface is vacuously supported: there is no surface making a claim.
 *
 * **Fails closed**, like every other negotiated-manifest gate: an unrecorded
 * host reads `"unknown"` and the landing action stays hidden. The unknown
 * state is not sticky here in practice - the picker only renders this action
 * after `providers.list` answered on that same host, and that handshake is
 * what populates the registry.
 *
 * The registry is consulted for the LANDING surface only, and only through
 * the `hostId` the caller resolved. The pickers that render this are drawn
 * inside Epic tabs as well as on the start page, and a tab resolves host
 * identity through its lifetime binding and nothing else - so this hook must
 * not reach for an app-wide host authority (`useAddressableHostId`) to fill a
 * `null`, not even on a path the epic surface then ignores: the subscription
 * itself is the violation. On the landing surface `hostId` is the composer's
 * resolved placement host, which is `null` only in the ∅ case - nothing
 * usable to create on, where submit refuses too - so a `null` there is
 * `"unknown"`: no button, and no claim about a machine there is not.
 */
export function useProviderTerminalLoginScopeSupported(
  surface: ProviderTerminalLoginSurface | null,
  hostId: string | null,
): ProviderTerminalLoginScopeSupport {
  const version = useHostMethodSchemaVersion(
    surface?.kind === "landing" ? hostId : null,
    START_TERMINAL_LOGIN_METHOD,
  );
  if (surface === null || surface.kind === "epic") return "supported";
  if (version === null) return "unknown";
  return version.major >= SCOPED_START_TERMINAL_LOGIN_MAJOR
    ? "supported"
    : "unsupported";
}
