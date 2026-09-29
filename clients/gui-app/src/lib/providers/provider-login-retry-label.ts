import type { ProviderLoginRefusal } from "@traycer/protocol/host/provider-schemas";

/**
 * What the retry is, once the provider has refused this account: signing in
 * again is choosing an account, and the same one will be refused again until
 * it is verified.
 */
export function providerLoginRetryLabel(
  refusal: ProviderLoginRefusal | null,
  otherwise: string,
): string {
  return refusal === null ? otherwise : "Try another account";
}
