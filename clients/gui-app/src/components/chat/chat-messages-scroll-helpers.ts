import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";

/**
 * Per-press step for the transcript's arrow-key scrolling. Chromium's own
 * arrow-key scroll step is 40px; matching it keeps the transcript feeling like
 * any other scroll region.
 */
export const CHAT_ARROW_SCROLL_STEP_PX = 40;

/** Reveal offset for programmatic message navigation (minimap clicks, find,
 *  deep links): the target row's top sits this many px below the viewport
 *  top, leaving a sliver of the preceding row visible for context. */
export const CHAT_TIMELINE_NAVIGATION_VIEW_OFFSET_PX = 48;

export function buildMessageIdToIndex(
  messages: ReadonlyArray<ChatMessageModel>,
): ReadonlyMap<string, number> {
  return new Map(
    messages.map((message, index) => [message.id, index] as const),
  );
}

/**
 * Ticket 10: `role: "user"` covers two visually distinct row shapes -
 * genuinely human-sent turns and A2A agent-sent rows (`agentSenderInfo !==
 * null` - decision #8's fourth anchor-triggering event). Sharing one
 * LegendList item type meant they shared one recycling pool and one running
 * measured-height average (`averageSizes[itemType]`), skewing the estimate
 * LegendList uses for not-yet-measured rows of either shape and letting a
 * container get reused across the two. Splitting keeps both honest; no other
 * code keys off this string (verified - LegendList consumes it purely
 * internally for container reuse and per-type size averaging). Lives here
 * (not `chat-timeline.tsx`) so that component file keeps exporting only
 * components (Fast Refresh).
 */
export function chatTimelineGetItemType(item: ChatMessageModel): string {
  if (item.role === "user") {
    return item.agentSenderInfo === null ? "user:human" : "user:a2a";
  }
  return item.role;
}

export interface ChatTimelineNavigationLocation {
  readonly index: number;
  readonly viewOffset: number;
  readonly animated: boolean;
}

export function chatTimelineLocationForMessage(
  messageId: string,
  messageIndexById: ReadonlyMap<string, number>,
  animated: boolean,
): ChatTimelineNavigationLocation | null {
  const index = messageIndexById.get(messageId);
  if (index === undefined) return null;
  return {
    index,
    viewOffset: CHAT_TIMELINE_NAVIGATION_VIEW_OFFSET_PX,
    animated,
  };
}

/** Ticket 10: the list-state slice `chatTimelineNavigationLandedAtLocation`
 *  needs to validate a settled navigation - same content-relative-vs-DOM-
 *  scroll shape as `ChatFreeScrollingMeasurementSource`/
 *  `ChatViewportAnchorListState` (decision #18), but the caller supplies
 *  `scroll` directly (the scroll NODE's own live `scrollTop`, not
 *  `list.getState().scroll` - that internal value can lag a completed
 *  animated scroll for exactly the reason this validation exists, see the
 *  function's own doc comment). */
export interface ChatTimelineNavigationListState {
  readonly positionAtIndex: (index: number) => number | undefined;
  readonly scroll: number;
  readonly topOffsetAdjustment: number;
}

/**
 * Ticket 10: whether `location`'s target row is CURRENTLY sitting at its
 * intended `viewOffset` from the viewport top - the validation half of the
 * settle/re-issue pattern (root-cause: rootcause-nav-landing report). An
 * ANIMATED `scrollToIndex` targets ESTIMATED geometry; the installed
 * LegendList 3.2.0 never retargets mid-flight as real measurements replace
 * estimates during the animation, so a long jump across many unmeasured rows
 * can settle short (video evidence: click 1 landed several viewports short,
 * click 2 ~300-400px short). `false` for an unmeasured row - nothing to
 * validate against yet, so the caller should treat it as needing another
 * attempt rather than accepting blind.
 */
export function chatTimelineNavigationLandedAtLocation(
  state: ChatTimelineNavigationListState,
  location: ChatTimelineNavigationLocation,
  epsilonPx: number,
): boolean {
  const position = state.positionAtIndex(location.index);
  if (typeof position !== "number" || !Number.isFinite(position)) {
    return false;
  }
  const actualOffset = position + state.topOffsetAdjustment - state.scroll;
  return Math.abs(actualOffset - location.viewOffset) <= epsilonPx;
}

function isUserMessage(message: ChatMessageModel): boolean {
  return message.role === "user";
}

