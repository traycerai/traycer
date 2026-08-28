import type { ChatEvent } from "@traycer/protocol/persistence/epic/chat-events";

import { readMetadataString } from "@traycer/protocol/persistence/chat-transcript/event-metadata";

/**
 * # Setup-card lifecycle windows
 *
 * A chat's `setup.*` / `worktree.missing` events fold into one transcript row
 * per setup LIFECYCLE. This module owns the fold - which events belong to which
 * window, and each window's placement facts - because two consumers need the
 * same answer:
 *
 * - the renderer, which builds a `SetupCardViewModel` per window and weaves the
 *   row into the transcript (`setup-card-rows.ts`);
 * - the host, which numbers ordinals and must reserve exactly the same rows
 *   (`row-projection.ts`).
 *
 * The VIEW MODEL stays in the GUI - per-workspace state rollup, retry routing,
 * terminal liveness. What lives here is only what decides that a row EXISTS,
 * where it sorts, and what it anchors to. Splitting on that line is what lets
 * this be pure protocol code.
 *
 * A cold review found the host's enumeration missing these rows entirely: a
 * chat with a historical re-bind renders a setup card in legacy mode and could
 * neither reserve nor hydrate it on the windowed path.
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
   * True only for the window still OPEN at the end of the walk. A window closed
   * by a boundary is historical and keeps whatever state its last event left
   * it in - which CAN be `setting-up` when the worktree vanished mid-setup, so
   * anything asking "is setup in flight" must read this and never the state.
   */
  readonly isActive: boolean;
  /**
   * The stamp of the event that closed this window, or `null` while it is open.
   *
   * Derivable only from the WHOLE log: the closing event is either not a setup
   * event (`worktree.missing`) or the opening event of the next lifecycle, so a
   * client holding a slice of setup rows has nothing that implies it. Published
   * on the wire identity for exactly that reason.
   */
  readonly closedAt: number | null;
  /**
   * Whether the window holds a `setup.creating` event. Its PRESENCE marks a
   * live mid-conversation creation (trustworthy `createdAt`); its absence marks
   * the back-filled genesis worktree, whose stamp can land after the first
   * message and which therefore pins to the top of the transcript instead of
   * sorting.
   */
  readonly hasCreatingEvent: boolean;
  /**
   * The id of the user message whose send carried this creation, when the
   * creating event named one. The row anchors DIRECTLY above that message by
   * id rather than by `createdAt`: the card is announced before the slow
   * `git worktree add` while its message persists only after, so a timestamp
   * sort would place the card below the message and then jump it above.
   *
   * Deliberately independent of {@link hasCreatingEvent}: a creating event
   * missing its id still marks a mid-chat creation (so it must not pin as
   * genesis) yet has no anchor target (so it floats).
   */
  readonly triggeringMessageId: string | null;
}

/**
 * Partitions a chat's events into setup lifecycle windows, in chronological
 * order.
 *
 * A chat log can hold more than one. A retry updates a workspace in place (same
 * window), but a same-host re-bind appends a fresh `setup.running` to the SAME
 * log after the prior worktree went missing - the old card must stay `ready`
 * and a new card must appear at the re-bind moment, not flip the old one back
 * to `setting-up`. (A cross-host re-bind clones the chat artifact, so that case
 * never reaches one log.)
 */
export function partitionSetupCardWindows(
  events: readonly ChatEvent[],
): readonly SetupCardWindow[] {
  const windows: ChatEvent[][] = [];
  // The stamp of the event that CLOSED each window, by window index. The
  // boundary is not part of the window it ends - it is either not a setup event
  // at all (`worktree.missing`) or the first event of the NEXT lifecycle - so a
  // client re-partitioning a slice can never derive it. See `closedAt` on the
  // wire identity for what it settles.
  const closedAt: (number | null)[] = [];
  let current: ChatEvent[] | null = null;
  const closeCurrent = (at: number): void => {
    if (current !== null) closedAt[windows.length - 1] = at;
    current = null;
  };

  for (const event of events) {
    // `worktree.missing` is the lifecycle boundary: not a setup event itself,
    // but it marks the binding reset separating two lifecycles. Covers a
    // re-bind to a different path.
    if (event.type === "worktree.missing") {
      closeCurrent(event.timestamp);
      continue;
    }
    if (!SETUP_EVENT_TYPES.has(event.type)) continue;

    // A path-less setup event (the generic `SETUP_AWAIT_FAILED` catch) can
    // neither name a workspace nor drive its retry, so it never forms or
    // affects a window. Empty counts as absent here - see `event-metadata.ts`
    // on why that judgement lives at the call site.
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

  // `current` is non-null only when the final window is still open, and it
  // always references the last-pushed window - so an identity check marks
  // exactly the one live lifecycle active.
  return windows.map((windowEvents, index) =>
    describeWindow(windowEvents, windowEvents === current, closedAt[index]),
  );
}

/**
 * Whether `event` starts a new lifecycle rather than joining the open one.
 *
 * Three boundaries, all defensive against a re-bind that skipped
 * `worktree.missing`:
 *
 * 1. `setup.running` for a path the window already saw `succeeded` - a
 *    ready->running re-bind.
 * 2. `setup.creating` once the window has moved past its initial creating
 *    phase - a separate create send, including one targeting a different
 *    workspace. The consecutive creating events of ONE multi-worktree send all
 *    precede any `setup.running`, so they still consolidate into one window.
 * 3. `setup.creating` repeating for a path already `creating` here - the first
 *    create attempt was abandoned before it ran.
 *
 * A `failed`/`cancelled` -> `running` retry has no boundary: it supersedes in
 * place, within the same window.
 */
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
