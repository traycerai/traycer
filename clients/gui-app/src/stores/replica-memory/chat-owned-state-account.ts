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

export const CHAT_PRIVATE_STRING_SET_NAMES = [
  "watchedMessageDeliveryIds",
  "handledMessageDeliveryIds",
  "deliveredNoticeClientActionIds",
  "deliveredRetainedNoticeClientActionIds",
  "deliveredRestoreCompletionKeys",
] as const;

type PrivateStringSetName = (typeof CHAT_PRIVATE_STRING_SET_NAMES)[number];

class AccountedStringSet extends Set<string> {
  constructor(
    private readonly recordMutation: (
      value: string,
      delta: 1 | -1,
      nextSize: number,
    ) => void,
    private readonly onChange: () => void,
  ) {
    super();
  }

  override add(value: string): this {
    if (this.has(value)) return this;
    super.add(value);
    this.recordMutation(value, 1, this.size);
    this.onChange();
    return this;
  }

  override delete(value: string): boolean {
    if (!super.delete(value)) return false;
    this.recordMutation(value, -1, this.size);
    this.onChange();
    return true;
  }

  override clear(): void {
    for (const value of Array.from(this)) this.delete(value);
  }
}

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

type ChatSessionDataKey = {
  [Key in keyof ChatSessionState]: ChatSessionState[Key] extends (
    ...args: never[]
  ) => unknown
    ? never
    : Key;
}[keyof ChatSessionState];

/**
 * Exhaustive census of the store's retained data fields. `true` is charged by
 * this account. Each string says why the field is not charged here. The key
 * union comes from ChatSessionState, so adding a data field without deciding
 * its ownership fails type-check instead of silently opening a budget hole.
 * Actions are functions and carry no per-instance data beyond the calibrated
 * fixed store cost.
 */
export const CHAT_STATE_FIELD_ACCOUNTING = {
  epicId: "identity string included in the calibrated fixed store charge",
  chatId: "identity string included in the calibrated fixed store charge",
  connectionStatus: "small scalar included in the fixed store charge",
  fatalClose: true,
  snapshotLoaded: "boolean included in the fixed store charge",
  preSnapshotRetries: true,
  preSnapshotReloadStartedAt: "timestamp included in the fixed store charge",
  transcriptBaselineEpoch: "counter included in the fixed store charge",
  connectionEpoch: "counter included in the fixed store charge",
  transcriptHydrationSequence: "counter included in the fixed store charge",
  transcriptRowContext:
    "derived span context; span contextBytes and per-record transcript overhead cover it",
  chat: true,
  access: true,
  messages:
    "records alias transcriptWindow on the windowed line; legacy transcript charge covers them",
  events:
    "records alias transcriptWindow on the windowed line; legacy transcript charge covers them",
  queue: "charged by chatWholeSetSliceBytes",
  messageDelivery: true,
  unacknowledgedDeliveryRestore: true,
  runStatus: "small scalar included in the fixed store charge",
  activeTurn: true,
  turnLifecycleRevision: "counter included in the fixed store charge",
  steerProtocolSupported: "boolean included in the fixed store charge",
  draftBlobBridgeSupported: "boolean included in the fixed store charge",
  interviewDeliveryRetryProtocolSupported:
    "boolean included in the fixed store charge",
  autoPermissionModeProtocolSupported:
    "small scalar included in the fixed store charge",
  queuePauseReasonProtocolSupported:
    "small scalar included in the fixed store charge",
  turnInProgress: "boolean included in the fixed store charge",
  pendingApprovals: "charged by chatWholeSetSliceBytes",
  pendingFileEditApprovals: "charged by chatWholeSetSliceBytes",
  pendingInterviews: "charged by chatWholeSetSliceBytes",
  accumulatedFileChanges: true,
  transcriptWindow: "charged by the transcript window budget",
  transcriptDerived: true,
  accumulatedFileChangeCount: "counter included in the fixed store charge",
  coldRewrittenMessageIds: true,
  jumpTargetOrdinal: "ordinal included in the fixed store charge",
  findReadOrdinal: "ordinal included in the fixed store charge",
  accumulatedFileChangeSummaries: true,
  accumulatedSummaryGenerationSeated:
    "boolean included in the fixed store charge",
  accumulatedSummaryAssemblyStarted:
    "boolean included in the fixed store charge; private array is charged separately",
  backgroundItems: "charged by chatWholeSetSliceBytes",
  pendingFallback: true,
  pendingReturn: true,
  lastFailedAttempt: true,
  lastFallbackOutcome: true,
  managedCommands: "charged by chatWholeSetSliceBytes",
  heldUpdates: true,
  portForwards: true,
  pendingBackgroundStops: true,
  pendingBackgroundStopAll: true,
  pendingBackgroundSessionStop: true,
  fallbackChoiceLease: true,
  confirmedManualFallbackAction: true,
  unattendedFallbackOutcome: true,
  restore: true,
  settledRestoreCompletions: true,
  pendingActions: true,
  acceptedActions: true,
  pendingUserMessages: true,
  errorNotices: true,
  deliveredNoticeActionIds: true,
  deliveredLastCopyActionIds: true,
  lastCopyPrompts: true,
  openedSubagentCardBlockIds: true,
  pendingCancelRestorations: true,
  failedSendRestoration: true,
  hashOnlyRecoveries: true,
  currentComposerSettings: true,
  liveAssistantMessage: true,
  liveTurnUsage: true,
  worktreeBinding: true,
  missingWorktreePaths: true,
  suggestedPrompt: true,
  thinkingTokens: true,
} as const satisfies Readonly<Record<ChatSessionDataKey, true | string>>;

