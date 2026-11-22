import type { HostTokenAccess } from "@traycer-clients/shared/auth/host-token-lease";
import { mintHostCredentialBeforeOpen } from "@/lib/auth/host-credential-provisioning";

/**
 * authn refuses every token for a computer it has no row for with a bare 404, so
 * the computer's own credential is minted first and the token asked again.
 */
export function localDoorHostTokens(tokens: HostTokenAccess): HostTokenAccess {
  return {
    current: (userId, hostId) => tokens.current(userId, hostId),
    loaded: () => tokens.loaded(),
    whenLoaded: () => tokens.whenLoaded(),
    obtain: async (userId, hostId, fresh, signal) => {
      const outcome = await tokens.obtain(userId, hostId, fresh, signal);
      if (outcome.kind !== "not-admitted") return outcome;
      if (!(await mintHostCredentialBeforeOpen(hostId))) return outcome;
      return tokens.obtain(userId, hostId, true, signal);
    },
  };
}
