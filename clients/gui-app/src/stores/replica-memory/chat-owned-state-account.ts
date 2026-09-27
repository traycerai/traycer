import type {
  ChatSessionState,
  LiveAssistantMessage,
} from "@/stores/chats/chat-session-store";
import {
  retainedValueSize,
  type RetainedValueSize,
} from "./retained-value-size";

/**
 * State this chat store owns outside its transcript and six existing whole-set
 * charges. `messages`, `events`, and `transcriptRowContext` alias data held by
 * `transcriptWindow` on the windowed line and are deliberately absent.
 *
 * The store publishes new top-level values rather than mutating them. Only a
 * changed identity is visited, so streaming a transcript never serializes an
 * unchanged recovery ledger or accumulated-change list.
 */
const OWNED_STATE_KEYS = [
  "fatalClose",
  "preSnapshotRetries",
  "chat",
  "access",
  "messageDelivery",
  "unacknowledgedDeliveryRestore",
  "activeTurn",
  "accumulatedFileChanges",
  "transcriptDerived",
  "coldRewrittenMessageIds",
  "accumulatedFileChangeSummaries",
  "pendingFallback",
  "pendingReturn",
  "lastFailedAttempt",
  "lastFallbackOutcome",
  "heldUpdates",
  "portForwards",
  "pendingBackgroundStops",
  "pendingBackgroundStopAll",
  "pendingBackgroundSessionStop",
  "fallbackChoiceLease",
  "confirmedManualFallbackAction",
  "unattendedFallbackOutcome",
  "restore",
  "settledRestoreCompletions",
  "pendingActions",
  "acceptedActions",
  "pendingUserMessages",
  "errorNotices",
  "deliveredNoticeActionIds",
  "deliveredLastCopyActionIds",
  "lastCopyPrompts",
  "openedSubagentCardBlockIds",
  "pendingCancelRestorations",
  "failedSendRestoration",
  "hashOnlyRecoveries",
  "currentComposerSettings",
  "liveAssistantMessage",
  "liveTurnUsage",
  "worktreeBinding",
] as const satisfies readonly (keyof ChatSessionState)[];

export interface ChatOwnedStateAccount {
  update(state: ChatSessionState): boolean;
  size(): RetainedValueSize;
}

export function createChatOwnedStateAccount(): ChatOwnedStateAccount {
  const values = new Map<keyof ChatSessionState, unknown>();
  const sizes = new Map<keyof ChatSessionState, RetainedValueSize>();
  let rawBytes = 0;
  let estimatedHeapBytes = 0;
  const blockSizes = new WeakMap<object, RetainedValueSize>();
  let imageResolutions: LiveAssistantMessage["imageResolutions"] | null = null;
  let imageResolutionSize: RetainedValueSize = {
    rawBytes: 0,
    estimatedHeapBytes: 0,
  };

  const measureLiveAssistant = (
    live: LiveAssistantMessage,
  ): RetainedValueSize => {
    const header = retainedValueSize({
      turnId: live.turnId,
      sender: live.sender,
      startedAt: live.startedAt,
      blocksVersion: live.blocksVersion,
      imageResolutionOwnerMessageId: live.imageResolutionOwnerMessageId,
      imageResolutionsVersion: live.imageResolutionsVersion,
      timestamp: live.timestamp,
      reasoningEffort: live.reasoningEffort,
      serviceTier: live.serviceTier,
    });
    if (imageResolutions !== live.imageResolutions) {
      imageResolutions = live.imageResolutions;
      imageResolutionSize = retainedValueSize(imageResolutions);
    }
    let rawBytes = header.rawBytes + imageResolutionSize.rawBytes + 2;
    let estimatedHeapBytes =
      header.estimatedHeapBytes +
      imageResolutionSize.estimatedHeapBytes +
      32 +
      live.blocks.length * 8;
    const countedBlocks = new Set<object>();
    for (const block of live.blocks) {
      if (countedBlocks.has(block)) continue;
      countedBlocks.add(block);
      let size = blockSizes.get(block);
      if (size === undefined) {
        size = retainedValueSize(block);
        blockSizes.set(block, size);
      }
      rawBytes += size.rawBytes;
      estimatedHeapBytes += size.estimatedHeapBytes;
    }
    return { rawBytes, estimatedHeapBytes };
  };

  return {
    update(state): boolean {
      let changed = false;
      for (const key of OWNED_STATE_KEYS) {
        const value = state[key];
        if (values.has(key) && Object.is(values.get(key), value)) continue;
        values.set(key, value);
        const previous = sizes.get(key);
        if (previous !== undefined) {
          rawBytes -= previous.rawBytes;
          estimatedHeapBytes -= previous.estimatedHeapBytes;
        }
        let next: RetainedValueSize = {
          rawBytes: 0,
          estimatedHeapBytes: 0,
        };
        if (
          key === "liveAssistantMessage" &&
          state.liveAssistantMessage !== null
        ) {
          next = measureLiveAssistant(state.liveAssistantMessage);
        } else if (typeof value === "object" && value !== null) {
          next = retainedValueSize(value);
        }
        sizes.set(key, next);
        rawBytes += next.rawBytes;
        estimatedHeapBytes += next.estimatedHeapBytes;
        changed = true;
      }
      return changed;
    },
    size: () => ({ rawBytes, estimatedHeapBytes }),
  };
}
