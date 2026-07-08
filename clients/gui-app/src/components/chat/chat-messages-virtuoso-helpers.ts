import type {
  ItemLocation,
  ListScrollLocation,
  ScrollBehavior,
  ScrollModifier,
} from "@virtuoso.dev/message-list";
import type { Key } from "react";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";

/**
 * `@virtuoso.dev/message-list` emits transient items whose `data` is
 * `undefined`. When the transcript shrinks (branch edit, deletion of trailing
 * rows, a smaller snapshot replacing the array) its `totalCount` reactively
 * lags one propagation step behind the already-shortened data array, so the
 * visible-range builder reads `data[index]` past the new end. The library
 * guards every such read (`data == null ? undefined : data[index]`) and yields
 * `undefined` rather than throwing - delegating null-handling to the key and
 * identity callbacks. Dereferencing `data.id` without this guard threw an
 * uncaught render-time TypeError that crashed the whole app, so both callbacks
 * must tolerate a missing item. A prefixed index key is stable and cannot
 * collide with normal string or numeric message ids during the brief frame
 * before the data catches up.
 */
export function chatComputeItemKey(params: {
  data: ChatMessageModel | undefined;
  index: number;
}): Key {
  return params.data?.id ?? `missing-chat-row:${params.index}`;
}

export function chatItemIdentity(
  message: ChatMessageModel | undefined,
): string | null {
  return message?.id ?? null;
}

const MINIMAP_SCROLL_OFFSET_PX = -48;
// The reading line the active-message detector probes: one pixel past where a
// minimap jump parks the target row's top, so the row it scrolled to is the
// one reported active.
const MINIMAP_ACTIVE_ANCHOR_OFFSET_PX = Math.abs(MINIMAP_SCROLL_OFFSET_PX) + 1;
const BOTTOM_FOLLOW_TOLERANCE_PX = 48;

const INITIAL_SCROLL_MODIFIER: ScrollModifier = {
  type: "item-location",
  location: {
    index: "LAST",
    align: "end",
  },
  purgeItemSizes: true,
};

interface ChatScrollClassificationInput {
  readonly previousMessages: ReadonlyArray<ChatMessageModel> | null;
  readonly nextMessages: ReadonlyArray<ChatMessageModel>;
  /**
   * Follow-intent snapshot at classification time (render-pure: classification
   * runs during render, so it must not read refs). An unpin landing between
   * classification and Virtuoso's scroll execution is handled by the
   * component's `cancelSmoothScroll` call on the unpin gesture, not here.
   */
  readonly shouldFollowOutput: boolean;
}

interface ChatScrollPolicy {
  readonly scrollModifier: ScrollModifier;
  readonly bottomFollowIntent: boolean | null;
}

