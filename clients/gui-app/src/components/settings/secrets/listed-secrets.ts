/**
 * Whether the Secrets page lists a secret. A model provider's key is set and
 * cleared on that provider's page, so it never appears here. The list read
 * itself still carries it: the team Providers rail reads its state word from
 * that list.
 */
export function isListedSecret(secret: { readonly kind: string }): boolean {
  // Hide only the one retired kind: a list of kinds to show would hide any
  // newer kind it forgot.
  return secret.kind !== "provider";
}
