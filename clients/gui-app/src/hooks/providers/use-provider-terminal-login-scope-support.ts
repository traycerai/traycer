import { useHostMethodSchemaVersion } from "@/hooks/host/use-host-supports-method";
import type { ProviderTerminalLoginSurface } from "@/lib/providers/provider-terminal-login-surface";

/** The method whose negotiated MAJOR decides which scopes a host can be sent. */
export const START_TERMINAL_LOGIN_METHOD = "providers.startTerminalLogin";

/** `@1.0` has no scope field at all - it is epic-only by construction - so the client's downgrade path refuses an independent request with `DOWNGRADE_UNSUPPORTED` rather than silently filing the terminal under an epic. */
const SCOPED_START_TERMINAL_LOGIN_MAJOR = 2;

/** An unrecorded manifest, or no host at all, proves nothing and must not be described as if it did. */
export type ProviderTerminalLoginScopeSupport =
  | "supported"
  /** The host negotiated the pre-scope major: the epic action works, the
   *  landing action cannot. */
  | "unsupported"
  /** No host to ask, or its manifest is not recorded yet. */
  | "unknown";

/** Do not fill a null hostId from useAddressableHostId. */
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