/**
 * Single coherent scroll policy for the chat list, expressed only through
 * Virtuoso Message List scroll modifiers. The list receives the FULL rendered
 * history - Virtuoso virtualizes the mounted DOM, not the data - so the data
 * changes that reach this classifier are: snapshots replacing the array
 * wholesale, sends/streams appending rows or rewriting the trailing turn,
 * branch edits (edit/delete of an earlier message) removing a suffix, and
 * NON-TAIL insertions from the transcript weave - the worktree setup card
 * anchors ABOVE its triggering user message (often while the same update drops
 * the pre-turn pending row), the genesis card pins to the very top, and
 * late-arriving rows can sort before already-rendered ones by `createdAt`.
 * The list is bottom-anchored:
 * programmatic tail targets are `end`-aligned, and history navigation uses
 * `start-no-overflow` so Virtuoso never reserves forced bottom padding that
 * the next bottom-follow update strips again.
 *
 * Keep the data change and its scroll intent paired so Virtuoso can apply the
 * scroll after its own item measurement pass:
 *
 *  1. First non-empty render: snap end-aligned to the latest message so the
 *     chat opens on the most recent exchange. `purgeItemSizes` clears stale
 *     measurements from a reused Virtuoso instance.
 *  2. Submitted user prompts, inline edits, queued flushes, and steers jump to
 *     the bottom even when the user had scrolled up. Those actions are an
 *     explicit "take me to the tail" signal and the reply streams in place.
 *  3. Other appended messages follow the bottom only when the reader's follow
 *     intent is set. Measured proximity to the bottom is NOT intent:
 *     programmatic navigation scrolls, like minimap jumps, must not be treated
 *     as permission to tail the latest message.
 *  4. Same-row trailing assistant updates use Virtuoso's content-change path
 *     when the user is not following output, and an explicit
 *     `auto-scroll-to-bottom` modifier when the user is following output. This
 *     avoids losing the tail when streamed markdown remeasures outside
 *     Virtuoso's strict bottom threshold. An unpin gesture racing an
 *     already-classified follow scroll is resolved by the component
 *     cancelling Virtuoso's smooth scroll on the gesture itself.
 *  5. Suffix removals (deleting trailing messages) anchor the remaining tail
 *     row, or stay pinned to the bottom while following output.
 *  6. Branch rewrites from editing an earlier message purge Virtuoso's item
 *     size cache and anchor `start-no-overflow` on the edited row - visible
 *     at the top when there is content below, clamped to the natural bottom
 *     when there is not (never forced padding). The old suffix no longer
 *     represents the next list's measurements, so retaining those heights can
 *     create phantom scroll space.
 *  7. Any remaining change that moves a RETAINED row to a new index (the
 *     setup-card weave, a genesis-card pin, an out-of-order arrival) purges
 *     the item size cache. Virtuoso keys measured heights by INDEX and only
 *     remaps them for its explicit "prepend"/"remove-from-start" modifiers; a
 *     plain data swap leaves the tree behind, and a shifted row never
 *     re-reports (its DOM node - keyed by message id - did not change size),
 *     so every row below it is painted at a stale offset, overlapping its
 *     neighbours until something else forces a remeasure. Sends (cases 2-3)
 *     keep their smooth scroll-to-tail modifier for pure appends, but a send
 *     whose update ALSO shifted retained rows (a send coalesced with a weave)
 *     rides the same tail-anchored purge - `auto-scroll-to-bottom` cannot
 *     carry `purgeItemSizes`.
 */
export function classifyChatScrollPolicy(
  input: ChatScrollClassificationInput,
): ChatScrollPolicy {
  const { nextMessages, previousMessages, shouldFollowOutput } = input;
  if (nextMessages.length === 0) {
    return {
      scrollModifier: undefined,
      bottomFollowIntent: true,
    };
  }
  if (previousMessages === null || previousMessages.length === 0) {
    return {
      scrollModifier: INITIAL_SCROLL_MODIFIER,
      bottomFollowIntent: true,
    };
  }
  const removedSuffixAnchorIndex = removedMessageSuffixAnchorIndex(
    previousMessages,
    nextMessages,
  );
  if (removedSuffixAnchorIndex !== null) {
    return {
      scrollModifier: removedMessageSuffixScrollModifier(
        removedSuffixAnchorIndex,
        shouldFollowOutput,
      ),
      bottomFollowIntent: shouldFollowOutput ? true : null,
    };
  }
  const branchResetIndex = branchResetUserMessageIndex(
    previousMessages,
    nextMessages,
  );
  if (branchResetIndex !== null) {
    return {
      scrollModifier: branchResetUserMessageScrollModifier(branchResetIndex),
      bottomFollowIntent: true,
    };
  }
  const newerUserIndex = newerUserMessageIndex(previousMessages, nextMessages);
  if (newerUserIndex !== null) {
    return {
      scrollModifier: sendScrollModifier(previousMessages, nextMessages),
      bottomFollowIntent: true,
    };
  }
  const replacementIndex = userActionReplacementIndex(
    previousMessages,
    nextMessages,
  );
  if (replacementIndex !== null) {
    return {
      scrollModifier: sendScrollModifier(previousMessages, nextMessages),
      bottomFollowIntent: true,
    };
  }
  if (isAppendOnlyChange(previousMessages, nextMessages)) {
    return {
      scrollModifier: appendedMessagesScrollModifier(shouldFollowOutput),
      bottomFollowIntent: null,
    };
  }
  if (hasTrailingAssistantItemChange(previousMessages, nextMessages)) {
    return {
      scrollModifier:
        trailingAssistantItemsChangeScrollModifier(shouldFollowOutput),
      bottomFollowIntent: null,
    };
  }
  const shiftedAnchorIndex = firstShiftedRetainedIndex(
    previousMessages,
    nextMessages,
  );
  if (shiftedAnchorIndex !== null) {
    return {
      scrollModifier: shiftedRetainedRowsScrollModifier(
        shiftedAnchorIndex,
        shouldFollowOutput,
      ),
      bottomFollowIntent: null,
    };
  }
  return {
    scrollModifier: undefined,
    bottomFollowIntent: null,
  };
}

