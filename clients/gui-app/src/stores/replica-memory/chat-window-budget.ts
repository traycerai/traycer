import type {
  BudgetHolderId,
  EvictionOutcome,
  MemoryAccountant,
  ProtectedBytes,
} from "@traycer-clients/shared/replica-runtime";
import {
  BUDGET_PLANE_IDS,
  sessionKeyOf,
} from "@traycer-clients/shared/replica-runtime";
import type {
  ChatEvent,
  Message,
} from "@traycer/protocol/persistence/epic/schemas";
import { recordByteLength } from "@traycer/protocol/persistence/chat-transcript/record-bytes";
import { jsonByteLength } from "@/stores/replica-memory/json-bytes";
import {
  evictTranscriptWindowToEstimatedBudget,
  transcriptWindowChargedBytes,
  transcriptWindowProtectedEstimatedBytes,
  transcriptWindowStaleTierBytes,
  type OrdinalRange,
  type TranscriptWindow,
} from "@/stores/chats/transcript-window";

/**
 * The six whole-set snapshot slices the windowed (and legacy) chat snapshot
 * copies wholesale. Charged, not bounded: truncating queue / approvals /
 * interviews / background / commands would drop in-flight work the user can
 * see. The accountant's job is to see them; shrinking their *content* is out
 * of scope.
 */
export interface ChatWholeSetSlices {
  readonly queue: unknown;
  readonly pendingApprovals: unknown;
  readonly pendingFileEditApprovals: unknown;
  readonly pendingInterviews: unknown;
  readonly backgroundItems: unknown;
  readonly managedCommands: unknown;
}

export function chatSessionChargeBytes(
  window: TranscriptWindow,
  slices: ChatWholeSetSlices,
): number {
  return (
    transcriptWindowChargedBytes(window) +
    transcriptWindowStaleTierBytes(window) +
    chatWholeSetSliceBytes(slices)
  );
}

/**
 * V8 calibration of an unmounted store after GC. The fixed term covers the
 * store's subscriptions, closures, and empty state; each retained transcript
 * record has ledger, span and derived-state overhead beyond its JSON body.
 * These terms are not raw bytes. The process budget includes the per-record
 * term when selecting a span; the transcript's own eight-MiB cap stays raw.
 */
export const CHAT_STORE_FIXED_HEAP_ESTIMATE_BYTES = 48 * 1024;
export const CHAT_TRANSCRIPT_RECORD_HEAP_OVERHEAD_BYTES = 600;

export function estimatedTranscriptWindowBytes(
  window: TranscriptWindow,
): number {
  const retainedRecords =
    window.records.messages.size +
    window.records.events.size +
    window.liveMessages.length +
    window.liveEvents.length;
  return (
    transcriptWindowChargedBytes(window) +
    transcriptWindowStaleTierBytes(window) +
    retainedRecords * CHAT_TRANSCRIPT_RECORD_HEAP_OVERHEAD_BYTES
  );
}

/** Stale carry cannot be reclaimed by fresh-span eviction. */
export function staleTranscriptProtectedHeapBytes(
  window: TranscriptWindow,
): number {
  const freshMessages = new Set<string>();
  const freshEvents = new Set<string>();
  for (const span of window.spans) {
    for (const id of span.messageIds) freshMessages.add(id);
    for (const id of span.eventIds) freshEvents.add(id);
  }
  let count = 0;
  for (const id of window.records.messages.keys()) {
    if (!freshMessages.has(id)) count += 1;
  }
  for (const id of window.records.events.keys()) {
    if (!freshEvents.has(id)) count += 1;
  }
  return (
    transcriptWindowStaleTierBytes(window) +
    count * CHAT_TRANSCRIPT_RECORD_HEAP_OVERHEAD_BYTES
  );
}

export function chatSessionEstimatedHeapBytes(
  window: TranscriptWindow,
  slices: ChatWholeSetSlices,
): number {
  return (
    estimatedTranscriptWindowBytes(window) +
    chatWholeSetSliceBytes(slices) +
    CHAT_STORE_FIXED_HEAP_ESTIMATE_BYTES
  );
}

