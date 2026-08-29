import type {
  BudgetHolderId,
  EvictionOutcome,
  MemoryAccountant,
  ProtectedBytes,
} from "@traycer-clients/shared/replica-runtime";
import { BUDGET_PLANE_IDS } from "@traycer-clients/shared/replica-runtime";
import type {
  ChatEvent,
  Message,
} from "@traycer/protocol/persistence/epic/schemas";
import { recordByteLength } from "@traycer/protocol/persistence/chat-transcript/record-bytes";
import { jsonByteLength } from "@/stores/replica-memory/json-bytes";
import {
  evictTranscriptWindowToBudget,
  transcriptWindowChargedBytes,
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
  return transcriptWindowChargedBytes(window) + chatWholeSetSliceBytes(slices);
}

export function chatWholeSetSliceBytes(slices: ChatWholeSetSlices): number {
  return (
    jsonByteLength(slices.queue) +
    jsonByteLength(slices.pendingApprovals) +
    jsonByteLength(slices.pendingFileEditApprovals) +
    jsonByteLength(slices.pendingInterviews) +
    jsonByteLength(slices.backgroundItems) +
    jsonByteLength(slices.managedCommands)
  );
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
  /** Recency for eviction order. Higher = hotter. A counter, not a clock. */
  touchedAt(): number;
  measure(): number;
  /**
   * Drop unprotected spans aiming to reclaim `overBytes`. Must settle the
   * holder afterwards (the accountant does not guess which holder changed).
   */
  evict(overBytes: number): EvictionOutcome;
}

export interface ChatWindowBudgetBook {
  attach(session: ChatWindowBudgetSession): void;
  detach(holderId: BudgetHolderId): void;
  settle(
    accountant: MemoryAccountant,
    holderId: BudgetHolderId,
    bytes: number,
  ): void;
  evict(overBytes: number): EvictionOutcome;
  sessionCount(): number;
}

export function createChatWindowBudgetBook(): ChatWindowBudgetBook {
  const sessions = new Map<BudgetHolderId, ChatWindowBudgetSession>();

  return {
    attach(session: ChatWindowBudgetSession): void {
      sessions.set(session.holderId, session);
    },

    detach(holderId: BudgetHolderId): void {
      sessions.delete(holderId);
    },

    settle(
      accountant: MemoryAccountant,
      holderId: BudgetHolderId,
      bytes: number,
    ): void {
      accountant.settle(BUDGET_PLANE_IDS.chatWindows, holderId, bytes);
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
 * Evict one window toward a byte target, reporting protection the way the
 * accountant needs. Live records that remain after span eviction are
 * `"tail"`: they have no ordinal, so dropping them is not recoverable.
 */
export function evictChatWindowForAccountant(
  window: TranscriptWindow,
  maxBytes: number,
  visible: OrdinalRange | null,
  required: readonly number[],
): { readonly window: TranscriptWindow; readonly outcome: EvictionOutcome } {
  const before = transcriptWindowChargedBytes(window);
  const next = evictTranscriptWindowToBudget(
    window,
    maxBytes,
    visible,
    required,
  );
  const after = transcriptWindowChargedBytes(next);
  const spanBytes = next.spans.reduce((sum, span) => sum + span.bytes, 0);
  const liveBytes = after - spanBytes;
  const protectedBytesByKind: ProtectedBytes[] = [];
  if (liveBytes > 0) {
    protectedBytesByKind.push({ kind: "tail", bytes: liveBytes });
  }
  return {
    window: next,
    outcome: {
      reclaimedBytes: Math.max(0, before - after),
      protectedBytesByKind,
    },
  };
}

export function chatHolderId(
  hostId: string,
  epicId: string,
  chatId: string,
): BudgetHolderId {
  return `${hostId}:${epicId}:${chatId}`;
}
