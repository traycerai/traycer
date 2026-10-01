import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { WorktreeHostEntryV12 } from "@traycer/protocol/host/worktree-schemas";
import {
  canEditHistoryItemTitle,
  historyRowTimeLabel,
  type HistoryItem,
} from "@/components/home/data/home-page.data";
import { HistoryTaskRow } from "@/components/epics/history-task-row";
import { historyItemDisplayTitle } from "@/components/epics/history-item-title";
import { EpicsListLoading } from "@/components/epics/epics-list-shared";
import { useHistoryOpenItem } from "@/components/epics/use-history-open-item";
import {
  useHistoryOpenInNewWindowFlow,
  type HistoryNewWindowFlow,
} from "@/components/epics/use-history-open-in-new-window";
import {
  HistoryOpenInBackgroundMenuItem,
  HistoryOpenInNewWindowMenuItem,
} from "@/components/epics/history-row-open-menu-items";
import { openHistoryItemInBackground } from "@/components/epics/open-history-item-in-background";
import { UnsyncedEpicMoveDialog } from "@/components/layout/dialogs/unsynced-epic-move-dialog";
import { PARTIAL_ACTIVITY_NOTICE } from "@/components/notifications/notification-indicator-icon";
import { NotificationIndicatorsProvider } from "@/components/notifications/notification-indicators-provider";
import { HistoryTaskOrganizationMenu } from "@/components/organization/task-organization-menu";
import { Kbd } from "@/components/ui/kbd";
import { ShortcutHint } from "@/components/ui/shortcut-hint";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  useEpicSetPinned,
  usePendingSetPinnedEpicIds,
} from "@/hooks/epic/use-epic-set-pinned-mutation";
import { useCurrentTasks } from "@/hooks/home/use-current-tasks";
import { useNotificationIndicators } from "@/hooks/notifications/use-notification-indicators-query";
import { useOrganizationTasks } from "@/hooks/organization/organization-context";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useTaskWorktreeMetadataForClient } from "@/hooks/worktree/use-task-worktree-metadata-query";
import { onMiddleClick } from "@/lib/dom/on-middle-click";
import { formatChordForDisplay } from "@/lib/keybindings/chord";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useBindingForAction } from "@/stores/settings/keybinding-store";
import { useSystemTabModalActions } from "@/stores/tabs/use-system-tab-modal";

const GROUP_PREVIEW_COUNT = 5;
const EMPTY_WORKTREES: readonly WorktreeHostEntryV12[] = [];
const ROW_SELECTOR = "[data-current-task-id]";
const MORE_CLASS_NAME =
  "mt-2 ml-1 self-start rounded-sm bg-foreground/6 px-2.5 py-1.25 text-ui-xs text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground active:press-scrim focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2";

