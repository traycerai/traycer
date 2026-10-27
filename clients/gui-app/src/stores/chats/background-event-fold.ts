import type { AutonomousResumeTrigger } from "@traycer/protocol/persistence/epic/content-blocks";
import type {
  BackgroundEventEnding,
  ChatMessage as ChatMessageModel,
  FoldedBackgroundEvent,
  MessageSegment,
} from "@/stores/composer/chat-store";
import {
  skeletonOrdinalByRowId,
  type HydratedSpan,
  type TranscriptWindow,
} from "@/stores/chats/transcript-window";

/**
 * # One card per background source
 *
 * A shell watching a log, a scheduled wake on a loop, a harness Monitor: each
 * wakes the agent again and again, and most of those wakes draw no reply. Drawn
 * one card per wake, they bury the conversation under copies of the same card.
 * So until something else happens in the chat, later events from one source
 * fold into one card, drawn where the NEWEST of them is:
 *
 * - a finished turn that is nothing but a background event the agent let pass
 *   (`turnHasOnlyAutonomousResumeSegments`) is a MEMBER of the stretch it sits
 *   in, keyed by its source;
 * - each source's newest member keeps its row, and its card lists the older
 *   ones (`foldedBackgroundEvents`); the older rows leave the list;
 * - a turn the next event from a stretch's source started - the agent acted on
 *   it, or is still reading it - absorbs every member of that source and ends
 *   the stretch, so the card that heads the agent's work carries the events it
 *   let pass before;
 * - any other row ends the stretch.
 *
 * Renderer policy, like `withholdUnpaintedRows`, and applied beside it: the
 * rendered list stays the host's projection row for row, and a row folded away
 * here is one `transcriptListRows` omits, its ordinal suppressed.
 *
 * ## Neighbours are proven, not assumed
 *
 * On the windowed line `rows` is the HYDRATED SUBSET, so two rows next to each
 * other in it can have rows the client never loaded between them - the
 * agent's own work, a message from the person. Folding across that gap would
 * claim nothing happened between two wakes when something did. A pair is only
 * a pair when its ordinals are consecutive (`isNextRow`); a gap ends the
 * stretch, and the fold redraws once the gap hydrates.
 */
export function foldBackgroundEventRows(
  rows: ReadonlyArray<ChatMessageModel>,
  window: TranscriptWindow | null,
): ReadonlyArray<ChatMessageModel> {
  if (!rows.some((row) => silentBackgroundMember(row) !== null)) {
    return rows;
  }
  const withheld = new Set<string>();
  const foldedInto = new Map<string, ReadonlyArray<FoldedBackgroundEvent>>();
  let stretch = new Map<string, SilentMember[]>();
  const absorb = (
    absorber: ChatMessageModel,
    members: ReadonlyArray<SilentMember>,
  ): void => {
    if (members.length === 0) return;
    for (const member of members) withheld.add(member.row.id);
    foldedInto.set(absorber.id, members.flatMap(foldedEventsOf));
  };
  const closeStretch = (): void => {
    for (const members of stretch.values()) {
      absorb(members[members.length - 1].row, members.slice(0, -1));
    }
    stretch = new Map();
  };

  let previous: ChatMessageModel | null = null;
  for (const row of rows) {
    if (previous !== null && !isNextRow(previous, row, window)) {
      closeStretch();
    }
    previous = row;
    const member = silentBackgroundMember(row);
    if (member !== null) {
      const members = stretch.get(member.sourceKey);
      if (members === undefined) stretch.set(member.sourceKey, [member]);
      else members.push(member);
      continue;
    }
    const startKey = turnStartSourceKey(row);
    if (startKey !== null) {
      const members = stretch.get(startKey);
      if (members !== undefined) {
        absorb(row, members);
        stretch.delete(startKey);
      }
    }
    closeStretch();
  }
  closeStretch();

  if (foldedInto.size === 0) return rows;
  return rows.flatMap((row) => {
    if (withheld.has(row.id)) return [];
    const folded = foldedInto.get(row.id);
    return folded === undefined
      ? [row]
      : [{ ...row, foldedBackgroundEvents: folded }];
  });
}

/**
 * How a finished background-event turn that drew no reply ended. A provider
 * turn that ran keeps its elapsed time - the same arithmetic as the elapsed
 * footer - and one no turn adopted (`showCompletionFooter: false`) did not run.
 */
export function backgroundEventEnding(input: {
  readonly showCompletionFooter: boolean;
  readonly completedAt: number;
  readonly elapsedStartedAt: number;
  readonly pausedDurationMs: number;
}): BackgroundEventEnding {
  if (!input.showCompletionFooter) return { kind: "not-resumed" };
  return {
    kind: "no-reply",
    elapsedMs:
      input.completedAt - input.elapsedStartedAt - input.pausedDurationMs,
  };
}

type ResumeSegment = Extract<MessageSegment, { kind: "autonomous_resume" }>;

