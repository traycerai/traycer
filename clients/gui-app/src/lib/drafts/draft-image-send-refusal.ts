/**
 * What to do about a `MISSING_ATTACHMENT_BYTES` rejection.
 *
 * The host materializes a hash-only draft image into an epic attachment at
 * send. When it cannot, it rejects with this code and — from `chat.subscribe`
 * 1.11 — a typed `cause` saying why. The three causes want three different
 * things, and getting them the same way round matters: two of them are the
 * user's problem and one of them is ours.
 *
 * | cause | who can fix it | what happens |
 * | --- | --- | --- |
 * | `not-on-host` | us | the bytes are not where we believed; drop the confirmations that said otherwise and re-send inline, ONCE |
 * | `unsupported-format` | nobody | the host's writer cannot decode this digest; stop claiming it can, and say so |
 * | `too-large` | the user | say so |
 *
 * `not-on-host` is the only retryable one because it is the only one where a
 * different request would get a different answer. Re-sending an unsupported
 * format inline is pointless in the other direction too — the node was already
 * going to be inline from then on, so a round trip buys nothing but latency
 * before the same message.
 *
 * ## Why an absent cause retries
 *
 * A 1.9 session strips `cause` (`projectChatActionAckForVersion`). The send
 * gate never sends hash-only on such a session, so in principle this cannot
 * happen — but "in principle" is not a guarantee about a frame from another
 * client or a host mid-upgrade, and `not-on-host` is the safe guess: its retry
 * sends MORE information (the bytes inline), so a wrong guess costs one round
 * trip and still delivers the message, where guessing `too-large` would surface
 * a wrong reason and deliver nothing.
 *
 * ## Once
 *
 * The retry is inline, so a second `not-on-host` is not about bytes we failed
 * to send — it is a host that cannot take this content at all. Retrying again
 * would loop. `alreadyRetried` is the caller's record on the pending action.
 */
/**
 * The 1.11 `cause` values, named here rather than imported: the protocol
 * declares them inline on the acknowledgement schema's `.extend({...})` and
 * exports no type for them. Restated deliberately, and this is the case where
 * restating is right - an independent decision table should go red when the
 * protocol adds a fourth cause, rather than silently widening to accept one it
 * has no branch for.
 */
export type DraftImageRefusalCause =
  | "unsupported-format"
  | "too-large"
  | "not-on-host";

export type DraftImageRefusalDecision =
  | {
      /**
       * Re-inline `hashes` and send once more. The caller invalidates these
       * digests' confirmations first, so the re-inline actually reads bytes
       * rather than trusting the memo that just proved wrong.
       */
      readonly kind: "retry-inline";
      readonly hashes: ReadonlyArray<string>;
    }
  | {
      /**
       * Surface the host's reason. `unbridgeable` names digests to mark as
       * undecodable by this host so they never travel bare again.
       */
      readonly kind: "surface";
      readonly unbridgeable: ReadonlyArray<string>;
    };

export function decideDraftImageRefusal(args: {
  /** The rejection's typed cause; `null` on a 1.9 session. */
  readonly cause: DraftImageRefusalCause | null;
  /** The hash-only image digests in the content that was refused. */
  readonly hashOnlyHashes: ReadonlyArray<string>;
  /** Whether this send has already spent its one inline retry. */
  readonly alreadyRetried: boolean;
}): DraftImageRefusalDecision {
  // Nothing hash-only in the content means the refusal is not about a bare
  // hash we sent, so there is nothing to invalidate, mark, or re-inline. Say
  // the host's reason and stop - a retry would re-send the identical bytes.
  if (args.hashOnlyHashes.length === 0) {
    return { kind: "surface", unbridgeable: [] };
  }
  if (args.cause === "unsupported-format") {
    return { kind: "surface", unbridgeable: args.hashOnlyHashes };
  }
  if (args.cause === "too-large") {
    return { kind: "surface", unbridgeable: [] };
  }
  // `not-on-host`, and the absent-cause fallback.
  if (args.alreadyRetried) return { kind: "surface", unbridgeable: [] };
  return { kind: "retry-inline", hashes: args.hashOnlyHashes };
}
