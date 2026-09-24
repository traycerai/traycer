import { createContext, use } from "react";
import type { OpenIdentityStoreHandle } from "@/stores/identities/open-identity/store";

/**
 * Why an identity surface has no session to show.
 *
 * - `binding-pending` - the tab's host transport is still being built.
 * - `unsupported` - the host does not serve the `agentIdentity.*` family
 *   (either lane, or the unaries). Terminal for this host.
 * - `unknown` - the negotiation has not settled; a remote transport can stay
 *   here for its whole life, which is why the surface treats it as "not yet"
 *   rather than as a refusal.
 */
export type OpenIdentityGate =
  | { readonly kind: "ready"; readonly handle: OpenIdentityStoreHandle }
  | { readonly kind: "binding-pending" }
  | { readonly kind: "unsupported" }
  | { readonly kind: "unknown" };

export const OpenIdentityContext = createContext<OpenIdentityGate | null>(null);

export function useOpenIdentityGate(): OpenIdentityGate {
  const value = use(OpenIdentityContext);
  if (value === null) {
    throw new Error(
      "useOpenIdentityGate must be called inside <OpenIdentityProvider>.",
    );
  }
  return value;
}

/** The open handle, or `null` while the gate is not `ready`. */
export function useMaybeOpenIdentityHandle(): OpenIdentityStoreHandle | null {
  const gate = use(OpenIdentityContext);
  return gate?.kind === "ready" ? gate.handle : null;
}

export function useOpenIdentityHandle(): OpenIdentityStoreHandle {
  const handle = useMaybeOpenIdentityHandle();
  if (handle === null) {
    throw new Error(
      "useOpenIdentityHandle must be called under a ready <OpenIdentityProvider>.",
    );
  }
  return handle;
}
