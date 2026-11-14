import type { HostTokenAccess } from "@traycer-clients/shared/auth/host-token-lease";
import { mintHostCredentialBeforeOpen } from "@/lib/auth/host-credential-provisioning";

/**
 * Host-only tokens for this computer's own door. A computer authn has no row
 * for refuses every token with a bare 404, so on that answer the computer's
 * own credential is minted first and the token asked for again; the transport
 * then opens, and provisions that credential. Local work runs from the open;
 * cloud work waits for the provisioning.
 */
export function localDoorHostTokens(tokens: HostTokenAccess): HostTokenAccess {
  return {
    current: (userId, hostId) => tokens.current(userId, hostId),
    obtain: async (userId, hostId, fresh, signal) => {
      const outcome = await tokens.obtain(userId, hostId, fresh, signal);
      if (outcome.kind !== "not-admitted") return outcome;
      if (!(await mintHostCredentialBeforeOpen(hostId))) return outcome;
      return tokens.obtain(userId, hostId, true, signal);
    },
  };
}
