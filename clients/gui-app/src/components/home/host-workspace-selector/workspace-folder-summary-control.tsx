import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { FolderPlus } from "lucide-react";
import { Slot } from "radix-ui";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useActivePaneEffect } from "@/components/epic-tabs/pane-visibility-context";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { HoverPreviewCard } from "@/components/ui/hover-preview-card";
import { Kbd } from "@/components/ui/kbd";
import { ShortcutHint } from "@/components/ui/shortcut-hint";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useRefreshSpinner } from "@/hooks/use-refresh-spinner";
import type { WorktreeWorkspacesRefresh } from "@/hooks/worktree/use-worktree-workspaces-refresh";
import { isEditableEventTarget } from "@/lib/keybindings/editable-target";
import { useBareKeyClaimer } from "@/lib/keybindings/use-bare-key-claimer";
import { useCompactRelativeTime } from "@/lib/relative-time";
import { preserveWhenNestedOverlay } from "./preserve-when-nested-overlay";
import { useDialogOverlayBoundaryEl } from "@/providers/dialog-overlay-boundary-context";
import {
  AddFolderButton,
  type AddFolderHandler,
  WorkspaceFolderRows,
} from "./workspace-folder-rows";
import { WorkspaceFolderHoverList } from "./workspace-folder-hover-list";
import { WorkspaceFolderPreviewSheet } from "./workspace-folder-preview-sheet";
import { useWorkspaceFolderPreviewReveal } from "./use-workspace-folder-preview-reveal";
import { WorkspaceSummaryTrigger } from "./workspace-summary-trigger";
import type { WorkspaceRunItem } from "./workspace-run-item";

// Disk-bound git reads over a handful of folders - no network probe, unlike
// the owner hover card's `gh` leg. Still a leash, so a wedged host can't
// strand the button disabled. Caps the *local* spinner contribution of a
// manual trigger; the mutation's own `isPending` is capped separately by
// {@link EXTERNAL_REFRESH_DEADLINE_MS}.
const WORKSPACE_REFRESH_TIMEOUT_MS = 15_000;

// Safety cap on the refresh mutation's contribution to "Checking…". Past this
// the footer switches to "Couldn't verify — Retry" instead of spinning forever
// against a hung host. Independent of the local 15s trigger timeout above.
const EXTERNAL_REFRESH_DEADLINE_MS = 30_000;

// Module scope so the identity is stable when there is nothing to refresh -
// a fresh arrow per render would re-bind the key listener on every render.
const NOOP_REFRESH = (): Promise<void> => Promise.resolve();

interface SummaryOverlayState {
  readonly workspacePopoverOpen: boolean;
  readonly summaryHoverOpen: boolean;
}

/**
 * Caps an external `isRefreshing` contribution to the spinner at ~30s, keyed
 * to `attemptId` so a Retry after timeout starts a fresh deadline rather than
 * inheriting the previous attempt's expired timer. No setState-on-clear: when
 * `isRefreshing` is false the exceeded flag is simply not applied.
 */
function useExternalRefreshDeadline(args: {
  readonly isRefreshing: boolean;
  readonly attemptId: number;
}): boolean {
  const { isRefreshing, attemptId } = args;
  // Stores the attempt id that timed out — compared to the live attemptId so
  // a new generation cannot be treated as already expired.
  const [timedOutAttemptId, setTimedOutAttemptId] = useState<number | null>(
    null,
  );
  useEffect(() => {
    if (!isRefreshing) return;
    const capturedAttemptId = attemptId;
    const timerId = window.setTimeout(() => {
      setTimedOutAttemptId(capturedAttemptId);
    }, EXTERNAL_REFRESH_DEADLINE_MS);
    return () => {
      window.clearTimeout(timerId);
    };
  }, [isRefreshing, attemptId]);
  return isRefreshing && timedOutAttemptId === attemptId;
}

/**
 * Resting folder control shared by landing and in-epic composers. It is the
 * single owner of the empty-state shortcut: resolved + no folders renders
 * "Add folder" directly instead of a "No folder attached" summary popover.
 */
interface WorkspaceRefreshUi {
  readonly checkedAt: number | null;
  readonly refreshing: boolean;
  readonly verifyFailed: boolean;
  readonly canRefresh: boolean;
  readonly retryBlocked: boolean;
  readonly triggerRefresh: () => void;
}

/**
 * Owns the refresh spinner + 30s external deadline so the summary control's
 * complexity stays under the ESLint cap. Keys the deadline to
 * `refreshGeneration` so Retry after a timeout starts a fresh window.
 */