export function measuredItemChangeScrollModifier(
  shouldFollowOutput: boolean,
): ScrollModifier {
  if (shouldFollowOutput) return bottomFollowScrollModifier("auto");
  return measuredOnlyScrollModifier("auto");
}

export function isNearChatBottom(location: ListScrollLocation): boolean {
  return (
    location.isAtBottom ||
    location.bottomOffset <= BOTTOM_FOLLOW_TOLERANCE_PX ||
    location.scrollHeight <= location.visibleListHeight
  );
}

export function buildMessageIdToIndex(
  messages: ReadonlyArray<ChatMessageModel>,
): ReadonlyMap<string, number> {
  return new Map(
    messages.map((message, index) => [message.id, index] as const),
  );
}

export function chatScrollLocationForMessage(
  messageId: string,
  messageIndexById: ReadonlyMap<string, number>,
  behavior: ScrollBehavior,
): ItemLocation | null {
  const index = messageIndexById.get(messageId);
  if (index === undefined) return null;
  return {
    index,
    align: "start",
    offset: MINIMAP_SCROLL_OFFSET_PX,
    behavior,
  };
}

export function selectActiveUserMessageId(
  messages: ReadonlyArray<ChatMessageModel>,
  viewportRowMessageId: string | null,
  atBottom: boolean,
): string | null {
  // The minimap rail only lists human-sent rows, so the active id must be
  // selected from the same set - agent-to-agent traffic renders as
  // `role: "user"` but never appears as a rail dot.
  const userMessages = messages.filter(isHumanUserMessage);
  if (userMessages.length === 0) return null;
  if (atBottom) return userMessages.at(-1)?.id ?? null;

  if (viewportRowMessageId === null) return userMessages.at(-1)?.id ?? null;

  const viewportRowIndex = messages.findIndex(
    (message) => message.id === viewportRowMessageId,
  );
  if (viewportRowIndex === -1) return userMessages.at(-1)?.id ?? null;

  const crossedUser = messages
    .slice(0, viewportRowIndex + 1)
    .filter(isHumanUserMessage)
    .at(-1);
  if (crossedUser !== undefined) return crossedUser.id;

  return (
    messages.slice(viewportRowIndex + 1).find(isHumanUserMessage)?.id ?? null
  );
}

/**
 * Resolves the active (human) user message for an unpinned viewport: finds the
 * transcript row at the reading line, then maps it to the owning rail entry.
 * `null` when the scroller cannot be measured (concealed surface, no rows yet).
 */
export function viewportActiveUserMessageId(
  scroller: HTMLElement | null,
  messages: ReadonlyArray<ChatMessageModel>,
): string | null {
  const viewportRowMessageId = chatViewportAnchorMessageId(
    scroller,
    MINIMAP_ACTIVE_ANCHOR_OFFSET_PX,
  );
  if (viewportRowMessageId === null) return null;
  return selectActiveUserMessageId(messages, viewportRowMessageId, false);
}

