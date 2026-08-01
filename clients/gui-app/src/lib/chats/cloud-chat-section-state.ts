import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";

/**
 * What the sidebar's cloud-chat section should show, decided as data.
 *
 * ## Four different reasons collapse to `hidden`, on purpose
 *
 * A host that predates the cloud-chat methods, any other failure, a viewer who
 * is not signed in, and a task whose every cloud chat is already on this device
 * all render NOTHING. None of them is a state a user can act on from a sidebar,
 * and a section announcing "cloud chats unavailable" would be a permanent
 * notice on every older host. The distinction that matters - "your other
 * devices' chats are here" versus "there is nothing to add" - is carried by the
 * section's PRESENCE.
 *
 * The signed-out case is the one worth spelling out, because it is the one that
 * looks like loading and is not. A disabled TanStack query reports
 * `isPending` forever - it has no data and never will until something enables
 * it - so a section keyed on `isPending` alone would spin indefinitely for
 * every signed-out user. `isFetching` is what separates "in flight" from "never
 * started", and only the first is worth a spinner.
 *
 * Extracted from the component so the rule is assertable without a renderer,
 * and so the component is thin enough that a render test would only be testing
 * its own mocks.
 */

export type CloudChatSectionState =
  /** Render nothing at all. */
  | { readonly kind: "hidden" }
  /** The list is in flight and this device has never answered it. */
  | { readonly kind: "loading" }
  | { readonly kind: "rows"; readonly rows: readonly CloudChatSummary[] };

export type CloudChatSectionInputs = {
  readonly chats: readonly CloudChatSummary[] | undefined;
  readonly isError: boolean;
  /**
   * Whether a request is actually in flight. Distinguishes a query that is
   * loading from one that is DISABLED (no viewer, no task) or paused - both of
   * which report `isPending` with nothing on the way.
   */
  readonly isFetching: boolean;
  /** Chat ids the local tree already renders. Sorted; see `useEpicChatIds`. */
  readonly localChatIds: readonly string[];
};

export function composeCloudChatSectionState(
  inputs: CloudChatSectionInputs,
): CloudChatSectionState {
  if (inputs.isError) return { kind: "hidden" };
  // `isPending` is deliberately NOT consulted beyond this: having `chats` and
  // being pending is a state TanStack does not produce, and a guard for it
  // would hide rows that are sitting right there.
  if (inputs.chats === undefined) {
    return inputs.isFetching ? { kind: "loading" } : { kind: "hidden" };
  }

  const rows = selectCloudOnlyChats(inputs.chats, inputs.localChatIds);
  return rows.length === 0 ? { kind: "hidden" } : { kind: "rows", rows };
}

/**
 * The cloud rows this device is NOT already showing.
 *
 * A chat the local tree renders must not also appear under "on your other
 * devices", or one chat reads as two. Matching is on `chatId` alone rather than
 * the identity triple, deliberately: the local tree's ids are this device's
 * own, so a cloud row sharing one either IS that chat, or is a foreign chat
 * whose host minted a colliding id - and in the second case showing it beside
 * an identically-named local row is worse than omitting it. The read path
 * refuses that collision explicitly when it is opened; the list does not have
 * the information to tell the two apart.
 */
export function selectCloudOnlyChats(
  chats: readonly CloudChatSummary[],
  localChatIds: readonly string[],
): readonly CloudChatSummary[] {
  return chats.filter((chat) => !localChatIds.includes(chat.identity.chatId));
}

/**
 * A row key over the whole identity TRIPLE.
 *
 * `chatId` alone is host-minted and two hosts can mint the same one under a
 * task, so keying on it would collapse two genuinely different rows into one
 * React element - and swap their content when the list reorders.
 */
export function cloudChatRowKey(identity: {
  readonly taskId: string;
  readonly ownerUserId: string;
  readonly chatId: string;
}): string {
  return `${identity.taskId}:${identity.ownerUserId}:${identity.chatId}`;
}