function useWorkspaceRefreshUi(
  refreshState: WorktreeWorkspacesRefresh | null,
): WorkspaceRefreshUi {
  const isExternalRefreshing = refreshState?.isRefreshing ?? false;
  const refreshGeneration = refreshState?.refreshGeneration ?? 0;
  const externalDeadlineExceeded = useExternalRefreshDeadline({
    isRefreshing: isExternalRefreshing,
    attemptId: refreshGeneration,
  });
  const refreshSpinner = useRefreshSpinner({
    onRefresh: refreshState?.refresh ?? NOOP_REFRESH,
    // Past the deadline the mutation may still be pending, but it no longer
    // drives the spinner — Retry is re-enabled without stacking a second
    // "external" block on the first attempt's expired timer.
    externalRefreshing: isExternalRefreshing && !externalDeadlineExceeded,
    timeoutMs: WORKSPACE_REFRESH_TIMEOUT_MS,
  });
  return {
    checkedAt: refreshState?.checkedAt ?? null,
    refreshing: refreshSpinner.refreshing,
    verifyFailed:
      (refreshState?.verifyFailed ?? false) || externalDeadlineExceeded,
    canRefresh: refreshState?.canRefresh ?? false,
    // While a non-deadline-exceeded attempt is still in flight, Retry must not
    // stack a parallel force. After the deadline, spinner contribution drops so
    // Retry is enabled even if the hung mutation has not settled.
    retryBlocked: refreshSpinner.refreshing && !externalDeadlineExceeded,
    triggerRefresh: refreshSpinner.trigger,
  };
}

