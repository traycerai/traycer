import type {
  ChatSessionState,
  LiveAssistantMessage,
} from "@/stores/chats/chat-session-store";
import type { ContentBlock } from "@traycer/protocol/persistence/epic/schemas";
import {
  estimatedStringBytesFromWidth,
  retainedValueSize,
  type RetainedValueSize,
  v8StringWidth,
} from "./retained-value-size";

type TextBlock = Extract<ContentBlock, { readonly type: "text" }>;

interface MeasuredBlock {
  readonly size: RetainedValueSize;
  readonly text: {
    readonly rawBytes: number;
    readonly width: 1 | 2;
  } | null;
}

const appendedTextBlocks = new WeakMap<
  object,
  { readonly previous: TextBlock; readonly delta: string }
>();

/**
 * The protocol accumulator's `text.delta` branch has already appended this
 * exact delta. Give the store subscriber that proof before it measures the
 * next live block; checking a long prefix here would repeat the hot-path scan.
 */
export function noteLiveTextAppend(
  previousBlocks: readonly ContentBlock[],
  nextBlocks: readonly ContentBlock[],
  blockId: string,
  delta: string,
): void {
  const previous = previousBlocks.find((block) => block.blockId === blockId);
  const next = nextBlocks.find((block) => block.blockId === blockId);
  if (previous?.type !== "text" || next?.type !== "text" || previous === next) {
    return;
  }
  appendedTextBlocks.set(next, { previous, delta });
}

function crossesSurrogateBoundary(previous: string, delta: string): boolean {
  if (previous.length === 0 || delta.length === 0) return false;
  const last = previous.charCodeAt(previous.length - 1);
  const first = delta.charCodeAt(0);
  return last >= 0xd800 && last <= 0xdbff && first >= 0xdc00 && first <= 0xdfff;
}

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
  "missingWorktreePaths",
] as const satisfies readonly (keyof ChatSessionState)[];

export interface ChatOwnedStateAccount {
  update(state: ChatSessionState): boolean;
  /** Count the unpublished summary generation alongside the last published set. */
  updateSummaryAssembly(
    assembly: ChatSessionState["accumulatedFileChangeSummaries"] | null,
    published: ChatSessionState["accumulatedFileChangeSummaries"],
  ): boolean;
  size(): RetainedValueSize;
}

export function createChatOwnedStateAccount(): ChatOwnedStateAccount {
  const values = new Map<keyof ChatSessionState, unknown>();
  const sizes = new Map<keyof ChatSessionState, RetainedValueSize>();
  let rawBytes = 0;
  let estimatedHeapBytes = 0;
  const blockSizes = new WeakMap<object, MeasuredBlock>();
  let imageResolutions: LiveAssistantMessage["imageResolutions"] | null = null;
  let imageResolutionSize: RetainedValueSize = {
    rawBytes: 0,
    estimatedHeapBytes: 0,
  };
  const summaryRowSizes = new WeakMap<object, RetainedValueSize>();
  let summaryAssembly:
    | ChatSessionState["accumulatedFileChangeSummaries"]
    | null = null;
  let publishedSummaries:
    | ChatSessionState["accumulatedFileChangeSummaries"]
    | null = null;
  let summaryAssemblySize: RetainedValueSize = {
    rawBytes: 0,
    estimatedHeapBytes: 0,
  };

  const measureBlock = (block: ContentBlock): MeasuredBlock => {
    const cached = blockSizes.get(block);
    if (cached !== undefined) return cached;
    if (block.type !== "text") {
      const measured = { size: retainedValueSize(block), text: null };
      blockSizes.set(block, measured);
      return measured;
    }

    const header = retainedValueSize({ ...block, text: "" });
    const append = appendedTextBlocks.get(block);
    const previous =
      append === undefined ? undefined : blockSizes.get(append.previous);
    let measured: MeasuredBlock;
    if (
      append !== undefined &&
      previous?.text !== null &&
      previous?.text !== undefined &&
      block.text.length === append.previous.text.length + append.delta.length &&
      block.text.endsWith(append.delta) &&
      !crossesSurrogateBoundary(append.previous.text, append.delta)
    ) {
      const width =
        previous.text.width === 2 || v8StringWidth(append.delta) === 2 ? 2 : 1;
      const textRawBytes =
        previous.text.rawBytes + retainedValueSize(append.delta).rawBytes - 2;
      measured = {
        size: {
          rawBytes: header.rawBytes + textRawBytes - 2,
          estimatedHeapBytes:
            header.estimatedHeapBytes +
            estimatedStringBytesFromWidth(block.text.length, width) -
            estimatedStringBytesFromWidth(0, 1),
        },
        text: { rawBytes: textRawBytes, width },
      };
    } else {
      const size = retainedValueSize(block);
      measured = {
        size,
        text: {
          rawBytes: size.rawBytes - header.rawBytes + 2,
          width: v8StringWidth(block.text),
        },
      };
    }
    blockSizes.set(block, measured);
    return measured;
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
      const { size } = measureBlock(block);
      rawBytes += size.rawBytes;
      estimatedHeapBytes += size.estimatedHeapBytes;
    }
    return { rawBytes, estimatedHeapBytes };
  };

  return {
    updateSummaryAssembly(assembly, published): boolean {
      if (assembly === null) {
        if (summaryAssembly === null) return false;
        summaryAssembly = null;
        publishedSummaries = null;
        summaryAssemblySize = { rawBytes: 0, estimatedHeapBytes: 0 };
        return true;
      }
      if (summaryAssembly === assembly && publishedSummaries === published) {
        return false;
      }
      summaryAssembly = assembly;
      publishedSummaries = published;
      // Both arrays remain reachable during a replacement. Charge the new
      // array, but not row objects that are already held by the published one.
      // Cached row sizes mean appending a chunk never re-encodes its prefix.
      const publishedRows = new Set(published);
      const seenRows = new Set<object>();
      let assemblyRawBytes = 2 + Math.max(0, assembly.length - 1);
      let assemblyHeapBytes = 32 + assembly.length * 8;
      for (const row of assembly) {
        let rowSize = summaryRowSizes.get(row);
        if (rowSize === undefined) {
          rowSize = retainedValueSize(row);
          summaryRowSizes.set(row, rowSize);
        }
        assemblyRawBytes += rowSize.rawBytes;
        if (seenRows.has(row)) continue;
        seenRows.add(row);
        if (!publishedRows.has(row)) {
          assemblyHeapBytes += rowSize.estimatedHeapBytes;
        }
      }
      summaryAssemblySize = {
        rawBytes: assemblyRawBytes,
        estimatedHeapBytes: assemblyHeapBytes,
      };
      return true;
    },
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
    size: () => ({
      rawBytes: rawBytes + summaryAssemblySize.rawBytes,
      estimatedHeapBytes:
        estimatedHeapBytes + summaryAssemblySize.estimatedHeapBytes,
    }),
  };
}
