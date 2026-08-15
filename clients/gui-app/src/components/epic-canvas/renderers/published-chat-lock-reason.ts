/**
 * The locked-composer reason sentences for the two read-only chat copies, and
 * the one predicate that decides what they may claim.
 *
 * Their own module so `published-chat-tile.tsx` exports only its component: a
 * file that exports both components and non-components breaks fast refresh for
 * everything importing it. Everything here is pure.
 */
import { formatAbsoluteDateTime } from "@/lib/relative-time";

/**
 * Whether a published copy is PROVEN to be behind the chat it copies.
 *
 * `revision` is the owning host's durable record head; `throughRecordSeq` is
 * how far the head this copy was rendered from reaches. Both are positions in
 * the same per-chat log written by the same host, so the comparison is in one
 * unit and needs no clock - unlike the two timestamps on the same row, which
 * come from different clocks (server and host) and would report skew as
 * staleness.
 *
 * STRICTLY greater, so the window where a head lands before the metadata
 * projection covering the same records - leaving the copy transiently AHEAD -
 * reads as current rather than behind. Either side missing is no evidence at
 * all, never zero: absence means unproven, and the caller's answer to unproven
 * is to state the copy's age and claim nothing further.
 */
export function isPublishedCopyBehind(input: {
  readonly revision: number | null;
  readonly throughRecordSeq: number | null;
}): boolean {
  if (input.revision === null || input.throughRecordSeq === null) return false;
  return input.revision > input.throughRecordSeq;
}

/**
 * The locked composer's reason, in one sentence a reader can act on.
 *
 * It names three things because a reader needs all three to know what to do:
 * WHICH host owns the chat (so they know which machine to wake), that the host
 * is unreachable (so they do not read the lock as a permission problem), and
 * that this is the last published copy (so they do not assume they are seeing
 * a turn that finished after the host went away).
 *
 * A fidelity gap is appended rather than shown as a separate banner: it is the
 * same sentence's subject - what you are looking at - and a second notice
 * stacked above the composer would push the transcript around for something
 * that is not an error.
 */
export function publishedChatLockReason(input: {
  /** Whether something answers to the owning host id at all. */
  readonly ownerIsReachable: boolean;
  /**
   * Whether the owning host IS the host serving this read - i.e. this
   * device. See the same-host sentence below for why it cannot share the
   * cross-host one.
   */
  readonly ownerIsThisHost: boolean;
  readonly ownerLabel: string;
  readonly unreadableCount: number;
  readonly fidelityNotice: string | null;
  /** When the copy on screen was published. `null` when the row omits it. */
  readonly publishedAt: number | null;
  /**
   * Whether the owner's log is PROVEN to run past this copy. See
   * {@link publishedCopyFreshnessSentence} for what "proven" buys.
   */
  readonly copyIsBehind: boolean;
}): string {
  const parts = [publishedCopySentence(input)];
  const freshness = publishedCopyFreshnessSentence(input);
  if (freshness !== null) parts.push(freshness);
  // The pre-existing tail, unchanged: a fidelity gap is reported only when
  // nothing unreadable already claimed the slot.
  if (input.unreadableCount > 0) {
    parts.push(unreadableItemsSentence(input.unreadableCount));
  } else if (input.fidelityNotice !== null) {
    parts.push(input.fidelityNotice);
  }
  return parts.join(" ");
}

/**
 * How fresh the copy on screen is - the two facts a reader of a published copy
 * can act on, and nothing else.
 *
 * AGE is passive and unconditional: it never alarms, and it is the only thing
 * that stays honest in the case the sequence check cannot see. If the owning
 * host stops syncing altogether, both sequences freeze together and the
 * comparison reads "not behind" while the copy ages - so the timestamp, which
 * cannot lie about itself, is what bounds that.
 *
 * BEHIND is shown ONLY on proof, and stays silent when healthy. There is no
 * hedged middle state on purpose: a "may be behind" that fires on suspicion
 * teaches readers to ignore the one that fires on evidence. The evidence is a
 * sequence comparison in a single unit (see `ChatProjection.revision`), never a
 * timestamp difference - `publishedAt` is stamped by the server and the record
 * head by the owning host, so treating their difference as lag would be
 * reading clock skew as staleness.
 *
 * Not quantified. The delta counts transcript RECORDS, which is not a unit a
 * reader thinks in - a single turn moves it by many - so a number here would
 * look precise while meaning little.
 */