export function WorkspaceFolderSummaryControl(props: {
  readonly items: ReadonlyArray<WorkspaceRunItem>;
  readonly readOnly: boolean;
  readonly bindingResolved: boolean;
  readonly addFolderPending: boolean;
  readonly addFolderDisabled: boolean;
  readonly addFolderDisabledReason: string | null;
  readonly onAddFolder: AddFolderHandler;
  readonly onUpdate: (() => void) | null;
  readonly updateEnabled: boolean;
  readonly updatePending: boolean;
  /** Uncommitted workspace draft on the summary chip. */
  readonly draftPending?: boolean;
  readonly onDiscardStaged: (() => void) | null;
  /** True while a captured Update/teardown run is in flight. */
  readonly discardDisabled: boolean;
  readonly onEditEnvironment: (workspacePath: string) => void;
  /**
   * Re-derives these folders from disk, or `null` on a surface with no host to
   * ask. The picker is the only place the Local branch label can be corrected:
   * it is read-only by design (users switch that checkout with git, outside
   * Traycer), so when the host's cached view falls behind disk there is no
   * other control that would incidentally fix it.
   */
  readonly refresh: WorktreeWorkspacesRefresh | null;
  readonly popoverTestId: string;
  readonly popoverSide: "top" | "bottom";
  readonly recentWorkspaces: ReactNode;
  readonly recentWorkspaceCount: number;
  readonly moveToRecent: boolean;
}) {
  const itemCount = props.items.length;
  const [overlayState, setOverlayState] = useState<SummaryOverlayState>({
    workspacePopoverOpen: false,
    summaryHoverOpen: false,
  });
  const preview = useWorkspaceFolderPreviewReveal();
  const refreshUi = useWorkspaceRefreshUi(props.refresh);
  const triggerRefresh = refreshUi.triggerRefresh;
  const canRefresh = refreshUi.canRefresh;
  const popoverOpen = overlayState.workspacePopoverOpen;
  // Bound at the WINDOW, not on the popover content: the content prevents its
  // own open-autofocus (so a click never yanks the caret out of the composer),
  // which leaves focus on the trigger - outside the portaled content, whose
  // `onKeyDown` therefore never fires. The profile dropdown can use a
  // content-level handler precisely because a Radix menu does take focus.
  //
  // Unlike the owner hover card's `R`, this one DOES defer to text fields: the
  // popover holds the new-worktree branch input, so an unguarded listener
  // would swallow every "r" typed into a branch name.
  //
  // `canRefresh` repeats the button's own disabled condition rather than
  // relying on it: a disabled button ignores clicks, but nothing stops this
  // listener, and firing with no host bound would reject straight into the
  // failure toast.
  //
  // Gated on the FOCUSED pane, not just `popoverOpen`. In a split view the
  // pane-aware `PopoverContent` unmounts its portal when the sibling pane takes
  // focus while deliberately leaving this controlled root open - so an
  // open-only gate would keep a live window-level `R` for a picker that is no
  // longer on screen, refreshing the hidden pane and swallowing the keystroke
  // from the focused one. `useActivePaneEffect` is the canonical gate for
  // exactly this class of pane-local global ownership.
  // Claimed through the shared owner, not bound at the window directly: the
  // worktree owner hover card binds bare `R` too, and can be open in this same
  // pane. Two raw window listeners would both fire - `preventDefault` stops the
  // browser, not a sibling listener - so one `R` would refresh both surfaces,
  // including the card, which deliberately does not defer to text fields.
  //
  // The claim depends only on the popover being open and refreshable, never on
  // `triggerRefresh` - that identity moves every time `refreshing` toggles, and
  // re-claiming on it would push this picker back above an owner card that
  // opened after it just because a refresh finished. See `useBareKeyClaimer`.
  const claimRefreshKey = useBareKeyClaimer("r", (event) => {
    if (isEditableEventTarget(event.target)) return;
    event.preventDefault();
    triggerRefresh();
  });
  const onRefreshKeyDown = useCallback((): (() => void) | undefined => {
    if (!popoverOpen || !canRefresh) return undefined;
    return claimRefreshKey();
  }, [canRefresh, claimRefreshKey, popoverOpen]);
  useActivePaneEffect(onRefreshKeyDown);
  // The popover's own content node, so an outside-click can tell a nested
  // overlay (stacked above) from the host dialog (an ancestor) - see
  // preserveWhenNestedOverlay.
  const contentRef = useRef<HTMLDivElement>(null);
  // Non-null only inside a modal dialog (the New Conversation modal) - see
  // `DialogOverlayBoundaryContext`. Containing this popover inside the
  // dialog's own DOM (instead of the default `document.body` portal) keeps it
  // - and the branch/location popovers nested inside it - within the
  // dialog's scroll-lock boundary, so wheel scrolling their lists works.
  const dialogBoundaryEl = useDialogOverlayBoundaryEl();

  const handleExternalAddFolder = async (): Promise<boolean> => {
    setOverlayState({
      workspacePopoverOpen: true,
      summaryHoverOpen: false,
    });
    try {
      const added = await props.onAddFolder();
      if (!added) {
        setOverlayState((current) => ({
          ...current,
          workspacePopoverOpen: false,
        }));
      }
      return added;
    } catch {
      setOverlayState((current) => ({
        ...current,
        workspacePopoverOpen: false,
      }));
      return false;
    }
  };
  const handleUpdate = (): void => {
    if (props.onUpdate === null) return;
    props.onUpdate();
    setOverlayState({
      workspacePopoverOpen: false,
      summaryHoverOpen: false,
    });
  };

  if (props.readOnly) {
    return (
      <WorkspaceSummaryTrigger
        items={props.items}
        readOnly
        bindingResolved={props.bindingResolved}
        draftPending={props.draftPending === true}
        className="max-w-full"
      />
    );
  }

  if (
    itemCount === 0 &&
    props.bindingResolved &&
    props.recentWorkspaceCount === 0
  ) {
    return (
      <AddFolderButton
        onAddFolder={handleExternalAddFolder}
        pending={props.addFolderPending}
        disabled={props.addFolderDisabled}
        disabledReason={props.addFolderDisabledReason}
      />
    );
  }

  const emptyRecentTrigger = itemCount === 0 && props.bindingResolved;
  const emptyRecentDisabled = props.addFolderPending || props.addFolderDisabled;
  const trigger = emptyRecentTrigger ? (
    <button
      type="button"
      data-testid="folder-add"
      disabled={emptyRecentDisabled}
      className="inline-flex w-fit items-center gap-2 rounded-md px-1.5 py-1 text-ui-sm text-muted-foreground outline-none transition-[background-color,color] hover:bg-foreground/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
    >
      {props.addFolderPending ? (
        <AgentSpinningDots
          className="text-current"
          testId={undefined}
          variant="dots"
        />
      ) : (
        <FolderPlus className="size-4" aria-hidden />
      )}
      <span>Add folder</span>
    </button>
  ) : (
    <WorkspaceSummaryTrigger
      items={props.items}
      readOnly={false}
      bindingResolved={props.bindingResolved}
      draftPending={props.draftPending === true}
      className="justify-start overflow-hidden"
    />
  );
  // Controlled hover, gated on the click-open popover: a HoverCard is purely
  // hover-driven and (unlike a Tooltip) does not dismiss when the trigger is
  // clicked, so the preview must be forced closed while the picker is open.
  const popoverTrigger = emptyRecentTrigger ? (
    <EmptyRecentFolderTrigger
      trigger={trigger}
      disabled={emptyRecentDisabled}
      disabledReason={
        props.addFolderDisabled ? props.addFolderDisabledReason : null
      }
    />
  ) : (
    <HoverPreviewCard
      content={<WorkspaceFolderHoverList items={props.items} />}
      side={props.popoverSide}
      sideOffset={4}
      align="start"
      open={!overlayState.workspacePopoverOpen && overlayState.summaryHoverOpen}
      onOpenChange={(open) => {
        setOverlayState((current) => {
          if (current.workspacePopoverOpen) return current;
          return { ...current, summaryHoverOpen: open };
        });
      }}
    >
      <PopoverTrigger asChild>
        {/* Innermost, so the press guard runs BEFORE the popover's own open
            handler and can prevent it - `Slot` composes a child's handler
            ahead of the slot's. */}
        <Slot.Root {...preview.triggerProps}>{trigger}</Slot.Root>
      </PopoverTrigger>
    </HoverPreviewCard>
  );

  const picker = (
    <Popover
      open={overlayState.workspacePopoverOpen}
      onOpenChange={(open) => {
        setOverlayState((current) => ({
          workspacePopoverOpen: open,
          summaryHoverOpen: open ? false : current.summaryHoverOpen,
        }));
        // Opening the picker is an explicit intent edge - the user is about to
        // decide something per folder - so re-derive from disk once, here.
        // Without it the manual button would only ever repair a label the user
        // had already been misled by; the collapsed chip shows that branch
        // without opening anything, so the stale value is visible from outside
        // the one surface that can correct it. The rows keep rendering the
        // cached view meanwhile, so this costs no blank frame.
        //
        // Deliberately NOT mirrored in `handleExternalAddFolder`, which opens
        // the popover as a side effect of the add mutation - that path already
        // invalidates this cache, and forcing a read into the same window just
        // races it.
        //
        // Gated on `canRefresh` for the same reason the `R` listener is: the
        // hook only no-ops an EMPTY path list, so opening the picker of a
        // folder set whose host is unbound would reject into "Couldn't refresh
        // folder details" - an error toast the user never asked for, next to a
        // Refresh button correctly rendered disabled.
        if (open && canRefresh) triggerRefresh();
      }}
    >
      {popoverTrigger}
      <PopoverContent
        ref={contentRef}
        side={props.popoverSide}
        align="start"
        collisionPadding={12}
        container={dialogBoundaryEl ?? undefined}
        className="w-[min(92vw,42rem)] max-w-[var(--radix-popover-content-available-width)] max-h-[min(var(--radix-popover-content-available-height),32rem)] gap-0 overflow-hidden p-0"
        data-testid={props.popoverTestId}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onInteractOutside={(event) =>
          preserveWhenNestedOverlay(event, contentRef.current)
        }
      >
        {/* Match the sidebar owner card's structure: the content owns the
            scroll, while the refresh row stays outside it. This keeps one
            consistent 12px horizontal inset and avoids sticky positioning
            interacting with the popover's padding at the bottom edge. */}
        <div
          className="min-h-0 w-full overflow-y-auto overscroll-contain px-3 pt-3 pb-2"
          data-testid="workspace-folder-scroll-region"
        >
          <WorkspaceFolderRows
            items={props.items}
            trailingSlot={null}
            addFolderPending={props.addFolderPending}
            addFolderDisabled={props.addFolderDisabled}
            addFolderDisabledReason={props.addFolderDisabledReason}
            onAddFolder={props.onAddFolder}
            onUpdate={props.onUpdate === null ? null : handleUpdate}
            updateEnabled={props.updateEnabled}
            updatePending={props.updatePending}
            onDiscardStaged={props.onDiscardStaged}
            discardDisabled={props.discardDisabled}
            draftPending={props.draftPending === true}
            onEditEnvironment={props.onEditEnvironment}
            readOnly={false}
            nestedInPopover={dialogBoundaryEl !== null}
            bindingResolved={props.bindingResolved}
            recentWorkspaces={props.recentWorkspaces}
            moveToRecent={props.moveToRecent}
          />
        </div>
        {props.refresh === null ? null : (
          <WorkspaceRefreshFooter
            checkedAt={refreshUi.checkedAt}
            refreshing={refreshUi.refreshing}
            verifyFailed={refreshUi.verifyFailed}
            canRefresh={refreshUi.canRefresh}
            retryBlocked={refreshUi.retryBlocked}
            onRefresh={triggerRefresh}
          />
        )}
      </PopoverContent>
    </Popover>
  );
  return (
    <>
      {picker}
      <WorkspaceFolderPreviewSheet
        items={props.items}
        open={preview.open}
        onClose={preview.close}
      />
    </>
  );
}

