/**
 * How many of the team's chats are running on the computer. `not-known` is
 * its own state, never folded into a count of 0: a failed read, a null answer
 * or a computer that does not answer the question says nothing about what is
 * running there.
 */
export type ClaimRunningChats =
  | { readonly kind: "counted"; readonly chats: number }
  | { readonly kind: "not-known" };

/**
 * No host method answers the count yet (the head's ruling 191 gives
 * `environment.previewLocalFacts@1.0` a `{ kind: "computer" }` subject for
 * it), so it is not known.
 */
export function useClaimRunningChats(
  _hostId: string | null,
): ClaimRunningChats {
  return { kind: "not-known" };
}
