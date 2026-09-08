/**
 * The client-side landing point for `epic.fileEvents` frames, and the ONE
 * fan-out every surface reads.
 *
 * The stream carries the two things the `files` manifest structurally cannot
 * say (see `protocol/host/epic/files.ts`): a drop-zone file the watcher
 * refused, which never becomes an entry at all, and a recording's in-flight
 * lifecycle, which has no entry to observe until finalize. Nothing else about a
 * file is here - everything settled is read off the doc replica, so no fact has
 * two arrival orders.
 *
 * Deliberately a plain module store rather than a Zustand slice or a Query
 * cache: the frames arrive whether or not any surface is mounted (the Files
 * panel can be closed, the tile can be on another pane), and the toast below
 * fires from the ARRIVAL, not from a render.
 */
import { toast } from "sonner";
import type {
  EpicFileEventsServerFrame,
  EpicFileRefusalReason,
  TabRecordingOutcome,
} from "@traycer/protocol/host/epic/files";
import { appLogger } from "@/lib/logger";
import { epicFileName } from "@/lib/epic-files/file-rows";
import {
  EMPTY_FILE_REFUSALS,
  EPIC_FILE_REFUSAL_COPY,
  type EpicFileRefusal,
} from "@/lib/epic-files/file-refusals";

/**
 * How many refusals one epic keeps, newest first. A refusal is a notice, not a
 * record - the host stores none either - so the panel shows the recent ones,
 * and an epic whose drop zone was carpeted by a bad `cp -r` does not hold a
 * thousand rows for the rest of the session.
 */
export const EPIC_FILE_REFUSAL_LIMIT = 50;

/**
 * How long one `(path, reason)` pair stays deduplicated.
 *
 * A file being rewritten in a loop (an editor's save cycle, a sync client) is a
 * fresh refusal to the watcher every time, and each one is the same sentence
 * about the same file. The drop happens at INGEST rather than only at the
 * toast, so the panel's list and the toasts say the same thing - the
 * alternative is fifty identical rows under a single toast.
 */
export const EPIC_FILE_REFUSAL_DEDUPE_MS = 10_000;

/**
 * A recording run's in-flight lifecycle, for the tile badge (ticket 21).
 * `outcome` is `null` on a start and the run's ending on an end, so one
 * listener signature covers both edges of the badge's lit window.
 */
export interface EpicRecordingEvent {
  readonly kind: "recordingStarted" | "recordingEnded";
  readonly recordingId: string;
  readonly tabId: string;
  readonly outcome: TabRecordingOutcome | null;
}

type RecordingListener = (event: EpicRecordingEvent) => void;

interface EpicFileEventsEntry {
  refusals: readonly EpicFileRefusal[];
  readonly refusalListeners: Set<() => void>;
  readonly recordingListeners: Set<RecordingListener>;
  /** `${path} ${reason}` -> the instant that pair was last admitted. */
  readonly lastRefusalAt: Map<string, number>;
}

const entriesByEpicId = new Map<string, EpicFileEventsEntry>();
/** Mints row keys: a frame carries no id and no timestamp of its own. */
let refusalSequence = 0;

function entryFor(epicId: string): EpicFileEventsEntry {
  const existing = entriesByEpicId.get(epicId);
  if (existing !== undefined) return existing;
  const created: EpicFileEventsEntry = {
    refusals: EMPTY_FILE_REFUSALS,
    refusalListeners: new Set(),
    recordingListeners: new Set(),
    lastRefusalAt: new Map(),
  };
  entriesByEpicId.set(epicId, created);
  return created;
}

/**
 * Whether this refusal is new enough to show, stamping it when it is.
 *
 * Prunes as it goes: the map is keyed by path, so a directory copy that trips
 * one rule on a thousand names would otherwise hold a thousand keys until the
 * epic closes.
 */
function admitRefusal(
  entry: EpicFileEventsEntry,
  path: string,
  reason: EpicFileRefusalReason,
): boolean {
  const now = Date.now();
  for (const [key, at] of entry.lastRefusalAt) {
    if (now - at >= EPIC_FILE_REFUSAL_DEDUPE_MS)
      entry.lastRefusalAt.delete(key);
  }
  const dedupeKey = `${path} ${reason}`;
  const previous = entry.lastRefusalAt.get(dedupeKey);
  if (previous !== undefined && now - previous < EPIC_FILE_REFUSAL_DEDUPE_MS) {
    return false;
  }
  entry.lastRefusalAt.set(dedupeKey, now);
  return true;
}