export function CurrentTasksSection(): ReactNode {
  const { groups, isPending, pinsComplete, activityCoverage } =
    useCurrentTasks();
  const { openHistory } = useSystemTabModalActions();
  const setPinned = useEpicSetPinned();
  const pendingPinIds = usePendingSetPinnedEpicIds();
  const onSetPinned = (item: HistoryItem, pinned: boolean): void => {
    setPinned.mutate({
      epicId: item.epicId,
      pinned,
      isLocalHome: item.isLocalHome === true,
      hostId: item.hostId ?? null,
    });
  };
  const chord = useBindingForAction("app.history.open");
  const headingId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  const historyRef = useRef<HTMLButtonElement>(null);
  const onRowKeyDown = useCurrentTaskFocus(sectionRef, historyRef);
  const epicIds = useMemo(
    () =>
      [...groups.inProgress, ...groups.pinned, ...groups.open].map(
        (item) => item.epicId,
      ),
    [groups],
  );
  const indicators = useNotificationIndicators({
    hostId: null,
    epicIds,
    chatIds: [],
    enabled: epicIds.length > 0,
  });
  const newWindowFlow = useHistoryOpenInNewWindowFlow();
  const groupRowProps = {
    onRowKeyDown,
    onSetPinned,
    pendingPinIds,
    newWindowFlow,
  };
  const isEmpty = epicIds.length === 0;
  const confirmedEmpty =
    isEmpty && !isPending && pinsComplete && activityCoverage === "fleet";
  return (
    <TooltipProvider>
      <NotificationIndicatorsProvider indicators={indicators}>
        <section
          ref={sectionRef}
          data-testid="current-tasks-section"
          aria-labelledby={headingId}
          className="mt-7 flex min-h-0 flex-col"
        >
          <div className="mb-3 flex shrink-0 items-center justify-between gap-3 px-1">
            <h2
              id={headingId}
              className="text-overline font-semibold uppercase tracking-[0.06em] text-muted-foreground"
            >
              Current tasks
            </h2>
            <button
              ref={historyRef}
              type="button"
              onClick={openHistory}
              className="-mr-2 inline-flex min-h-7 items-center gap-2 rounded-sm px-2 py-1 text-ui-xs text-muted-foreground transition-colors hover:bg-foreground/6 hover:text-foreground active:press-scrim focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2"
            >
              View history
              {chord === null ? null : (
                <ShortcutHint>
                  <Kbd size="xs">{formatChordForDisplay(chord)}</Kbd>
                </ShortcutHint>
              )}
            </button>
          </div>
          <div className="min-h-0 overflow-y-auto">
            {confirmedEmpty ? (
              <div className="flex flex-col items-center gap-1.5 px-4 py-9 text-center">
                <p className="text-ui-sm font-medium">No current tasks</p>
                <p className="max-w-xl text-pretty text-ui-xs leading-relaxed text-muted-foreground">
                  Pinned tasks, tasks in progress, and open tabs appear here.
                  Start one above, or pin a task from History to keep it in
                  reach.
                </p>
                <button
                  type="button"
                  onClick={openHistory}
                  className="mt-2.5 rounded-sm bg-foreground/6 px-2.5 py-1.25 text-ui-xs text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground active:press-scrim focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
                >
                  View history
                </button>
              </div>
            ) : (
              <>
                {isEmpty && isPending ? <EpicsListLoading /> : null}
                <CurrentTaskGroup
                  title="In progress"
                  items={groups.inProgress}
                  {...groupRowProps}
                  notice={
                    activityCoverage === "fleet"
                      ? null
                      : PARTIAL_ACTIVITY_NOTICE
                  }
                />
                <CurrentTaskGroup
                  title="Pinned"
                  items={groups.pinned}
                  {...groupRowProps}
                  notice={
                    !isPending && !pinsComplete
                      ? pinnedTasksUnavailableNotice(groups.pinned.length)
                      : null
                  }
                />
                <CurrentTaskGroup
                  title="Open"
                  items={groups.open}
                  {...groupRowProps}
                  notice={null}
                />
              </>
            )}
          </div>
        </section>
      </NotificationIndicatorsProvider>
      <UnsyncedEpicMoveDialog flow={newWindowFlow.epicFlow} />
    </TooltipProvider>
  );
}