function isHumanUserMessage(message: ChatMessageModel): boolean {
  return message.role === "user" && message.agentSenderInfo === null;
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

/** One pixel past where a programmatic navigation parks the target row's
 *  top, so the row it scrolled to is the one reported active. */
export const VIEWPORT_ACTIVE_ANCHOR_OFFSET_PX =
  CHAT_TIMELINE_NAVIGATION_VIEW_OFFSET_PX + 1;

export interface ChatViewportAnchorListState {
  readonly scroll?: number;
  readonly positionAtIndex?: (index: number) => number | undefined;
  /**
   * LegendList top pad before row 0 (`headerSize` + `stylePaddingTop` +
   * `alignItemsAtEndPadding` - `getTopOffsetAdjustment`). `positionAtIndex`
   * is content-relative and excludes it; `scroll` includes it. Same field
   * name/contract as `ChatFreeScrollingMeasurementSource.topOffsetAdjustment`
   * (chat-scroll-anchoring.ts) - omit or `0` when unknown.
   */
  readonly topOffsetAdjustment?: number;
}

/**
 * Row index nearest the reading line, from LegendList's own measured
 * positions - NOT a DOM rect scan (jsdom reports unreliable, non-scroll-
 * relative rects for virtualized rows, and a real-browser rect scan re-reads
 * layout on every tick). `positionAtIndex` is monotonically increasing with
 * row index, so a binary search finds the last row whose top has scrolled
 * past the anchor line in O(log n).
 *
 * `positionAtIndex` is content-relative (excludes the header pad); `scroll`
 * includes it - comparing them directly is off by the header's height
 * (decision #18's `topOffsetAdjustment`, same fix as
 * `captureChatFreeScrollingOffset`). `targetY` is computed in
 * content-relative space (`scroll - topOffsetAdjustment`), matching
 * LegendList's own `computeViewability`'s `scroll = scrollState - topPad`.
 *
 * Returns `null` (not a guessed index) the moment the search encounters an
 * unmeasured row - a partial binary search result is not the true anchor,
 * and both callers already treat `null` as "no anchor this tick" gracefully.
 */
export function chatViewportAnchorRowIndex(
  state: ChatViewportAnchorListState,
  rowCount: number,
  anchorOffsetPx: number,
): number | null {
  if (rowCount <= 0 || state.positionAtIndex === undefined) return null;
  const topOffset =
    typeof state.topOffsetAdjustment === "number" &&
    Number.isFinite(state.topOffsetAdjustment)
      ? state.topOffsetAdjustment
      : 0;
  const targetY = (state.scroll ?? 0) - topOffset + anchorOffsetPx;
  let low = 0;
  let high = rowCount - 1;
  let result: number | null = null;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const top = state.positionAtIndex(mid);
    if (top === undefined || !Number.isFinite(top)) return null;
    if (top <= targetY) {
      result = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return result ?? 0;
}

/**
 * Resolves the active (human) user message for an unpinned viewport: finds
 * the transcript row nearest the reading line from list state, then maps it
 * to the owning rail entry. `null` when the list state cannot be measured
 * (concealed surface, no rows yet).
 *
 * Sole caller is the ticket-5 free-scroll save path (`scheduleActiveViewportUpdate`
 * in chat-messages.tsx) - NOT the minimap, which derives its own active-dot
 * highlighting independently. That single-purpose scope is what makes the P4
 * fallback below safe here: an A2A-only transcript (zero human user rows)
 * has no candidate for `selectActiveUserMessageId`'s human-only gate (it
 * returns `null` in that case ONLY - any human row anywhere in `messages`
 * always resolves a candidate), which previously meant the ticket-5 anchor
 * never tracked a reading position at all for that transcript shape -
 * `viewportRowMessageId` (already resolved, any role) is the natural
 * role-agnostic fallback. `selectActiveUserMessageId` itself is untouched,
 * so the minimap rail and find-controller's own call to it stay strictly
 * human-only as before.
 */
export function viewportActiveUserMessageId(
  state: ChatViewportAnchorListState,
  messages: ReadonlyArray<ChatMessageModel>,
): string | null {
  const rowIndex = chatViewportAnchorRowIndex(
    state,
    messages.length,
    VIEWPORT_ACTIVE_ANCHOR_OFFSET_PX,
  );
  const viewportRowMessageId =
    rowIndex === null ? null : (messages[rowIndex]?.id ?? null);
  if (viewportRowMessageId === null) return null;
  return (
    selectActiveUserMessageId(messages, viewportRowMessageId, false) ??
    viewportRowMessageId
  );
}

// --- Edge-mutation classification -------------------------------------------
//
// Re-expresses the previous `ScrollModifier`-style classifier (the old
// message-list helpers, deleted) as an imperative outcome the
// LegendList-backed controller can act on directly. Decision log #14: the
// underlying detection (suffix removal, branch reset, non-tail
// weave/genesis-pin/out-of-order arrival) keeps its semantics; only the
// vocabulary for expressing the outcome changes; from a `ScrollModifier`
// to a plain `scroll-to-end` / `scroll-to-index` / `none`
// action plus an optional forced mode transition.

export type ChatEdgeMutationAction =
  | { readonly kind: "none" }
  | { readonly kind: "scroll-to-end" }
  | { readonly kind: "scroll-to-index"; readonly index: number }
  | {
      readonly kind: "anchor-new-turn";
      readonly messageId: string;
      /** `false` only for the fresh-open re-derivation below (decision #15:
       *  "same anchor math as a send, not animated"); `true` for every real
       *  anchor-triggering event. */
      readonly animated: boolean;
    };

export interface ChatEdgeMutationOutcome {
  readonly action: ChatEdgeMutationAction;
  /** `null` means "leave the current mode alone" - either because nothing
   *  changed, or because an `"anchor-new-turn"` action owns its own mode
   *  transition (the controller's `beginAnchoringNewTurn` sets
   *  `"anchoring-new-turn"` directly; folding that into this union would
   *  force every other caller of `setTimelineMode` to handle a mode it can
   *  never actually request). Never produces `"free-scrolling"` - every case
   *  here that forces a mode picks `"following-end"`. */
  readonly nextMode: "following-end" | null;
}

const NONE_OUTCOME: ChatEdgeMutationOutcome = {
  action: { kind: "none" },
  nextMode: null,
};

/**
 * Classifies a `previousMessages -> nextMessages` transition into a single
 * imperative scroll outcome. `isFollowingEnd` is the mode snapshot at
 * classification time (the caller reads it from a ref, not state, since this
 * runs from a layout effect keyed on `messages` identity).
 *
 * Anchor-triggering events (decision log #8-9): explicit composer send,
 * steer / inline edit, queued-message auto-flush, and A2A agent-sent
 * user-role rows all resolve to `"anchor-new-turn"` here - the controller
 * positions the target row `anchorOffset` px from the viewport top and the
 * reply streams into the reserved space below it.
 *
 * The UNCONDITIONAL (decision #8) vs GATED-on-`isFollowingEnd` (decision #9)
 * split is decided PURELY by `localProvenanceMessageIds` membership - ground
 * truth for "this client minted this messageId and dispatched it"
 * (`chat-session-store.ts`'s `sendMessage`/`sendSeededUserMessage`/
 * `editUserMessage`, recorded at successful dispatch). It is deliberately
 * NOT inferred from row shape (a first-divergence replacement vs. a tail
 * append) or `persistentMessageId`: neither can tell a genuinely local action
 * apart from an identically-shaped row arriving from elsewhere - a queued
 * auto-flush, an A2A row, or ANOTHER window's edit reaching this one via the
 * host's snapshot broadcast on every accepted `editUserMessage`
 * (chat-session-manager.ts `afterAcceptAction`). Row-shape detection
 * (`newUserMessages`) still matters for finding WHICH row is even a
 * candidate - a same-turn steer can land as a replacement ahead of a still-
 * continuing live-assistant turn, in whatever chunked/split row projection
 * the renderer gives it (`:part:N` splitting, a steer row carrying the
 * turn's own start `createdAt` rather than "now") - but no longer decides
 * unconditional vs gated once a candidate is found; that decision is
 * registry-only.
 */
export function classifyChatEdgeMutation(input: {
  readonly previousMessages: ReadonlyArray<ChatMessageModel> | null;
  readonly nextMessages: ReadonlyArray<ChatMessageModel>;
  readonly isFollowingEnd: boolean;
  /** No saved scroll-state cache entry existed for this tile (decision #15).
   *  Re-checked here (not just at mount) because a chat tile can mount with
   *  an empty transcript before its snapshot loads - the mount-time fresh-
   *  open seed sees nothing to anchor to in that case, so this transition
   *  (the first one that actually brings in a real history) is the only
   *  place left to apply the policy. */
  readonly hadSavedScrollState: boolean;
  /** Message ids THIS client minted and successfully dispatched
   *  (`chat-session-store.ts`) - the unconditional-anchor ground truth. */
  readonly localProvenanceMessageIds: ReadonlySet<string>;
}): ChatEdgeMutationOutcome {
  const {
    nextMessages,
    previousMessages,
    isFollowingEnd,
    hadSavedScrollState,
    localProvenanceMessageIds,
  } = input;
  if (nextMessages.length === 0) {
    return { action: { kind: "none" }, nextMode: "following-end" };
  }
  if (previousMessages === null || previousMessages.length === 0) {
    // First non-empty render for this component instance. Covers both "a
    // brand-new, genuinely empty chat's first local send" (must still
    // anchor unconditionally) and "an existing chat's snapshot loading real
    // history into an already-mounted, transiently-empty transcript" (no
    // local action here - apply the fresh-open policy once instead, since
    // the mount-time seed had nothing to anchor to when it ran).
    const localMessage = nextMessages.find(
      (message) =>
        isUserMessage(message) && localProvenanceMessageIds.has(message.id),
    );
    if (localMessage !== undefined) {
      return {
        action: {
          kind: "anchor-new-turn",
          messageId: localMessage.id,
          animated: true,
        },
        nextMode: null,
      };
    }
    if (!hadSavedScrollState) {
      const lastUserMessage = nextMessages.findLast(isUserMessage);
      if (lastUserMessage !== undefined) {
        return {
          action: {
            kind: "anchor-new-turn",
            messageId: lastUserMessage.id,
            animated: false,
          },
          nextMode: null,
        };
      }
    }
    return { action: { kind: "none" }, nextMode: null };
  }

  const removedSuffixAnchorIndex = removedMessageSuffixAnchorIndex(
    previousMessages,
    nextMessages,
  );
  if (removedSuffixAnchorIndex !== null) {
    return {
      action: isFollowingEnd
        ? { kind: "scroll-to-end" }
        : { kind: "scroll-to-index", index: removedSuffixAnchorIndex },
      nextMode: isFollowingEnd ? "following-end" : null,
    };
  }

  // Decision #14: a pure prepend (older-history hydration) keeps retained
  // rows stable regardless of role - never an anchor candidate, whatever new
  // ids it introduces.
  if (!isPrependOnlyChange(previousMessages, nextMessages)) {
    const candidates = newUserMessages(previousMessages, nextMessages);
    if (candidates.length > 0) {
      const localMatch = candidates.find((message) =>
        localProvenanceMessageIds.has(message.id),
      );
      if (localMatch !== undefined) {
        return {
          action: {
            kind: "anchor-new-turn",
            messageId: localMatch.id,
            animated: true,
          },
          nextMode: null,
        };
      }
      // Not ours - decision #9 gate. `candidates` is virtually always a
      // single row in practice; the tail-most one wins if more than one
      // landed in the same batch.
      const gatedTarget = candidates[candidates.length - 1];
      if (isFollowingEnd) {
        return {
          action: {
            kind: "anchor-new-turn",
            messageId: gatedTarget.id,
            animated: true,
          },
          nextMode: null,
        };
      }
      return NONE_OUTCOME;
    }
  }

  if (isAppendOnlyChange(previousMessages, nextMessages)) {
    // Streamed growth: the reveal-pass effect handles both the anchored-turn
    // delta scroll and the plain following-end overflow catch-up;
    // free-scrolling never moves.
    return NONE_OUTCOME;
  }

  if (isSameMessageIdSequence(previousMessages, nextMessages)) {
    // Every row kept its id and position - an in-place content mutation
    // (streamed token update, edited text, tool status) regardless of which
    // row changed or its role. No scroll transition is needed.
    return NONE_OUTCOME;
  }

  // Non-tail weave / genesis pin / out-of-order arrival: LegendList's
  // `maintainVisibleContentPosition.data` keeps retained rows visually
  // stable regardless of mode; a following reader's own catch-up already
  // comes from the reveal-pass effect + `maintainScrollAtEnd` while
  // following, so no explicit scroll-to-end is needed here either.
  return NONE_OUTCOME;
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

/** Every user-role message in `nextMessages` whose id did not exist in
 *  `previousMessages` at all, in array order - independent of POSITION or
 *  `createdAt`. A same-turn steer can carry the turn's own start time (not
 *  "now") and land ahead of a still-continuing, re-chunked live-assistant
 *  row rather than strictly at the tail or at a clean first-divergence
 *  point, so neither "newest `createdAt`" nor "first point of divergence"
 *  reliably finds it - "is this id simply new" does. */
function newUserMessages(
  previousMessages: ReadonlyArray<ChatMessageModel>,
  nextMessages: ReadonlyArray<ChatMessageModel>,
): ReadonlyArray<ChatMessageModel> {
  const previousIds = new Set(previousMessages.map((message) => message.id));
  return nextMessages.filter(
    (message) => isUserMessage(message) && !previousIds.has(message.id),
  );
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

/** Every row kept the same id at the same index - a pure in-place content
 *  mutation with no change in row identity or order. */
function isSameMessageIdSequence(
  previousMessages: ReadonlyArray<ChatMessageModel>,
  nextMessages: ReadonlyArray<ChatMessageModel>,
): boolean {
  if (previousMessages.length !== nextMessages.length) return false;
  for (let index = 0; index < previousMessages.length; index += 1) {
    if (previousMessages[index].id !== nextMessages[index]?.id) return false;
  }
  return true;
}
