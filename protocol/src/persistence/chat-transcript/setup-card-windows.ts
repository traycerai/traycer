import type { ChatEvent } from "@traycer/protocol/persistence/epic/chat-events";

import { readMetadataString } from "@traycer/protocol/persistence/chat-transcript/event-metadata";

/**
 * A chat's `setup.*` / `worktree.missing` events fold into one transcript row per setup LIFECYCLE.
 * the renderer, which builds a `SetupCardViewModel` per window and weaves the row into the transcript (`setup-card-rows.ts`); - the host, which numbers ordinals and must reserve exactly the same rows (`row-projection.ts`).
 */

const SETUP_EVENT_TYPES: ReadonlySet<ChatEvent["type"]> = new Set([
  "setup.creating",
  "setup.running",
  "setup.succeeded",
  "setup.failed",
  "setup.cancelled",
]);

/**
 * One setup lifecycle: the events that formed it, plus the three facts the
 * transcript needs to place its row.
 */
export interface SetupCardWindow {
  /** The window's events, in input order. Never empty. */
  readonly events: readonly ChatEvent[];
  /**
   * The EARLIEST setup-event timestamp in the window - by value, not by array
   * position, so an out-of-order arrival still anchors at the true start.
   */
  readonly createdAt: number;
  /**
   * True only for the window still OPEN at the end of the walk.
   * A window closed by a boundary is historical and keeps whatever state its last event left it in - which CAN be `setting-up` when the worktree vanished mid-setup, so anything asking "is setup in flight" must read this.
   */
  readonly isActive: boolean;
  /** The stamp of the event that closed this window, or `null` while it is open. */
  readonly closedAt: number | null;
  /** Whether the window holds a `setup.creating` event. */
  readonly hasCreatingEvent: boolean;
  /** The id of the user message whose send carried this creation, when the creating event named one. */
  readonly triggeringMessageId: string | null;
}

/** Partitions a chat's events into setup lifecycle windows, in chronological order. */
export function partitionSetupCardWindows(
  events: readonly ChatEvent[],
): readonly SetupCardWindow[] {
  const windows: ChatEvent[][] = [];
  // The stamp of the event that CLOSED each window, by window index.
  // The boundary is not part of the window it ends - it is either not a setup event at all (`worktree.missing`) or the first event of the NEXT lifecycle - so a client re-partitioning a slice can never derive it.
  const closedAt: (number | null)[] = [];
  let current: ChatEvent[] | null = null;
  const closeCurrent = (at: number): void => {
    if (current !== null) closedAt[windows.length - 1] = at;
    current = null;
  };

  for (const event of events) {
    // `worktree.missing` is the lifecycle boundary: not a setup event itself, but it marks the binding reset separating two lifecycles.
    if (event.type === "worktree.missing") {
      closeCurrent(event.timestamp);
      continue;
    }
    if (!SETUP_EVENT_TYPES.has(event.type)) continue;

    // A path-less setup event (the generic `SETUP_AWAIT_FAILED` catch) can neither name a workspace nor drive its retry, so it never forms or affects a window.
    const workspacePath = readMetadataString(event, "workspacePath");
    if (workspacePath === null || workspacePath.length === 0) continue;

    if (current !== null && closesWindow(current, event, workspacePath)) {
      // Closed BY this event, which belongs to the window it opens.
      closeCurrent(event.timestamp);
    }
    if (current === null) {
      current = [];
      windows.push(current);
      closedAt.push(null);
    }
    current.push(event);
  }

  return windows.map((windowEvents, index) =>
    describeWindow(windowEvents, windowEvents === current, closedAt[index]),
  );
}

/** Whether `event` starts a new lifecycle rather than joining the open one. */
function closesWindow(
  windowEvents: readonly ChatEvent[],
  event: ChatEvent,
  workspacePath: string,
): boolean {
  if (event.type === "setup.running") {
    return windowHasForPath(windowEvents, "setup.succeeded", workspacePath);
  }
  if (event.type === "setup.creating") {
    return (
      windowEvents.some((held) => held.type !== "setup.creating") ||
      windowHasForPath(windowEvents, "setup.creating", workspacePath)
    );
  }
  return false;
}

function windowHasForPath(
  windowEvents: readonly ChatEvent[],
  type: ChatEvent["type"],
  workspacePath: string,
): boolean {
  return windowEvents.some(
    (event) =>
      event.type === type &&
      readMetadataString(event, "workspacePath") === workspacePath,
  );
}

function describeWindow(
  windowEvents: readonly ChatEvent[],
  isActive: boolean,
  closedAt: number | null,
): SetupCardWindow {
  const createdAt = windowEvents.reduce(
    (earliest, event) => Math.min(earliest, event.timestamp),
    windowEvents[0].timestamp,
  );
  // Every creating event in a window comes from the same send, so the first
  // match is authoritative.
  const creatingEvent = windowEvents.find(
    (event) => event.type === "setup.creating",
  );
  return {
    events: windowEvents,
    createdAt,
    isActive,
    closedAt,
    hasCreatingEvent: creatingEvent !== undefined,
    triggeringMessageId:
      creatingEvent === undefined
        ? null
        : readMetadataString(creatingEvent, "triggeringMessageId"),
  };
}
