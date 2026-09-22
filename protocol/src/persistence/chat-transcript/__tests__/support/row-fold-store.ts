import type { ChatEvent } from "@traycer/protocol/persistence/epic/chat-events";
import type { Message } from "@traycer/protocol/persistence/epic/messages";

import {
  foldTranscriptRows,
  foldTranscriptRowsInMemory,
  isTranscriptPauseOpenEvent,
  transcriptMessageFoldFacts,
  transcriptPauseCorrelationKey,
  type TranscriptRowDescriptor,
  type TranscriptRowProjectionInput,
} from "@traycer/protocol/persistence/chat-transcript/row-projection";
import {
  transcriptFoldUnitSkeleton,
  transcriptPreviewProjection,
} from "@traycer/protocol/persistence/chat-transcript/build-skeleton";
import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import {
  canonicalFoldJson,
  compareTranscriptRowOrder,
  type PositionedMessage,
  type TranscriptEventTouch,
  type TranscriptFoldChange,
  type TranscriptFoldLoad,
  type TranscriptFoldLoadResult,
  type TranscriptFoldRow,
  type TranscriptFoldState,
  type TranscriptMessageRemoval,
  type TranscriptMessageTouch,
  type TranscriptRowOrder,
} from "@traycer/protocol/persistence/chat-transcript/row-projection-fold-state";
import { assistantTurnKey } from "@traycer/protocol/persistence/chat-transcript/fork-boundary";

/**
 * An in-memory mirror of what an SQLite-backed transcript-row-fold store must
 * do: apply one change at a time through `foldTranscriptRows`, answer its
 * loads from durable state, persist the returned state and per-unit rows, and
 * fall back to a full rebuild whenever the increment declines. It exists so
 * `row-fold-parity.test.ts` can drive thousands of changes against something
 * that behaves like the real store without a database.
 *
 * Message positions are `insert_seq`-shaped: a brand-new id or a re-upsert of
 * a removed id takes the next sequence number; an upsert of a still-live id
 * keeps its position. Events are append-or-replace-in-place by `eventId`, with
 * the SAME position kept on a replace - mirroring `chat_events` upserting a
 * row rewritten by the host rather than appending a duplicate.
 */

interface StoredMessageEntry {
  readonly position: number;
  readonly message: Message;
}

interface StoredEventEntry {
  readonly position: number;
  readonly event: ChatEvent;
  readonly rowTurnKey: string | null;
}

interface StoredUnit {
  readonly unitKey: string;
  /** Parallel to {@link skeleton} - same length, same index meaning. */
  readonly rows: readonly TranscriptFoldRow[];
  readonly skeleton: readonly RowSkeletonEntry[];
}

/** One change to apply, in the shape a caller assembles it (not yet positioned). */
export interface RowFoldChangeInput {
  readonly upserts: readonly Message[];
  readonly removes: readonly string[];
  readonly events: readonly ChatEvent[];
  readonly activeTurnId: string | null;
}

/** One load the increment made while answering this change, for mechanism assertions. */
export interface LoadRecord {
  readonly kind: TranscriptFoldLoad["kind"];
  /** Only meaningful for `facts-from`: the requested position, `null` for a widen. */
  readonly position: number | null | undefined;
  readonly resultCount: number;
}

export interface ApplyResult {
  readonly continued: boolean;
  readonly reason: string | null;
  readonly loads: readonly LoadRecord[];
  /** The unit keys the increment re-described, empty on a decline or the first change. */
  readonly touchedUnitKeys: readonly string[];
}

export interface DeclineRecord {
  readonly op: number;
  readonly reason: string;
}

export class RowFoldStore {
  readonly chatId: string;

  private messageSeq = 0;
  private eventSeq = 0;
  private opIndex = 0;
  private readonly messagesMap = new Map<string, StoredMessageEntry>();
  private eventsArr: StoredEventEntry[] = [];
  private readonly units = new Map<string, StoredUnit>();
  private state: TranscriptFoldState | null = null;
  private activeTurnId: string | null = null;

  readonly declines: DeclineRecord[] = [];

  constructor(chatId: string) {
    this.chatId = chatId;
  }

