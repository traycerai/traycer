import type { ChatLowerSurfaceTopSpacing } from "@/components/chat/chat-pinned-stack";
import type { ChatDockSection } from "@/lib/chat/chat-dock-sections";

/**
 * Whether the dock's Background section has anything to show. It lives here
 * rather than in the dock because the answer sizes the scroll region below and
 * the composer's top spacing too: the dock's frame is drawn flush against what
 * follows it, so a surface that disagrees leaves an open-bottomed box.
 *
 * Managed commands count even when the harness session reports no background
 * work of its own - they reach the section by a client-side join on the epic's
 * command list.
 *
 * Held shells are a THIRD input rather than part of the running count, and the
 * distinction is load-bearing rather than tidy. The two sets do overlap - a
 * still-running shell keeps its hold until it next prints - but the hold that
 * only a human can clear is the one on a shell that has FINISHED, and that is
 * precisely the case the Deliver button exists for. There, both other counts
 * are zero: gating on them alone hid the whole section, taking the only
 * affordance that clears a hold off screen while the hold survived restarts.
 *
 * Port forwards are a FOURTH input for the same reason: a forward outlives the
 * turn that made it, so a chat that is otherwise idle can still hold one - and
 * an `interrupted` one is the row a person most needs to be able to reach.
 */
export function chatBackgroundSectionVisible(input: {
  readonly backgroundItemCount: number;
  readonly runningManagedCommandCount: number;
  readonly heldManagedCommandCount: number;
  readonly portForwardCount: number;
}): boolean {
  return (
    input.backgroundItemCount > 0 ||
    input.runningManagedCommandCount > 0 ||
    input.heldManagedCommandCount > 0 ||
    input.portForwardCount > 0
  );
}

export interface LowerScrollBudgetInput {
  readonly pinnedStackVisible: boolean;
  readonly queueVisible: boolean;
  readonly backgroundVisible: boolean;
  readonly activeAgentsVisible: boolean;
  readonly approvalVisible: boolean;
}

export function lowerScrollRegionMaxHeightClass(
  input: LowerScrollBudgetInput,
): string {
  const scrollRegions =
    Number(input.pinnedStackVisible) +
    Number(input.queueVisible) +
    Number(input.backgroundVisible) +
    Number(input.activeAgentsVisible);
  const pressure = scrollRegions + Number(input.approvalVisible);

  if (pressure >= 3) {
    return "max-h-[min(18dvh,11rem)]";
  }
  if (pressure >= 2) {
    return "max-h-[min(24dvh,14rem)]";
  }
  if (scrollRegions === 1) {
    return "max-h-[min(40dvh,24rem)]";
  }
  return "max-h-[min(40dvh,24rem)]";
}

export interface LowerSurfaceFrameInput {
  /** Sections standing as a pill right now (`useChatDockChrome`). */
  readonly folded: ReadonlySet<ChatDockSection>;
  /** The one pill whose panel is attached above the composer, or `null`. */
  readonly openSection: ChatDockSection | null;
  /** Whether each dock member has something to show at all. */
  readonly todoHasContent: boolean;
  readonly filesChangedHasContent: boolean;
  readonly activeAgentsHasContent: boolean;
  readonly backgroundHasContent: boolean;
  /** Everything queued, user-typed sends and received A2A responses alike. */
  readonly queueItemCount: number;
}

export interface LowerSurfaceFrame {
  /** Todo and Files changed, drawn as rows or as an open pill's panel. */
  readonly pinnedStackVisible: boolean;
  readonly queueVisible: boolean;
  readonly dockAgentsVisible: boolean;
  readonly dockBackgroundVisible: boolean;
  /**
   * `"connected"` when something is drawn in the dock's joined frame, which
   * the composer tucks into (no top padding of its own); `"normal"` when the
   * dock is empty or holds only pills, and the composer keeps its own `pt-4`.
   */
  readonly topSpacing: ChatLowerSurfaceTopSpacing;
}

/**
 * What each dock member DRAWS below the transcript: its full row inside the
 * frame, or the one attached panel its open pill put there (L-142). The scroll
 * budget and the composer's top spacing both ask this, and a pill panel is a
 * scroll region exactly as a row is.
 *
 * Exported for the browser fixture (`composer-queue-dock.tsx`), which measures
 * the composer's real edge against this decision rather than against a copy of
 * it: a fixture that decided "is the frame filled" with its own formula would
 * pass however this one moved.
 */
export function lowerSurfaceFrame(
  input: LowerSurfaceFrameInput,
): LowerSurfaceFrame {
  const drawsInDock = (
    section: ChatDockSection,
    hasContent: boolean,
  ): boolean =>
    (hasContent && !input.folded.has(section)) || input.openSection === section;
  const dockTodoVisible = drawsInDock("todo", input.todoHasContent);
  const dockFilesChangedVisible = drawsInDock(
    "filesChanged",
    input.filesChangedHasContent,
  );
  // Kept as one boolean (rather than two) for the scroll-budget calc, which
  // has always treated Todo and Files changed as a single pressure unit -
  // unchanged now that Files changed can render apart from Todo.
  const pinnedStackVisible = dockTodoVisible || dockFilesChangedVisible;
  // Show the queue surface whenever it holds anything - user-typed sends and
  // received A2A responses alike (the latter render read-only). It is never a
  // pill, in any mode (G1-G2, staging round 4).
  const queueVisible = input.queueItemCount > 0;
  const dockAgentsVisible = drawsInDock(
    "activeAgents",
    input.activeAgentsHasContent,
  );
  const dockBackgroundVisible = drawsInDock(
    "background",
    input.backgroundHasContent,
  );
  return {
    pinnedStackVisible,
    queueVisible,
    dockAgentsVisible,
    dockBackgroundVisible,
    topSpacing:
      pinnedStackVisible ||
      queueVisible ||
      dockAgentsVisible ||
      dockBackgroundVisible
        ? "connected"
        : "normal",
  };
}
