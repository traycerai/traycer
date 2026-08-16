/**
 * The client's one reading of `epic.chatPublicationState`'s `definitive` field.
 *
 * Shared because exactly two surfaces must agree about it and they sit on
 * opposite sides of the app's layering: the condition poll lane in
 * `lib/host-rpc-policy/host-method-policy-table.ts` (may this answer still
 * move?) and the fork dialog's verdict and copy in
 * `components/chat/chat-fork-target.ts` (what do we tell the user?). A
 * disagreement between those two IS the defect this field exists to remove —
 * a surface that keeps polling an answer it has already called terminal, or
 * one that stops polling while still promising the wait resolves itself.
 *
 * The protocol's rule, restated here because both call sites depend on it and
 * neither can see the other: a non-null reason means WAITING CANNOT CHANGE
 * THIS ANSWER. The caller must stop polling and must not present the state as
 * transient.
 */

/**
 * A reason the source chat's publication answer is frozen.
 *
 * `"unexplained"` is this client's own arm, not a wire value: a host ahead of
 * this build can name a reason that is not in the enum this build was compiled
 * against, and the only safe reading of it is terminal-but-unexplained. Mapping
 * it back to "no reason" would reintroduce the infinite wait for exactly the
 * fleet that had something new to say.
 */
export type ChatPublicationDefinitiveReason =
  "chat-deleted" | "lineage-superseded" | "backup-halted" | "unexplained";

/**
 * `null` when the ordinary reading applies and the state may still move on its
 * own; otherwise the reason, terminal by definition.
 *
 * The parameter is widened to `string | null | undefined` deliberately, and
 * BOTH widenings carry weight:
 *
 * - `string`, for the forward-compatibility rule above. An unrecognised reason
 *   is terminal-but-unexplained, never `null`.
 * - `undefined`, which is the load-bearing half. `definitive` was added to
 *   `epic.chatPublicationState` v1.0 IN PLACE, so a host built before it
 *   negotiates the same 1.0 and its response takes the same-version path in
 *   `ws-rpc-client.ts` — which casts rather than parses, because only a version
 *   MISMATCH runs the payload through a response schema. The field therefore
 *   arrives missing at runtime while the static type says it cannot be. Reading
 *   that absence as a reason would mark every pre-field host permanently halted
 *   and retire its wait lane, which is this very hang inverted: the answer that
 *   really does resolve itself would be the one nobody re-asks.
 *
 * This is the opposite trade from the `status: string` widening trap in the
 * providers poll classifier, and the difference is worth naming so neither gets
 * "fixed" into the other. There, widening broke a POSITIVE match: a rename
 * upstream silently produced `false` and dropped a live download onto the
 * fifteen-minute lane, so a precise wire type was the safe direction. Here an
 * unmatched value falls to `"unexplained"`, which is TERMINAL — the
 * conservative answer — so precision buys better copy, never correctness.
 */
export function chatPublicationDefinitiveReason(
  definitive: string | null | undefined,
): ChatPublicationDefinitiveReason | null {
  if (definitive === null || definitive === undefined) return null;
  if (definitive === "chat-deleted") return "chat-deleted";
  if (definitive === "lineage-superseded") return "lineage-superseded";
  if (definitive === "backup-halted") return "backup-halted";
  return "unexplained";
}

/**
 * Whether the reason invalidates the published head ITSELF, rather than merely
 * freezing how far that head reaches.
 *
 * The distinction is what keeps a terminal answer from over-blocking. A frozen
 * answer is still an answer, and `definitive` says only that it will not move:
 * a chat frozen at "the boundary IS covered" is a chat a remote host can still
 * pull, so blocking it would refuse a fork on the strength of good news.
 *
 * Two of the three wire reasons are not about progress at all, though — they
 * are about the identity the publication belongs to, and they hold however far
 * the head reached:
 *
 * - `chat-deleted` — the source is a tombstone on its own host, and the fork
 *   would be refused whatever the receipt says.
 * - `lineage-superseded` — the receipt this host holds describes a row a fork
 *   of THIS chat id will never fetch, so coverage of it is beside the point.
 *
 * `backup-halted` is the pure freeze: publication stopped, and whatever had
 * already been acknowledged is still there to be pulled. `"unexplained"` sits
 * with it on purpose. An unrecognised reason is a licence to stop waiting, not
 * a licence to contradict a coverage fact this client actually read; if a
 * future reason really does invalidate the head, Layer 2 refuses the fork and
 * this build learns the arm on its next release.
 */
export function definitiveInvalidatesPublishedHead(
  reason: ChatPublicationDefinitiveReason,
): boolean {
  return reason === "chat-deleted" || reason === "lineage-superseded";
}