const OWNED_STATE_KEYS = (
  Object.keys(CHAT_STATE_FIELD_ACCOUNTING) as ChatSessionDataKey[]
).filter((key) => CHAT_STATE_FIELD_ACCOUNTING[key] === true);

export interface ChatOwnedStateAccount {
  update(state: ChatSessionState): boolean;
  /** Mutations of private delivery and toast ledgers settle without a store write. */
  createPrivateStringSet(
    name: PrivateStringSetName,
    onChange: () => void,
  ): Set<string>;
  /** Count the unpublished summary generation alongside the last published set. */
  updateSummaryAssembly(
    assembly: ChatSessionState["accumulatedFileChangeSummaries"] | null,
    published: ChatSessionState["accumulatedFileChangeSummaries"],
  ): boolean;
  /** Window-owned image witness tables can outlive the transcript rows they saw. */
  updateImageWitnessSize(size: RetainedValueSize): boolean;
  size(): RetainedValueSize;
}

export function createChatOwnedStateAccount(): ChatOwnedStateAccount {
  const values = new Map<keyof ChatSessionState, unknown>();
  const sizes = new Map<keyof ChatSessionState, RetainedValueSize>();
  let rawBytes = 0;
  let estimatedHeapBytes = 0;
  let privateSetRawBytes = 0;
  let privateSetEstimatedHeapBytes = 0;
  const privateSetCounts = new Map<PrivateStringSetName, number>();
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
  let imageWitnessSize: RetainedValueSize = {
    rawBytes: 0,
    estimatedHeapBytes: 0,
  };

  const measureBlock = (block: ContentBlock): MeasuredBlock => {
    const cached = blockSizes.get(block);
    if (cached !== undefined) {
      appendedTextBlocks.delete(block);
      return cached;
    }
    if (block.type !== "text") {
      const measured = { size: retainedValueSize(block), text: null };
      blockSizes.set(block, measured);
      return measured;
    }

    const header = retainedValueSize({ ...block, text: "" });
    const append = appendedTextBlocks.get(block);
    // The link is useful only while this block is being measured. Keeping it
    // makes the current block root every prior full-text version through the
    // WeakMap's values, growing actual retained heap quadratically on a long
    // streamed response even though the charged size is linear.
    appendedTextBlocks.delete(block);
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
    updateImageWitnessSize(size): boolean {
      if (
        imageWitnessSize.rawBytes === size.rawBytes &&
        imageWitnessSize.estimatedHeapBytes === size.estimatedHeapBytes
      ) {
        return false;
      }
      imageWitnessSize = size;
      return true;
    },
    createPrivateStringSet(name, onChange): Set<string> {
      if (privateSetCounts.has(name)) {
        throw new Error(`private string set already registered: ${name}`);
      }
      privateSetCounts.set(name, 0);
      return new AccountedStringSet((value, delta, nextSize) => {
        const previousSize = nextSize - delta;
        const stringSize = retainedValueSize(value);
        const crossesEmptyBoundary =
          (delta === 1 && previousSize === 0) ||
          (delta === -1 && nextSize === 0);
        const rawDelta = stringSize.rawBytes + (crossesEmptyBoundary ? 2 : 1);
        const heapDelta =
          stringSize.estimatedHeapBytes +
          24 +
          (delta === 1 && previousSize === 0 ? 48 : 0) +
          (delta === -1 && nextSize === 0 ? 48 : 0);
        privateSetRawBytes += delta * rawDelta;
        privateSetEstimatedHeapBytes += delta * heapDelta;
        privateSetCounts.set(name, nextSize);
      }, onChange);
    },
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
      rawBytes:
        rawBytes +
        summaryAssemblySize.rawBytes +
        privateSetRawBytes +
        imageWitnessSize.rawBytes,
      estimatedHeapBytes:
        estimatedHeapBytes +
        summaryAssemblySize.estimatedHeapBytes +
        privateSetEstimatedHeapBytes +
        imageWitnessSize.estimatedHeapBytes,
    }),
  };
}