function publishedCopyFreshnessSentence(input: {
  readonly publishedAt: number | null;
  readonly copyIsBehind: boolean;
}): string | null {
  if (input.publishedAt === null) {
    return input.copyIsBehind
      ? "The agent has continued since this copy was published."
      : null;
  }
  const published = `Published ${formatAbsoluteDateTime(input.publishedAt)}`;
  return input.copyIsBehind
    ? `${published}; the agent has continued since.`
    : `${published}.`;
}

/**
 * The doc-replica branch's composer lock reason.
 *
 * Branches on live reachability the same way `publishedChatLockReason` does,
 * for the same reason: the cloud read staying `unpublished` is NOT proof the
 * owner is still away. `unpublished` also covers a legacy chat that will
 * never get a row, and a server declining to serve this viewer the row - in
 * both cases the owner can come back online while this tile keeps rendering
 * the replica branch, because nothing here re-checks the cloud read once it
 * has settled. A fixed "which is offline" sentence would then render false
 * mid-session, not just after some future edit.
 */
export function replicaChatLockReason(input: {
  readonly ownerIsReachable: boolean;
  /** Same fact, same reason, as `publishedChatLockReason`'s. */
  readonly ownerIsThisHost: boolean;
  readonly ownerLabel: string;
  readonly unreadableCount: number;
}): string {
  const base = replicaCopySentence(input);
  if (input.unreadableCount > 0) {
    return `${base} ${unreadableItemsSentence(input.unreadableCount)}`;
  }
  return base;
}

/**
 * Which copy the published branch is showing, and where its live counterpart
 * is - the sentence the tails above are appended to.
 *
 * Reachability comes first, because that half stops being true mid-session:
 * saying "which is offline" under a banner announcing that same host is back
 * reads as a bug in whichever line the user believes second, and the useful
 * instruction changes with it (there is nothing to wait for once the host is
 * back, only a live tab to open). A host that ANSWERS and still does not hold
 * this chat is its own state, neither "offline" nor openable - telling that
 * reader to wait would be false, and pointing them at a live tab would send
 * them at a button that can do nothing.
 *
 * The reachable arm splits again on WHOSE host the owner is. "lives on <label> ...
 * not available live from this device" describes one machine holding the chat
 * and a second one reading it, so when the owner IS the host serving this
 * read every clause of it turns false at once: it prints the reader's own
 * machine as elsewhere and tells them the thing in front of them is somewhere
 * they are not. What is true there is narrower and says nothing about
 * devices - this host no longer has the live chat.
 *
 * The unreachable arm stays one sentence for both, because nothing answered:
 * there is no "the host said it isn't here" to report, only a host to wait
 * for, and that is as true of this machine's own host as of anyone else's.
 */
function publishedCopySentence(input: {
  readonly ownerIsReachable: boolean;
  readonly ownerIsThisHost: boolean;
  readonly ownerLabel: string;
}): string {
  if (!input.ownerIsReachable) {
    return `This agent lives on ${input.ownerLabel}, which is offline — showing the last published copy. Sending resumes when that host is back.`;
  }
  if (input.ownerIsThisHost) {
    return `Showing the last published copy of this agent. Its live history is no longer on this host.`;
  }
  return `Showing the last published copy of this agent, which lives on ${input.ownerLabel}. It is not available live from this device.`;
}

/** The doc-replica branch's counterpart, splitting the same three ways. */
function replicaCopySentence(input: {
  readonly ownerIsReachable: boolean;
  readonly ownerIsThisHost: boolean;
  readonly ownerLabel: string;
}): string {
  if (!input.ownerIsReachable) {
    return `This agent lives on ${input.ownerLabel}, which is offline — showing this device's synced copy. Sending resumes when that host is back.`;
  }
  if (input.ownerIsThisHost) {
    return `Showing this device's synced copy of this agent. Its live history is no longer on this host.`;
  }
  return `Showing this device's synced copy of this agent, which lives on ${input.ownerLabel}. It is not available live from this device.`;
}

/**
 * "1 item needs..." / "2 items need...".
 *
 * Both halves of the agreement, in one place: the noun was already pluralized
 * per count and the verb was not, so a single unreadable block read as
 * "1 item need a newer version of Traycer". Shared by the published and
 * doc-replica builders, which say the same sentence.
 */
function unreadableItemsSentence(count: number): string {
  return count === 1
    ? "1 item needs a newer version of Traycer to render."
    : `${count} items need a newer version of Traycer to render.`;
}