export function chatViewportAnchorMessageId(
  scroller: HTMLElement | null,
  anchorOffsetPx: number,
): string | null {
  if (scroller === null) return null;
  const scrollerRect = scroller.getBoundingClientRect();
  if (scrollerRect.height <= 0) return null;

  const anchorY = Math.min(
    scrollerRect.bottom - 1,
    Math.max(scrollerRect.top, scrollerRect.top + anchorOffsetPx),
  );
  let closestBelowId: string | null = null;
  let closestBelowDistance = Number.POSITIVE_INFINITY;
  let closestAboveId: string | null = null;
  let closestAboveDistance = Number.POSITIVE_INFINITY;

  for (const row of scroller.querySelectorAll<HTMLElement>(
    "[data-message-id]",
  )) {
    const messageId = row.dataset.messageId;
    if (messageId === undefined || messageId.length === 0) continue;

    const rect = row.getBoundingClientRect();
    if (rect.height <= 0) continue;
    if (rect.bottom <= scrollerRect.top || rect.top >= scrollerRect.bottom) {
      continue;
    }
    if (rect.top <= anchorY && rect.bottom > anchorY) return messageId;

    if (rect.top > anchorY) {
      const distance = rect.top - anchorY;
      if (distance < closestBelowDistance) {
        closestBelowDistance = distance;
        closestBelowId = messageId;
      }
      continue;
    }

    const distance = anchorY - rect.bottom;
    if (distance < closestAboveDistance) {
      closestAboveDistance = distance;
      closestAboveId = messageId;
    }
  }

  return closestBelowId ?? closestAboveId;
}

function newerUserMessageIndex(
  previousMessages: ReadonlyArray<ChatMessageModel>,
  nextMessages: ReadonlyArray<ChatMessageModel>,
): number | null {
  const previousMaxCreatedAt = previousMessages.reduce(
    (max, message) => (message.createdAt > max ? message.createdAt : max),
    Number.NEGATIVE_INFINITY,
  );
  const previousIds = new Set(previousMessages.map((message) => message.id));
  for (let index = nextMessages.length - 1; index >= 0; index -= 1) {
    const message = nextMessages[index];
    if (
      isUserMessage(message) &&
      !previousIds.has(message.id) &&
      message.createdAt > previousMaxCreatedAt
    ) {
      return index;
    }
  }
  return null;
}

function branchResetUserMessageIndex(
  previousMessages: ReadonlyArray<ChatMessageModel>,
  nextMessages: ReadonlyArray<ChatMessageModel>,
): number | null {
  if (isPrependOnlyChange(previousMessages, nextMessages)) return null;
  if (isAppendOnlyChange(previousMessages, nextMessages)) return null;
  const changed = firstChangedMessage(previousMessages, nextMessages);
  if (changed === null) return null;
  const previousIds = new Set(previousMessages.map((message) => message.id));
  if (isUserMessage(changed.message) && !previousIds.has(changed.message.id)) {
    return changed.index;
  }
  return null;
}

function branchResetUserMessageScrollModifier(index: number): ScrollModifier {
  return {
    type: "item-location",
    location: {
      index,
      // `start-no-overflow` clamps to the natural max scroll. Plain `start`
      // on a near-tail edit would make Virtuoso reserve forced bottom padding
      // (an empty viewport) that the next streamed update strips again.
      align: "start-no-overflow",
      behavior: "auto",
    },
    purgeItemSizes: true,
  };
}

function removedMessageSuffixAnchorIndex(
  previousMessages: ReadonlyArray<ChatMessageModel>,
  nextMessages: ReadonlyArray<ChatMessageModel>,
): number | null {
  if (nextMessages.length === 0) return null;
  if (nextMessages.length >= previousMessages.length) return null;
  for (let index = 0; index < nextMessages.length; index += 1) {
    if (previousMessages[index].id !== nextMessages[index]?.id) return null;
  }
  return nextMessages.length - 1;
}

function removedMessageSuffixScrollModifier(
  anchorIndex: number,
  shouldFollowOutput: boolean,
): ScrollModifier {
  return {
    type: "item-location",
    location: shouldFollowOutput
      ? {
          index: "LAST",
          align: "end",
          behavior: "auto",
        }
      : {
          index: anchorIndex,
          align: "start-no-overflow",
          behavior: "auto",
        },
    purgeItemSizes: true,
  };
}