/**
 * Applies one server frame.
 *
 * Exhaustive over the union: a frame kind added to the wire becomes a compile
 * error here rather than a silent drop at runtime. `pong` is ignored BY NAME
 * rather than by a default arm, which is what keeps that exhaustiveness
 * meaningful.
 */
export function recordEpicFileEvent(
  epicId: string,
  frame: EpicFileEventsServerFrame,
): void {
  switch (frame.kind) {
    case "refused": {
      const entry = entryFor(epicId);
      if (!admitRefusal(entry, frame.path, frame.reason)) return;
      refusalSequence += 1;
      const copy = EPIC_FILE_REFUSAL_COPY[frame.reason];
      // The panel's own display-name helper, so the toast and the row name the
      // file the same way.
      const name = epicFileName(frame.path);
      const refusal: EpicFileRefusal = {
        id: `refusal-${refusalSequence}`,
        name,
        reason: copy,
      };
      entry.refusals = [refusal, ...entry.refusals].slice(
        0,
        EPIC_FILE_REFUSAL_LIMIT,
      );
      for (const listener of entry.refusalListeners) listener();
      // Named by the FILE and nothing else (D31): a refusal never says who
      // dropped it. One toast per admitted frame - the dedupe above is what
      // keeps a flapping file from becoming a column of them.
      toast.warning(name, { description: copy });
      return;
    }
    case "recordingStarted": {
      emitRecordingEvent(epicId, {
        kind: "recordingStarted",
        recordingId: frame.recordingId,
        tabId: frame.tabId,
        outcome: null,
      });
      return;
    }
    case "recordingEnded": {
      emitRecordingEvent(epicId, {
        kind: "recordingEnded",
        recordingId: frame.recordingId,
        tabId: frame.tabId,
        outcome: frame.outcome,
      });
      return;
    }
    case "pong":
      return;
    default: {
      const unhandled: never = frame;
      void unhandled;
      appLogger.warn("[epic-files] unhandled epic.fileEvents frame", {
        epic: epicId,
      });
      return;
    }
  }
}

function emitRecordingEvent(epicId: string, event: EpicRecordingEvent): void {
  const entry = entriesByEpicId.get(epicId);
  if (entry === undefined) return;
  for (const listener of entry.recordingListeners) listener(event);
}

/**
 * The epic's recent refusals, newest first.
 *
 * Returns the entry's OWN array - never a fresh one - so it is a valid
 * `useSyncExternalStore` snapshot.
 */
export function getEpicFileRefusals(
  epicId: string,
): readonly EpicFileRefusal[] {
  return entriesByEpicId.get(epicId)?.refusals ?? EMPTY_FILE_REFUSALS;
}

/** The subscribe half of {@link getEpicFileRefusals}. */
export function subscribeEpicFileRefusals(
  epicId: string,
  listener: () => void,
): () => void {
  const entry = entryFor(epicId);
  entry.refusalListeners.add(listener);
  return () => {
    entry.refusalListeners.delete(listener);
  };
}

/**
 * The recording half of the same stream, for the tile badge (ticket 21).
 *
 * A LISTENER rather than a snapshot: the badge is driven by the two edges, and
 * retaining a "currently recording" set here would be a second answer to a
 * question the manifest settles the moment the run finalizes.
 */
export function subscribeEpicRecordingEvents(
  epicId: string,
  listener: RecordingListener,
): () => void {
  const entry = entryFor(epicId);
  entry.recordingListeners.add(listener);
  return () => {
    entry.recordingListeners.delete(listener);
  };
}

/**
 * Drops what is held for one epic, called when its last subscription is
 * released. These are notices about a live session with the drop zone; an epic
 * nobody has open is not having one.
 */
export function clearEpicFileEvents(epicId: string): void {
  const entry = entriesByEpicId.get(epicId);
  if (entry === undefined) return;
  entry.refusals = EMPTY_FILE_REFUSALS;
  entry.lastRefusalAt.clear();
  if (
    entry.refusalListeners.size === 0 &&
    entry.recordingListeners.size === 0
  ) {
    entriesByEpicId.delete(epicId);
    return;
  }
  for (const listener of entry.refusalListeners) listener();
}

/** Tests only - one test's refusals must not leak into the next. */
export function __resetEpicFileEventsForTests(): void {
  entriesByEpicId.clear();
  refusalSequence = 0;
}