function CurrentTaskGroup(props: {
  readonly title: string;
  readonly items: readonly HistoryItem[];
  readonly notice: string | null;
  readonly onSetPinned: (item: HistoryItem, pinned: boolean) => void;
  readonly pendingPinIds: ReadonlySet<string>;
  readonly onRowKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  readonly newWindowFlow: HistoryNewWindowFlow;
}): ReactNode {
  const headingId = useId();
  const [expanded, setExpanded] = useState(false);
  const remaining = props.items.length - GROUP_PREVIEW_COUNT;
  if (props.items.length === 0 && props.notice === null) return null;
  const visible = expanded
    ? props.items
    : props.items.slice(0, GROUP_PREVIEW_COUNT);
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col [&+section]:mt-4.5"
    >
      <h3
        id={headingId}
        className="mb-1 flex items-baseline gap-2 px-2.5 text-overline font-semibold uppercase tracking-[0.06em] text-muted-foreground"
      >
        {props.title}
        <span className="text-micro font-normal tracking-normal tabular-nums opacity-80">
          {props.items.length}
        </span>
      </h3>
      <ul className="flex flex-col gap-0.5">
        {visible.map((item) => (
          <CurrentTaskRow
            key={item.id}
            item={item}
            onRowKeyDown={props.onRowKeyDown}
            onSetPinned={props.onSetPinned}
            isPinPending={props.pendingPinIds.has(item.epicId)}
            newWindowFlow={props.newWindowFlow}
          />
        ))}
      </ul>
      {!expanded && remaining > 0 ? (
        <button
          type="button"
          className={MORE_CLASS_NAME}
          onClick={() => setExpanded(true)}
        >
          Show {remaining} more
        </button>
      ) : null}
      {props.notice === null ? null : (
        <p className="px-2.5 py-1 text-ui-xs text-muted-foreground">
          {props.notice}
        </p>
      )}
    </section>
  );
}

// A task shows the same labels, PRs, menu and middle-click here as in
// History. Renaming, deleting and worktree clean-up stay History-only: this
// list is for getting back to a task, History is where tasks are tidied up.
function CurrentTaskRow(props: {
  readonly item: HistoryItem;
  readonly onSetPinned: (item: HistoryItem, pinned: boolean) => void;
  readonly isPinPending: boolean;
  readonly onRowKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  readonly newWindowFlow: HistoryNewWindowFlow;
}): ReactNode {
  const openItem = useHistoryOpenItem({ onSelectEpic: null, onOpenItem: null });
  const item = props.item;
  const worktrees = useCurrentTaskWorktrees(item);
  const isPhase = item.taskType === "phase";
  const isOpen = useEpicCanvasStore(
    (state) => state.resolveTabIdForEpic(item.epicId) !== null,
  );
  const cloudAuthorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  const canEdit = canEditHistoryItemTitle(item, cloudAuthorized);
  // The organization view only carries tasks some surface registered. Open
  // tabs and History register theirs, but a pinned or running task that is
  // not open is registered by nobody else, and its menu would then read no
  // group membership or appearance. Same exclusions as History's registration.
  const hasTaskOrganization =
    item.taskType === "epic" &&
    item.isLocalHome !== true &&
    item.isPreservedOrphan !== true;
  useOrganizationTasks(hasTaskOrganization ? [item.epicId] : []);
  return (
    <HistoryTaskRow
      organization={{ canEdit }}
      item={item}
      timeLabel={historyRowTimeLabel(item, "recent")}
      selectionMode={false}
      selectionDisabled={false}
      selectedForDelete={false}
      selectionControl={null}
      renderInteractionTarget={(describedBy) => (
        <button
          type="button"
          data-current-task-id={item.id}
          data-history-row-target=""
          aria-label={`Open task ${historyItemDisplayTitle(item)}`}
          aria-describedby={describedBy}
          onClick={() => openItem(item)}
          onAuxClick={onMiddleClick(() => {
            // A phase has no background open, so it opens in place.
            if (isPhase) openItem(item);
            else openHistoryItemInBackground(item, isOpen);
          })}
          onKeyDown={props.onRowKeyDown}
          className="absolute inset-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        />
      )}
      renameEditor={null}
      renameControl={null}
      deleteControl={null}
      sweepControl={null}
      sweepMenuItem={null}
      hasSweepControl={false}
      contextMenuItems={
        isPhase ? null : (
          <>
            <HistoryTaskOrganizationMenu item={item} canEdit={canEdit} />
            <HistoryOpenInBackgroundMenuItem item={item} isOpen={isOpen} />
          </>
        )
      }
      openInNewWindowControl={
        props.newWindowFlow.isAvailable ? (
          <HistoryOpenInNewWindowMenuItem
            onSelect={() => props.newWindowFlow.requestOpen(item)}
          />
        ) : null
      }
      onSetPinned={(_epicId, pinned) => props.onSetPinned(item, pinned)}
      isPinPending={props.isPinPending}
      pinAlwaysVisible
      showOpenBadge={false}
      isOpen={isOpen}
      worktrees={worktrees}
    />
  );
}