/**
 * Scroll modifier for an explicit send (a new user row or a user-action
 * replacement). Normally the unconditional smooth scroll-to-tail; but when the
 * SAME update also moved retained rows to new indexes (a send coalesced with a
 * setup-card weave or another non-tail insertion), Virtuoso's index-keyed size
 * cache is stale for every shifted row (case 7 above), and
 * `auto-scroll-to-bottom` cannot carry `purgeItemSizes` - so the tail jump
 * rides the tail-anchored purge instead.
 */
function sendScrollModifier(
  previousMessages: ReadonlyArray<ChatMessageModel>,
  nextMessages: ReadonlyArray<ChatMessageModel>,
): ScrollModifier {
  if (firstShiftedRetainedIndex(previousMessages, nextMessages) === null) {
    return submittedUserMessageScrollModifier();
  }
  return tailAnchoredPurgeScrollModifier();
}

function submittedUserMessageScrollModifier(): ScrollModifier {
  // A send is an explicit "take me to the tail" action, so this scroll is
  // unconditional (no live-intent gate: the submit itself just set the
  // intent, and the ref may not have synced yet when Virtuoso fires this).
  // End-aligned on purpose - aligning the submitted row to `start` would
  // reserve a viewport of forced bottom padding that the very next appended
  // assistant row strips again (top-anchor-then-collapse jank).
  return {
    type: "auto-scroll-to-bottom",
    autoScroll: (params) => {
      return {
        index: "LAST",
        align: "end",
        // Smooth when already tailing; instant when the user had scrolled far
        // up (a long smooth animation across the whole history feels laggy).
        behavior:
          params.atBottom || params.scrollInProgress ? "smooth" : "auto",
      };
    },
  };
}

function userActionReplacementIndex(
  previousMessages: ReadonlyArray<ChatMessageModel>,
  nextMessages: ReadonlyArray<ChatMessageModel>,
): number | null {
  if (isPrependOnlyChange(previousMessages, nextMessages)) return null;
  const changed = firstChangedMessage(previousMessages, nextMessages);
  if (changed === null) return null;
  const previousIds = new Set(previousMessages.map((message) => message.id));
  if (isUserMessage(changed.message) && !previousIds.has(changed.message.id)) {
    return changed.index;
  }
  return null;
}

function isAppendOnlyChange(
  previousMessages: ReadonlyArray<ChatMessageModel>,
  nextMessages: ReadonlyArray<ChatMessageModel>,
): boolean {
  if (nextMessages.length <= previousMessages.length) return false;
  for (let index = 0; index < previousMessages.length; index += 1) {
    if (previousMessages[index].id !== nextMessages[index]?.id) return false;
  }
  return true;
}

function isPrependOnlyChange(
  previousMessages: ReadonlyArray<ChatMessageModel>,
  nextMessages: ReadonlyArray<ChatMessageModel>,
): boolean {
  if (nextMessages.length <= previousMessages.length) return false;
  const offset = nextMessages.length - previousMessages.length;
  for (let index = 0; index < previousMessages.length; index += 1) {
    if (previousMessages[index].id !== nextMessages[index + offset]?.id) {
      return false;
    }
  }
  return true;
}

function appendedMessagesScrollModifier(
  shouldFollowOutput: boolean,
): ScrollModifier {
  // Intent only. Measured proximity to the bottom is deliberately NOT a
  // fallback trigger: during streaming the viewport constantly sits inside
  // the tolerance band, and a position-based override would drag an unpinned
  // reader back down.
  return {
    type: "auto-scroll-to-bottom",
    autoScroll: () => (shouldFollowOutput ? "smooth" : false),
  };
}

function hasTrailingAssistantItemChange(
  previousMessages: ReadonlyArray<ChatMessageModel>,
  nextMessages: ReadonlyArray<ChatMessageModel>,
): boolean {
  if (previousMessages.length !== nextMessages.length) return false;
  if (nextMessages.length === 0) return false;
  for (let index = 0; index < previousMessages.length; index += 1) {
    if (previousMessages[index].id !== nextMessages[index]?.id) return false;
  }
  const previousLast = previousMessages.at(-1);
  const nextLast = nextMessages.at(-1);
  return (
    previousLast !== undefined &&
    nextLast !== undefined &&
    nextLast.role === "assistant" &&
    previousLast !== nextLast
  );
}

