/**
 * The locked-composer reason sentences for the two read-only chat copies.
 *
 * Their own module so `published-chat-tile.tsx` exports only its component: a
 * file that exports both components and non-components breaks fast refresh for
 * everything importing it. Pure string builders, moved unchanged.
 */

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
  readonly ownerLabel: string;
  readonly unreadableCount: number;
  readonly fidelityNotice: string | null;
}): string {
  // Two sentences for two different situations, because one of them stops
  // being true mid-session. Saying "which is offline" under a banner announcing
  // that same host is back reads as a bug in whichever line the user believes
  // second - and the useful instruction changes too: there is nothing to wait
  // for once the host is back, only a live tab to open.
  // Three states, because the middle one is real and neither of the others
  // describes it: a host that answers but does not hold this chat. Telling
  // someone it is offline would be false, and telling them to open it live
  // would send them at a button that can do nothing.
  const base = input.ownerIsReachable
    ? `Showing the last published copy of this agent, which lives on ${input.ownerLabel}. It is not available live from this device.`
    : `This agent lives on ${input.ownerLabel}, which is offline — showing the last published copy. Sending resumes when that host is back.`;
  if (input.unreadableCount > 0) {
    return `${base} ${unreadableItemsSentence(input.unreadableCount)}`;
  }
  if (input.fidelityNotice !== null) return `${base} ${input.fidelityNotice}`;
  return base;
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
  readonly ownerLabel: string;
  readonly unreadableCount: number;
}): string {
  const base = input.ownerIsReachable
    ? `Showing this device's synced copy of this agent, which lives on ${input.ownerLabel}. It is not available live from this device.`
    : `This agent lives on ${input.ownerLabel}, which is offline — showing this device's synced copy. Sending resumes when that host is back.`;
  if (input.unreadableCount > 0) {
    return `${base} ${unreadableItemsSentence(input.unreadableCount)}`;
  }
  return base;
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