  apply(change: RowFoldChangeInput): ApplyResult {
    this.opIndex += 1;

    const removedMessages: TranscriptMessageRemoval[] = [];
    for (const messageId of change.removes) {
      const held = this.messagesMap.get(messageId);
      if (held === undefined) continue;
      this.messagesMap.delete(messageId);
      removedMessages.push({
        messageId,
        position: held.position,
        facts: transcriptMessageFoldFacts(held.message),
      });
    }

    const upsertedMessages: TranscriptMessageTouch[] = [];
    for (const message of change.upserts) {
      const held = this.messagesMap.get(message.messageId);
      if (held === undefined) {
        this.messageSeq += 1;
        this.messagesMap.set(message.messageId, {
          position: this.messageSeq,
          message,
        });
        upsertedMessages.push({
          position: this.messageSeq,
          message,
          previous: null,
        });
        continue;
      }
      this.messagesMap.set(message.messageId, {
        position: held.position,
        message,
      });
      upsertedMessages.push({
        position: held.position,
        message,
        previous: {
          position: held.position,
          facts: transcriptMessageFoldFacts(held.message),
        },
      });
    }

    const beforeEvents = this.eventsArr;
    const idToIndex = new Map<string, number>(
      this.eventsArr.map((entry, index) => [entry.event.eventId, index]),
    );
    const nextEvents = [...this.eventsArr];
    const appendedEvents: TranscriptEventTouch[] = [];
    for (const appended of change.events) {
      const index = idToIndex.get(appended.eventId);
      if (index !== undefined) {
        const old = nextEvents[index];
        nextEvents[index] = {
          position: old.position,
          event: appended,
          rowTurnKey: null,
        };
        appendedEvents.push({
          position: old.position,
          event: appended,
          previous: old.event,
        });
        continue;
      }
      this.eventSeq += 1;
      nextEvents.push({
        position: this.eventSeq,
        event: appended,
        rowTurnKey: null,
      });
      idToIndex.set(appended.eventId, nextEvents.length - 1);
      appendedEvents.push({
        position: this.eventSeq,
        event: appended,
        previous: null,
      });
    }
    this.eventsArr = nextEvents;
    this.activeTurnId = change.activeTurnId;

    if (this.state === null) {
      this.fullRebuild();
      return { continued: true, reason: null, loads: [], touchedUnitKeys: [] };
    }

    const loads: LoadRecord[] = [];
    const liveMessagesSorted = (): PositionedMessage[] => this.liveMessagesSorted();
    const factsOf = (positioned: PositionedMessage) => ({
      position: positioned.position,
      messageId: positioned.message.messageId,
      facts: transcriptMessageFoldFacts(positioned.message),
    });

    const answer = (load: TranscriptFoldLoad): TranscriptFoldLoadResult => {
      switch (load.kind) {
        case "facts-from": {
          const facts = liveMessagesSorted()
            .filter(
              (positioned) =>
                load.position === null || positioned.position >= load.position,
            )
            .map(factsOf);
          loads.push({
            kind: load.kind,
            position: load.position,
            resultCount: facts.length,
          });
          return { kind: "facts", facts };
        }
        case "facts-of-turns": {
          const facts = liveMessagesSorted()
            .filter(
              (positioned) =>
                positioned.message.role === "assistant" &&
                load.turnKeys.includes(assistantTurnKey(positioned.message)),
            )
            .map(factsOf);
          loads.push({ kind: load.kind, position: undefined, resultCount: facts.length });
          return { kind: "facts", facts };
        }
        case "messages-of-turns": {
          const messages = liveMessagesSorted().filter(
            (positioned) =>
              positioned.message.role === "assistant" &&
              load.turnKeys.includes(assistantTurnKey(positioned.message)),
          );
          loads.push({
            kind: load.kind,
            position: undefined,
            resultCount: messages.length,
          });
          return { kind: "messages", messages };
        }
        case "messages-by-id": {
          const messages = liveMessagesSorted().filter((positioned) =>
            load.messageIds.includes(positioned.message.messageId),
          );
          loads.push({
            kind: load.kind,
            position: undefined,
            resultCount: messages.length,
          });
          return { kind: "messages", messages };
        }
        case "events-of-turns": {
          const events = beforeEvents
            .filter(
              (entry) =>
                entry.rowTurnKey !== null &&
                load.turnKeys.includes(entry.rowTurnKey),
            )
            .sort((a, b) => a.position - b.position)
            .map((entry) => ({
              position: entry.position,
              event: entry.event,
              rowTurnKey: entry.rowTurnKey as string,
            }));
          loads.push({
            kind: load.kind,
            position: undefined,
            resultCount: events.length,
          });
          return { kind: "turn-events", events };
        }
        case "events-by-type": {
          const events = this.eventsArr
            .filter((entry) => load.types.includes(entry.event.type))
            .map((entry) => ({ position: entry.position, event: entry.event }));
          loads.push({
            kind: load.kind,
            position: undefined,
            resultCount: events.length,
          });
          return { kind: "events", events };
        }
        case "pause-open": {
          const hit = beforeEvents
            .filter(
              (entry) =>
                entry.position < load.beforePosition &&
                isTranscriptPauseOpenEvent(entry.event) &&
                entry.event.turnId !== null &&
                transcriptPauseCorrelationKey(entry.event) === load.pauseKey,
            )
            .at(-1);
          const turnId = hit === undefined ? null : hit.event.turnId;
          loads.push({
            kind: load.kind,
            position: undefined,
            resultCount: turnId === null ? 0 : 1,
          });
          return { kind: "pause-open", turnId };
        }
        case "unit-rows": {
          const rows = load.unitKeys.flatMap((unitKey) =>
            (this.units.get(unitKey)?.rows ?? []).map((row) => ({
              unitKey,
              rowId: row.descriptor.rowId,
              order: row.order,
              unitState: row.unitState,
            })),
          );
          loads.push({ kind: load.kind, position: undefined, resultCount: rows.length });
          return { kind: "rows", rows };
        }
        case "rows-by-id": {
          const rows = [...this.units.values()].flatMap((unit) =>
            unit.rows
              .filter((row) => load.rowIds.includes(row.descriptor.rowId))
              .map((row) => ({
                unitKey: unit.unitKey,
                rowId: row.descriptor.rowId,
                order: row.order,
                unitState: row.unitState,
              })),
          );
          loads.push({ kind: load.kind, position: undefined, resultCount: rows.length });
          return { kind: "rows", rows };
        }
      }
    };

    const foldChange: TranscriptFoldChange = {
      chatId: this.chatId,
      activeTurnId: change.activeTurnId,
      upsertedMessages,
      removedMessages,
      appendedEvents,
    };

    const steps = foldTranscriptRows(this.state, foldChange);
    let step = steps.next();
    while (step.done !== true) step = steps.next(answer(step.value));
    const result = step.value;

    if (!result.continued) {
      this.declines.push({ op: this.opIndex, reason: result.reason });
      this.fullRebuild();
      return { continued: false, reason: result.reason, loads, touchedUnitKeys: [] };
    }

    const touchedUnitKeys: string[] = [];
    for (const unit of result.units) {
      touchedUnitKeys.push(unit.unitKey);
      const skeleton = transcriptFoldUnitSkeleton(
        unit,
        transcriptPreviewProjection,
        null,
      );
      this.units.set(unit.unitKey, { unitKey: unit.unitKey, rows: unit.rows, skeleton });
    }

    const roundtripped = JSON.parse(
      JSON.stringify(result.state),
    ) as TranscriptFoldState;
    if (canonicalFoldJson(roundtripped) !== canonicalFoldJson(result.state)) {
      throw new Error(
        "row-fold-store: the fold state lost information across a JSON roundtrip",
      );
    }
    this.state = roundtripped;

    for (let index = 0; index < this.eventsArr.length; index += 1) {
      const entry = this.eventsArr[index];
      const turnKey = result.eventRowTurnKeys.get(entry.event.eventId);
      if (turnKey !== undefined) {
        this.eventsArr[index] = { ...entry, rowTurnKey: turnKey };
      }
    }

    return { continued: true, reason: null, loads, touchedUnitKeys };
  }