export function chatWholeSetSliceBytes(slices: ChatWholeSetSlices): number {
  return (
    sliceBytes(slices.queue) +
    sliceBytes(slices.pendingApprovals) +
    sliceBytes(slices.pendingFileEditApprovals) +
    sliceBytes(slices.pendingInterviews) +
    sliceBytes(slices.backgroundItems) +
    sliceBytes(slices.managedCommands)
  );
}

/**
 * Each slice's figure, by the slice object's identity.
 *
 * Every transcript publish re-settles the session's charge, and most publishes
 * move none of these slices - a skeleton chunk, an index echo, a range answer.
 * Re-serializing all six each time was a `JSON.stringify` of the whole managed
 * command list (hundreds of entries on a long chat) per publish, producing a
 * throwaway string only to measure it.
 *
 * Exact, not approximate, because the chat store never mutates a slice in
 * place: a change to any of them is a new array or object in a new state, so
 * a changed slice is a cache miss and is measured afresh. A `WeakMap`, so a
 * replaced slice's figure goes with it.
 */
const sliceBytesByIdentity = new WeakMap<object, number>();

function sliceBytes(slice: unknown): number {
  if (typeof slice !== "object" || slice === null) return jsonByteLength(slice);
  const cached = sliceBytesByIdentity.get(slice);
  if (cached !== undefined) return cached;
  const bytes = jsonByteLength(slice);
  sliceBytesByIdentity.set(slice, bytes);
  return bytes;
}

/**
 * The legacy (pre-windowed) chat arm's residency: the entire transcript,
 * replaced wholesale on every snapshot. T6 owns that adapter; this is the
 * figure it should settle so the accountant can see an unbounded snapshot
 * as a whole-transcript claim rather than as a silent hole in the budget.
 */
export function legacyTranscriptResidencyBytes(
  messages: readonly Message[],
  events: readonly ChatEvent[],
): number {
  let bytes = 0;
  for (const message of messages) bytes += recordByteLength(message);
  for (const event of events) bytes += recordByteLength(event);
  return bytes;
}

/**
 * One chat session's contribution to the process-wide chat-windows plane.
 *
 * The session (windowed or legacy) remains the authority on WHAT to drop;
 * the book only asks, in LRU order, until the plane is under or everything
 * left is protected. Leased sessions are holders like any other — that is
 * how "leased sessions outside every cap" closes without a registry change.
 */
export interface ChatWindowBudgetSession {
  readonly holderId: BudgetHolderId;
  /** Recency for eviction order. Higher = hotter. A process-wide counter. */
  touchedAt(): number;
  /**
   * Drop unprotected spans aiming to reclaim `overBytes`. Must settle the
   * holder afterwards (the accountant does not guess which holder changed).
   */
  evict(overBytes: number): EvictionOutcome;
}

export interface ChatWindowBudgetBook {
  attach(session: ChatWindowBudgetSession): void;
  detach(holderId: BudgetHolderId): void;
  recordOwnedStateSize(
    holderId: BudgetHolderId,
    rawBytes: number,
    estimatedHeapBytes: number,
  ): void;
  rawOwnedStateBytes(): number;
  estimatedOwnedStateHeapBytes(): number;
  settle(
    accountant: MemoryAccountant,
    holderId: BudgetHolderId,
    bytes: number,
  ): void;
  chargeProvisional(
    accountant: MemoryAccountant,
    holderId: BudgetHolderId,
    bytes: number,
  ): void;
  evict(overBytes: number): EvictionOutcome;
  sessionCount(): number;
}