/**
 * The source a trigger came from; events with one key share a card. `null`
 * for a trigger that names none (one persisted before `blockId` existed),
 * which never folds.
 */
function triggerSourceKey(trigger: AutonomousResumeTrigger): string | null {
  // Defaulted keys: a body from an older host's full-snapshot line was
  // validated structurally, so a key that host never wrote is `undefined`.
  const managedCommand = trigger.managedCommand ?? null;
  if (managedCommand !== null) {
    return `shell:${managedCommand.hostId ?? ""}:${managedCommand.commandId}`;
  }
  // Every scheduled wake is its own `ScheduleWakeup` call, so a wake's block
  // id never repeats: the chat's wakes are one source.
  if (trigger.kind === "wakeup") return "wakeup";
  if (trigger.blockId === "") return null;
  return `${trigger.kind}:${trigger.blockId}`;
}

/** The one source every trigger in `segments` shares, or `null`. */
function sharedSourceKey(
  segments: ReadonlyArray<ResumeSegment>,
): string | null {
  let key: string | null = null;
  for (const segment of segments) {
    for (const trigger of segment.triggers) {
      const next = triggerSourceKey(trigger);
      if (next === null || (key !== null && next !== key)) return null;
      key = next;
    }
  }
  return key;
}

function isTurnStartResume(segment: MessageSegment): segment is ResumeSegment {
  return (
    segment.kind === "autonomous_resume" &&
    segment.deliveryPlacement !== "in_turn"
  );
}

interface SilentMember {
  readonly row: ChatMessageModel;
  readonly sourceKey: string;
  readonly completedAt: number;
}

/** A finished turn that is one source's background event and nothing else. */
function silentBackgroundMember(row: ChatMessageModel): SilentMember | null {
  if (
    row.role !== "assistant" ||
    row.runState !== null ||
    row.completedAt === null ||
    row.stopped !== null ||
    row.turnHasOnlyAutonomousResumeSegments !== true ||
    row.segments.length === 0
  ) {
    return null;
  }
  const resumes = row.segments.filter(isTurnStartResume);
  if (resumes.length !== row.segments.length) return null;
  const sourceKey = sharedSourceKey(resumes);
  return sourceKey === null
    ? null
    : { row, sourceKey, completedAt: row.completedAt };
}

/** The source of the event that started this turn, read off its head. */
function turnStartSourceKey(row: ChatMessageModel): string | null {
  if (row.role !== "assistant") return null;
  const head: ResumeSegment[] = [];
  for (const segment of row.segments) {
    if (!isTurnStartResume(segment)) break;
    head.push(segment);
  }
  return head.length === 0 ? null : sharedSourceKey(head);
}

function foldedEventsOf(
  member: SilentMember,
): ReadonlyArray<FoldedBackgroundEvent> {
  const { row } = member;
  const ending = backgroundEventEnding({
    showCompletionFooter: row.showCompletionFooter ?? true,
    completedAt: member.completedAt,
    elapsedStartedAt: row.elapsedStartedAt ?? row.createdAt,
    pausedDurationMs: row.pausedDurationMs ?? 0,
  });
  return row.segments
    .filter(isTurnStartResume)
    .flatMap((segment) => segment.triggers)
    .map((trigger, index) => ({ key: `${row.id}#${index}`, trigger, ending }));
}

/**
 * Whether `next` is the row directly after `previous` in the transcript, with
 * nothing - loaded or not - between them.
 *
 * The legacy line holds the whole transcript, so neighbours in `rows` are
 * neighbours. On the windowed line a row's ordinal comes from the span that
 * served it, else from the skeleton; a row with neither renders after every
 * ordinal (a live turn, a record the index has not placed), so it follows the
 * last ordinal and the other unplaced rows. An invalidated window proves
 * nothing.
 */
function isNextRow(
  previous: ChatMessageModel,
  next: ChatMessageModel,
  window: TranscriptWindow | null,
): boolean {
  if (window === null) return true;
  if (window.invalidated) return false;
  const before = ordinalOf(window, previous.id);
  const after = ordinalOf(window, next.id);
  if (before === null) return after === null;
  if (after === null) return before === window.rowCount - 1;
  return after === before + 1;
}

const spanOrdinalCache = new WeakMap<
  ReadonlyArray<HydratedSpan>,
  ReadonlyMap<string, number>
>();

function ordinalOf(window: TranscriptWindow, rowId: string): number | null {
  let spanOrdinals = spanOrdinalCache.get(window.spans);
  if (spanOrdinals === undefined) {
    const ordinals = new Map<string, number>();
    for (const span of window.spans) {
      span.rowIds.forEach((id, offset) => {
        ordinals.set(id, span.fromOrdinal + offset);
      });
    }
    spanOrdinalCache.set(window.spans, ordinals);
    spanOrdinals = ordinals;
  }
  return (
    spanOrdinals.get(rowId) ??
    skeletonOrdinalByRowId(window.skeleton).get(rowId) ??
    null
  );
}
