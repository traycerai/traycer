import type { ChatSessionState } from "@/stores/chats/chat-session-store";
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
        const next =
          typeof value === "object" && value !== null
            ? retainedValueSize(value)
            : { rawBytes: 0, estimatedHeapBytes: 0 };
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