function trailingAssistantItemsChangeScrollModifier(
  shouldFollowOutput: boolean,
): ScrollModifier {
  if (shouldFollowOutput) return bottomFollowScrollModifier("smooth");
  return measuredOnlyScrollModifier("smooth");
}

/**
 * New index of the first RETAINED row (present in both lists) whose index
 * changed, or `null` when every shared row kept its position. A shifted
 * retained row invalidates Virtuoso's index-keyed size cache for itself and
 * every row after it - see case 7 in `classifyChatScrollPolicy`. Runs only
 * after the append-only / trailing-change fast paths have already returned,
 * so streaming updates never pay for the scan.
 */
function firstShiftedRetainedIndex(
  previousMessages: ReadonlyArray<ChatMessageModel>,
  nextMessages: ReadonlyArray<ChatMessageModel>,
): number | null {
  const previousIndexById = buildMessageIdToIndex(previousMessages);
  const shiftedIndex = nextMessages.findIndex((message, index) => {
    const previousIndex = previousIndexById.get(message.id);
    return previousIndex !== undefined && previousIndex !== index;
  });
  return shiftedIndex === -1 ? null : shiftedIndex;
}

/**
 * Stale measurements MUST be purged (Virtuoso only remaps sizes for its
 * "prepend"/"remove-from-start" modifiers, and `purgeItemSizes` rides only on
 * `item-location`), and a purge needs an explicit anchor. Pinned readers
 * re-anchor at the tail; unpinned readers anchor on the first shifted row -
 * the insertion boundary - since the classifier is render-pure and cannot
 * probe which row the viewport is actually on.
 */
function shiftedRetainedRowsScrollModifier(
  anchorIndex: number,
  shouldFollowOutput: boolean,
): ScrollModifier {
  if (shouldFollowOutput) return tailAnchoredPurgeScrollModifier();
  return {
    type: "item-location",
    location: {
      index: anchorIndex,
      align: "start-no-overflow",
      behavior: "auto",
    },
    purgeItemSizes: true,
  };
}

function tailAnchoredPurgeScrollModifier(): ScrollModifier {
  return {
    type: "item-location",
    location: {
      index: "LAST",
      align: "end",
      behavior: "auto",
    },
    purgeItemSizes: true,
  };
}

function measuredOnlyScrollModifier(behavior: ScrollBehavior): ScrollModifier {
  return {
    type: "items-change",
    behavior,
  };
}

function bottomFollowScrollModifier(behavior: ScrollBehavior): ScrollModifier {
  return {
    type: "auto-scroll-to-bottom",
    autoScroll: () => behavior,
  };
}

interface FirstChangedMessage {
  readonly index: number;
  readonly message: ChatMessageModel;
}

/**
 * First index where the two lists diverge by id, with the message now at that
 * index. `null` when nothing new appears at a divergence point: equal lists,
 * or a pure suffix removal (the shorter next list is a prefix of the
 * previous one).
 */
function firstChangedMessage(
  previousMessages: ReadonlyArray<ChatMessageModel>,
  nextMessages: ReadonlyArray<ChatMessageModel>,
): FirstChangedMessage | null {
  const sharedLength = Math.min(previousMessages.length, nextMessages.length);
  for (let index = 0; index < sharedLength; index += 1) {
    if (previousMessages[index].id !== nextMessages[index].id) {
      return { index, message: nextMessages[index] };
    }
  }
  if (nextMessages.length > previousMessages.length) {
    return { index: sharedLength, message: nextMessages[sharedLength] };
  }
  return null;
}

function isUserMessage(message: ChatMessageModel): boolean {
  return message.role === "user";
}

function isHumanUserMessage(message: ChatMessageModel): boolean {
  return message.role === "user" && message.agentSenderInfo === null;
}
