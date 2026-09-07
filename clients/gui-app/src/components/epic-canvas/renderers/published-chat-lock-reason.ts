/**
 * The locked-composer reason sentences for the two read-only chat copies.
 * Their own module so `published-chat-tile.tsx` exports only its component: a file that exports both components and non-components breaks fast refresh for everything importing it.
 */
import { formatAbsoluteDateTime } from "@/lib/relative-time";

/**
 * It names three things because a reader needs all three to know what to do: WHICH host owns the chat (so they know which machine to wake), that the host is unreachable (so they do not read the lock as a permission problem), and that this is the last published copy (so they do not assume they are seeing a turn that finished after the host went away).
 * The copy's AGE follows, when the row carries it: "Published <date>." is passive and unconditional - it never alarms, and it is the one fact about freshness this tile can state without cross-checking anything.
 */
export function publishedChatLockReason(input: {
  readonly ownerIsReachable: boolean;
  /** See the same-host sentence below for why it cannot share the cross-host one. */
  readonly ownerIsThisHost: boolean;
  /**
   * `false` is a collaborator's shared chat, and it outranks both reachability arms: the owner's machine can never appear in this account's host directory, so "which is offline" asserts liveness this device cannot observe, `ownerLabel` has fallen back to a raw host id, and "sending resumes" promises a composer this viewer does not get.
   * `true` when the owner is unknown - only a positive mismatch may flip the sentence.
   */
  readonly ownedByViewer: boolean;
  readonly ownerLabel: string;
  readonly unreadableCount: number;
  readonly fidelityNotice: string | null;
  /** When the copy on screen was published. `null` when the row omits it. */
  readonly publishedAt: number | null;
}): string {
  const parts = [publishedCopySentence(input)];
  if (input.publishedAt !== null) {
    parts.push(`Published ${formatAbsoluteDateTime(input.publishedAt)}.`);
  }
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
 * `unpublished` also covers a legacy chat that will never get a row, and a server declining to serve this viewer the row - in both cases the owner can come back online while this tile keeps rendering the replica branch, because nothing here re-checks the cloud read once it has settled.
 */
export function replicaChatLockReason(input: {
  readonly ownerIsReachable: boolean;
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
 * Reachability comes first, because that half stops being true mid-session: saying "which is offline" under a banner announcing that same host is back reads as a bug in whichever line the user believes second, and the useful instruction changes with it (there is nothing to wait for once the host is back, only a live tab to open).
 * The unreachable arm stays one sentence for both, because nothing answered: there is no "the host said it isn't here" to report, only a host to wait for, and that is as true of this machine's own host as of anyone else's.
 */
function publishedCopySentence(input: {
  readonly ownerIsReachable: boolean;
  readonly ownerIsThisHost: boolean;
  readonly ownedByViewer: boolean;
  readonly ownerLabel: string;
}): string {
  // A collaborator's chat, checked before either reachability arm: every clause below it is written for the viewer's own fleet (see the `ownedByViewer` doc above) and turns false for a machine this account cannot observe.
  if (!input.ownedByViewer) {
    return `This agent belongs to another collaborator — showing the last published copy. It isn't available live from here.`;
  }
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
  if (input.ownerIsThisHost) {
    return `Showing this device's synced copy of this agent. Its live history is no longer on this host.`;
  }
  return `Showing this device's synced copy of this agent, which lives on ${input.ownerLabel}. It is not available live from this device.`;
}

/**
 * "1 item needs..." / "2 items need...".
 * Both halves of the agreement, in one place: the noun was already pluralized per count and the verb was not, so a single unreadable block read as "1 item need a newer version of Traycer".
 */
function unreadableItemsSentence(count: number): string {
  return count === 1
    ? "1 item needs a newer version of Traycer to render."
    : `${count} items need a newer version of Traycer to render.`;
}