// Current tasks spans every host, so each row reads its own task's worktrees
// (where its PRs come from) from the host that owns the task, falling back to
// the window's host for a cloud task. Reading per row also means a row hidden
// behind "Show more" probes nothing until it is shown.
function useCurrentTaskWorktrees(
  item: HistoryItem,
): readonly WorktreeHostEntryV12[] {
  const client = useHostClientForHostId(item.hostId ?? null);
  const epicIds = useMemo(() => [item.epicId], [item.epicId]);
  const { worktreesByEpicId } = useTaskWorktreeMetadataForClient(
    client,
    epicIds,
  );
  return worktreesByEpicId.get(item.epicId) ?? EMPTY_WORKTREES;
}

function pinnedTasksUnavailableNotice(pinnedCount: number): string {
  return pinnedCount > 0
    ? "Some pinned tasks couldn't load."
    : "Can't load your pinned tasks right now.";
}

function currentTaskTargets(scope: HTMLElement): HTMLElement[] {
  return Array.from(scope.querySelectorAll<HTMLElement>(ROW_SELECTOR));
}

function useCurrentTaskFocus(
  sectionRef: RefObject<HTMLElement | null>,
  historyRef: RefObject<HTMLButtonElement | null>,
): (event: KeyboardEvent<HTMLElement>) => void {
  const focusRef = useRef<{
    element: HTMLElement;
    id: string;
    order: string[];
  } | null>(null);
  useLayoutEffect(() => {
    const section = sectionRef.current;
    if (section === null) return;
    const rememberFocus = () => {
      const active = section.ownerDocument.activeElement;
      const row = active
        ?.closest("li")
        ?.querySelector<HTMLElement>(ROW_SELECTOR);
      if (
        !(active instanceof HTMLElement) ||
        row === null ||
        row === undefined ||
        !section.contains(row)
      ) {
        focusRef.current = null;
        return;
      }
      focusRef.current = {
        element: active,
        id: row.dataset.currentTaskId ?? "",
        order: currentTaskTargets(section).map(
          (target) => target.dataset.currentTaskId ?? "",
        ),
      };
    };
    section.ownerDocument.addEventListener("focusin", rememberFocus);
    return () =>
      section.ownerDocument.removeEventListener("focusin", rememberFocus);
  }, [sectionRef]);
  useLayoutEffect(() => {
    const section = sectionRef.current;
    const focused = focusRef.current;
    if (section === null || focused === null) return;
    const targets = currentTaskTargets(section);
    if (focused.element.isConnected) {
      focused.order = targets.map(
        (target) => target.dataset.currentTaskId ?? "",
      );
      return;
    }
    const byId = new Map(
      targets.map((target) => [target.dataset.currentTaskId, target]),
    );
    const index = focused.order.indexOf(focused.id);
    const candidates = [
      focused.id,
      ...focused.order.slice(index + 1),
      ...focused.order.slice(0, index).reverse(),
    ];
    const nextId = candidates.find((id) => byId.has(id));
    const next = nextId === undefined ? historyRef.current : byId.get(nextId);
    next?.focus();
  });
  return (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const section = sectionRef.current;
    if (section === null) return;
    const targets = currentTaskTargets(section);
    const index = targets.indexOf(event.currentTarget);
    if (index < 0) return;
    event.preventDefault();
    const delta = event.key === "ArrowDown" ? 1 : -1;
    targets[Math.max(0, Math.min(index + delta, targets.length - 1))].focus();
  };
}
