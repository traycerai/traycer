/**
 * The locked-composer reason sentences for the two read-only chat copies.
 *
 * Their own module so `published-chat-tile.tsx` exports only its component: a
 * file that exports both components and non-components breaks fast refresh for
 * everything importing it. Pure string builders.
 */
import { formatAbsoluteDateTime } from "@/lib/relative-time";

/**
 * What the copy on screen is doing about a NEWER publication, once the record
 * head has moved past the one rendered.
 *
 * `idle` is the ordinary state - the copy is the latest head this tile knows
 * of. The other three describe a re-read for a newer head while the previous
 * transcript stays on screen: the surface never drops back to a load gate or a
 * refusal notice for a chat it has already shown, so the footer is where the
 * state is said.
 */
export type PublishedCopyRefresh =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "failed" }
  | { readonly kind: "refused"; readonly title: string };

/**
 * The locked composer's reason, in one sentence a reader can act on.
 *
 * It names three things because a reader needs all three to know what to do:
 * WHICH host owns the chat (so they know which machine to wake), that the host
 * is unreachable (so they do not read the lock as a permission problem), and
 * that this is the last published copy (so they do not assume they are seeing
 * a turn that finished after the host went away).
 *
 * The copy's AGE follows, when the row carries it: "Published <date>." is
 * passive and unconditional - it never alarms, and it reads the head that
 * produced the RENDERED transcript, not any later record head. The record head
 * is a signal to re-read, and while that re-read is in flight (or has failed)
 * the `refresh` arm says so in this same footer; the date stays the date of
 * what is on screen until the newer copy is applied.
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
   * Whether the owning host, though reachable, is known to refuse this
   * chat's epic store as written by a newer build (`HOST_OLDER_THAN_DATA`).
   * Read below the reachability arm: a host that is offline has nothing to
   * refuse, and "offline" is the more actionable sentence while it lasts.
   */
  readonly ownerRefusesStore: boolean;
  /**
   * Whether the owning host IS the host serving this read - i.e. this
   * device. See the same-host sentence below for why it cannot share the
   * cross-host one.
   */
  readonly ownerIsThisHost: boolean;
  /**
   * Whether the chat belongs to the signed-in viewer. `false` is a
   * collaborator's shared chat, and it outranks both reachability arms: the
   * owner's machine can never appear in this account's host directory, so
   * "which is offline" asserts liveness this device cannot observe,
   * `ownerLabel` has fallen back to a raw host id, and "sending resumes"
   * promises a composer this viewer does not get. `true` when the owner is
   * unknown - only a positive mismatch may flip the sentence.
   */
  readonly ownedByViewer: boolean;
  readonly ownerLabel: string;
  readonly unreadableCount: number;
  readonly fidelityNotice: string | null;
  /** When the copy on screen was published. `null` when the row omits it. */
  readonly publishedAt: number | null;
  /** What is happening about a newer publication, if anything. */
  readonly refresh: PublishedCopyRefresh;
}): string {
  const parts = [publishedCopySentence(input)];
  if (input.publishedAt !== null) {
    parts.push(`Published ${formatAbsoluteDateTime(input.publishedAt)}.`);
  }
  const refresh = refreshSentence(input.refresh);
  if (refresh !== null) parts.push(refresh);
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
 * The re-read's state, or nothing in the ordinary case.
 *
 * `failed` names the two things that will retry it - the next publication
 * and a reopen - because nothing else will: the read is keyed on the record
 * head and never polls. `refused` carries the refusal's own title so the
 * reader hears the same words the notice would have used had there been no
 * transcript to keep.
 */
function refreshSentence(refresh: PublishedCopyRefresh): string | null {
  switch (refresh.kind) {
    case "idle":
      return null;
    case "loading":
      return "A newer copy is being fetched.";
    case "failed":
      return "A newer copy could not be fetched; it will be retried on the next publication or when this agent is reopened.";
    case "refused":
      return `A newer copy could not be read: ${refusalClause(refresh.title)}`;
  }
}

/** A refusal title as a clause: lower-cased lead, one terminal period. */
function refusalClause(title: string): string {
  const trimmed = title.trim().replace(/[.!]+$/u, "");
  if (trimmed.length === 0) return "the copy was refused.";
  return `${trimmed.charAt(0).toLowerCase()}${trimmed.slice(1)}.`;
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
  readonly ownerRefusesStore: boolean;
  /** Same fact, same reason, as `publishedChatLockReason`'s. */
  readonly ownerIsThisHost: boolean;
  /** Same fact, same reason, as `publishedChatLockReason`'s. */
  readonly ownedByViewer: boolean;
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
  readonly ownerRefusesStore: boolean;
  readonly ownerIsThisHost: boolean;
  readonly ownedByViewer: boolean;
  readonly ownerLabel: string;
}): string {
  // A collaborator's chat, checked before either reachability arm: every
  // clause below it is written for the viewer's own fleet (see the
  // `ownedByViewer` doc above) and turns false for a machine this account
  // cannot observe. Aligned with the dead-tile banner's foreign-owner
  // sentence, which sits directly above this footer.
  if (!input.ownedByViewer) {
    return `This agent belongs to another collaborator — showing the last published copy. It isn't available live from here.`;
  }
  if (!input.ownerIsReachable) {
    return `This agent lives on ${input.ownerLabel}, which is offline — showing the last published copy. Sending resumes when that host is back.`;
  }
  // A reachable host that cannot READ the chat: its build is older than the
  // store a newer host wrote. "Live history is no longer on this host" would
  // be false here - it is on the host, unreadable - and the remedy is a host
  // update, so the sentence names that and nothing about devices.
  if (input.ownerRefusesStore) {
    return input.ownerIsThisHost
      ? `Showing the last published copy of this agent. This host needs an update to read its live history.`
      : `Showing the last published copy of this agent, which lives on ${input.ownerLabel}. That host needs an update to read its live history.`;
  }
  if (input.ownerIsThisHost) {
    return `Showing the last published copy of this agent. Its live history is no longer on this host.`;
  }
  return `Showing the last published copy of this agent, which lives on ${input.ownerLabel}. It is not available live from this device.`;
}

/** The doc-replica branch's counterpart, splitting the same three ways. */
function replicaCopySentence(input: {
  readonly ownerIsReachable: boolean;
  readonly ownerRefusesStore: boolean;
  readonly ownerIsThisHost: boolean;
  readonly ownedByViewer: boolean;
  readonly ownerLabel: string;
}): string {
  // Same precedence, same reason, as `publishedCopySentence`'s foreign arm.
  if (!input.ownedByViewer) {
    return `This agent belongs to another collaborator — showing this device's synced copy. It isn't available live from here.`;
  }
  if (!input.ownerIsReachable) {
    return `This agent lives on ${input.ownerLabel}, which is offline — showing this device's synced copy. Sending resumes when that host is back.`;
  }
  // Same arm, same reason, as `publishedCopySentence`'s store-refusal one.
  if (input.ownerRefusesStore) {
    return input.ownerIsThisHost
      ? `Showing this device's synced copy of this agent. This host needs an update to read its live history.`
      : `Showing this device's synced copy of this agent, which lives on ${input.ownerLabel}. That host needs an update to read its live history.`;
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