export function createChatWindowBudgetBook(): ChatWindowBudgetBook {
  const sessions = new Map<BudgetHolderId, ChatWindowBudgetSession>();
  const ownedStateByHolder = new Map<
    BudgetHolderId,
    { readonly rawBytes: number; readonly estimatedHeapBytes: number }
  >();

  return {
    attach(session: ChatWindowBudgetSession): void {
      sessions.set(session.holderId, session);
    },

    detach(holderId: BudgetHolderId): void {
      sessions.delete(holderId);
      ownedStateByHolder.delete(holderId);
    },

    recordOwnedStateSize(holderId, rawBytes, estimatedHeapBytes): void {
      ownedStateByHolder.set(holderId, { rawBytes, estimatedHeapBytes });
    },

    rawOwnedStateBytes(): number {
      let total = 0;
      for (const size of ownedStateByHolder.values()) total += size.rawBytes;
      return total;
    },

    estimatedOwnedStateHeapBytes(): number {
      let total = 0;
      for (const size of ownedStateByHolder.values()) {
        total += size.estimatedHeapBytes;
      }
      return total;
    },

    settle(
      accountant: MemoryAccountant,
      holderId: BudgetHolderId,
      bytes: number,
    ): void {
      accountant.settle(BUDGET_PLANE_IDS.chatWindows, holderId, bytes);
    },

    chargeProvisional(
      accountant: MemoryAccountant,
      holderId: BudgetHolderId,
      bytes: number,
    ): void {
      accountant.chargeProvisional(
        BUDGET_PLANE_IDS.chatWindows,
        holderId,
        bytes,
      );
    },

    evict(overBytes: number): EvictionOutcome {
      const ordered = [...sessions.values()].sort(
        (left, right) => left.touchedAt() - right.touchedAt(),
      );
      let remaining = overBytes;
      let reclaimed = 0;
      const protectedBytesByKind = new Map<ProtectedBytes["kind"], number>();
      for (const session of ordered) {
        if (remaining <= 0) break;
        const outcome = session.evict(remaining);
        reclaimed += outcome.reclaimedBytes;
        remaining -= outcome.reclaimedBytes;
        for (const entry of outcome.protectedBytesByKind) {
          protectedBytesByKind.set(
            entry.kind,
            (protectedBytesByKind.get(entry.kind) ?? 0) + entry.bytes,
          );
        }
      }
      return {
        reclaimedBytes: reclaimed,
        protectedBytesByKind: [...protectedBytesByKind.entries()].map(
          ([kind, bytes]) => ({ kind, bytes }),
        ),
      };
    },

    sessionCount(): number {
      return sessions.size;
    },
  };
}

/**
 * Evict one window toward an estimated-heap target, including the per-record
 * overhead that is freed with an unshared row. Live records remain `"tail"`:
 * they have no ordinal, so dropping them is not recoverable.
 */
export function evictChatWindowForAccountant(
  window: TranscriptWindow,
  maxBytes: number,
  visible: OrdinalRange | null,
  required: readonly number[],
): { readonly window: TranscriptWindow; readonly outcome: EvictionOutcome } {
  const before = estimatedTranscriptWindowBytes(window);
  const next = evictTranscriptWindowToEstimatedBudget(window, maxBytes, {
    visible,
    required,
    recordOverheadBytes: CHAT_TRANSCRIPT_RECORD_HEAP_OVERHEAD_BYTES,
  });
  const after = estimatedTranscriptWindowBytes(next);
  const staleProtectedBytes = staleTranscriptProtectedHeapBytes(next);
  return {
    window: next,
    outcome: {
      reclaimedBytes: Math.max(0, before - after),
      protectedBytesByKind: [
        ...transcriptWindowProtectedEstimatedBytes(
          next,
          visible,
          required,
          CHAT_TRANSCRIPT_RECORD_HEAP_OVERHEAD_BYTES,
        ),
        ...(staleProtectedBytes === 0
          ? []
          : [{ kind: "required" as const, bytes: staleProtectedBytes }]),
      ],
    },
  };
}

export function chatHolderId(
  hostId: string,
  epicId: string,
  chatId: string,
): BudgetHolderId {
  return sessionKeyOf([hostId, epicId, chatId]);
}