  private liveMessagesSorted(): PositionedMessage[] {
    return [...this.messagesMap.values()]
      .sort((a, b) => a.position - b.position)
      .map((entry) => ({ position: entry.position, message: entry.message }));
  }

  private fullRebuild(): void {
    const result = foldTranscriptRowsInMemory({
      chatId: this.chatId,
      activeTurnId: this.activeTurnId,
      messages: this.liveMessagesSorted(),
      events: this.eventsArr.map((entry) => ({
        position: entry.position,
        event: entry.event,
      })),
    });
    this.units.clear();
    for (const unit of result.units) {
      const skeleton = transcriptFoldUnitSkeleton(
        unit,
        transcriptPreviewProjection,
        null,
      );
      this.units.set(unit.unitKey, { unitKey: unit.unitKey, rows: unit.rows, skeleton });
    }
    this.state = JSON.parse(JSON.stringify(result.state)) as TranscriptFoldState;
    for (let index = 0; index < this.eventsArr.length; index += 1) {
      const entry = this.eventsArr[index];
      const turnKey = result.eventRowTurnKeys.get(entry.event.eventId) ?? null;
      this.eventsArr[index] = { ...entry, rowTurnKey: turnKey };
    }
  }

  /** Every row's order and descriptor, paired 1:1 with {@link skeletonSorted}. */
  private pairsSorted(): readonly {
    readonly row: TranscriptFoldRow;
    readonly skeleton: RowSkeletonEntry;
  }[] {
    const pairs: { row: TranscriptFoldRow; skeleton: RowSkeletonEntry }[] = [];
    for (const unit of this.units.values()) {
      unit.rows.forEach((row, index) => {
        pairs.push({ row, skeleton: unit.skeleton[index] });
      });
    }
    pairs.sort((a, b) => compareTranscriptRowOrder(a.row.order, b.row.order));
    return pairs;
  }

  rowsSorted(): readonly TranscriptRowDescriptor[] {
    return this.pairsSorted().map((pair) => pair.row.descriptor);
  }

  skeletonSorted(): readonly RowSkeletonEntry[] {
    return this.pairsSorted().map((pair) => pair.skeleton);
  }

  /** Every stored row's order key, in NO particular order - for uniqueness checks. */
  allOrders(): readonly TranscriptRowOrder[] {
    const out: TranscriptRowOrder[] = [];
    for (const unit of this.units.values()) {
      for (const row of unit.rows) out.push(row.order);
    }
    return out;
  }

  /** The chat as it stands, for driving the oracle / `buildRowSkeleton` / `projectTranscriptRows`. */
  projectionInput(): TranscriptRowProjectionInput {
    return {
      chatId: this.chatId,
      activeTurnId: this.activeTurnId,
      messages: this.liveMessagesSorted().map((positioned) => positioned.message),
      events: this.eventsArr.map((entry) => entry.event),
    };
  }
}