function EmptyRecentFolderTrigger(props: {
  readonly trigger: ReactNode;
  readonly disabled: boolean;
  readonly disabledReason: string | null;
}): ReactNode {
  if (!props.disabled) {
    return <PopoverTrigger asChild>{props.trigger}</PopoverTrigger>;
  }
  if (props.disabledReason === null) return props.trigger;
  return (
    <TooltipWrapper
      label={props.disabledReason}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <span
        className="inline-flex w-fit"
        data-testid="folder-add-disabled-reason"
      >
        {props.trigger}
      </span>
    </TooltipWrapper>
  );
}

/**
 * How old the folder facts are, and the action that re-derives them.
 *
 * Outside the scroll region, matching the left-sidebar owner hover card: a
 * long folder list scrolls under a fixed footer, and the inset divider and
 * controls share the same horizontal rhythm as the folder content above.
 */
function WorkspaceRefreshFooter(props: {
  readonly checkedAt: number | null;
  readonly refreshing: boolean;
  readonly verifyFailed: boolean;
  readonly canRefresh: boolean;
  /** True while a non-deadline-exceeded attempt is still spinning. */
  readonly retryBlocked: boolean;
  readonly onRefresh: () => void;
}): ReactNode {
  // Failure takes priority over "Checking…": a settled error or the external
  // deadline leaves the footer in a recoverable state rather than a silent
  // return to the idle stamp (or an eternal spinner).
  if (props.verifyFailed && !props.refreshing) {
    return (
      <div
        className="shrink-0 bg-popover px-3"
        data-testid="workspace-refresh-footer"
      >
        <div className="flex items-center justify-between gap-2 border-t border-border/25 py-1.5">
          <span
            className="text-ui-xs text-muted-foreground"
            data-testid="workspace-folders-verify-failed"
          >
            Couldn&apos;t verify —
          </span>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            aria-label="Retry verifying folder details"
            disabled={!props.canRefresh || props.retryBlocked}
            onClick={props.onRefresh}
            data-testid="workspace-folders-refresh-retry"
          >
            Retry
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div
      className="shrink-0 bg-popover px-3"
      data-testid="workspace-refresh-footer"
    >
      <div className="flex items-center justify-between gap-2 border-t border-border/25 py-1.5">
        <WorkspaceCheckedAt
          checkedAt={props.checkedAt}
          refreshing={props.refreshing}
        />
        <Button
          type="button"
          size="xs"
          variant="ghost"
          aria-label="Refresh folder details"
          aria-keyshortcuts="R"
          disabled={!props.canRefresh || props.refreshing}
          onClick={props.onRefresh}
          data-testid="workspace-folders-refresh"
        >
          {props.refreshing ? (
            <AgentSpinningDots
              className="text-muted-foreground"
              testId="workspace-folders-refresh-spinner"
              variant={undefined}
            />
          ) : null}
          Refresh
          <ShortcutHint>
            <Kbd className="ml-0.5 font-mono">R</Kbd>
          </ShortcutHint>
        </Button>
      </div>
    </div>
  );
}

/**
 * Isolated in its own leaf because `useCompactRelativeTime` re-renders on a
 * shared 60s tick - keeping it here means the tick repaints this one span
 * rather than the whole picker.
 */
function WorkspaceCheckedAt(props: {
  readonly checkedAt: number | null;
  readonly refreshing: boolean;
}): ReactNode {
  if (props.refreshing) {
    return <span className="text-ui-xs text-muted-foreground">Checking…</span>;
  }
  if (props.checkedAt === null) return <span />;
  return <WorkspaceCheckedAtText checkedAt={props.checkedAt} />;
}

function WorkspaceCheckedAtText(props: {
  readonly checkedAt: number;
}): ReactNode {
  const relative = useCompactRelativeTime(props.checkedAt);
  return (
    <span
      className="text-ui-xs whitespace-nowrap text-muted-foreground"
      data-testid="workspace-folders-checked-at"
    >
      Workspace snapshot · {relative}
    </span>
  );
}
