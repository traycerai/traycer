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
import type { HistoryItem } from "@/components/home/data/home-page.data";
import { HistoryTaskRow } from "@/components/epics/history-task-row";
import { historyItemDisplayTitle } from "@/components/epics/history-item-title";
import { EpicsListLoading } from "@/components/epics/epics-list-shared";
import { useHistoryOpenItem } from "@/components/epics/use-history-open-item";
import { NotificationIndicatorsProvider } from "@/components/notifications/notification-indicators-provider";
import { Kbd } from "@/components/ui/kbd";
import { ShortcutHint } from "@/components/ui/shortcut-hint";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  useEpicSetPinned,
  usePendingSetPinnedEpicIds,
} from "@/hooks/epic/use-epic-set-pinned-mutation";
import { useCurrentTasks } from "@/hooks/home/use-current-tasks";
import { useNotificationIndicators } from "@/hooks/notifications/use-notification-indicators-query";
import { formatChordForDisplay } from "@/lib/keybindings/chord";
import { useBindingForAction } from "@/stores/settings/keybinding-store";
import { useSystemTabModalActions } from "@/stores/tabs/use-system-tab-modal";

const GROUP_PREVIEW_COUNT = 5;
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
                  onRowKeyDown={onRowKeyDown}
                  onSetPinned={onSetPinned}
                  pendingPinIds={pendingPinIds}
                  notice={
                    activityCoverage === "fleet"
                      ? null
                      : "Can't check everything that's running right now"
                  }
                />
                <CurrentTaskGroup
                  title="Pinned"
                  items={groups.pinned}
                  onRowKeyDown={onRowKeyDown}
                  onSetPinned={onSetPinned}
                  pendingPinIds={pendingPinIds}
                  notice={
                    !isPending && !pinsComplete
                      ? pinnedTasksUnavailableNotice(groups.pinned.length)
                      : null
                  }
                />
                <CurrentTaskGroup
                  title="Open"
                  items={groups.open}
                  onRowKeyDown={onRowKeyDown}
                  onSetPinned={onSetPinned}
                  pendingPinIds={pendingPinIds}
                  notice={null}
                />
              </>
            )}
          </div>
        </section>
      </NotificationIndicatorsProvider>
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

function CurrentTaskRow(props: {
  readonly item: HistoryItem;
  readonly onSetPinned: (item: HistoryItem, pinned: boolean) => void;
  readonly isPinPending: boolean;
  readonly onRowKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}): ReactNode {
  const openItem = useHistoryOpenItem({ onSelectEpic: null, onOpenItem: null });
  const item = props.item;
  return (
    <HistoryTaskRow
      organization={null}
      item={item}
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
      contextMenuItems={null}
      openInNewWindowControl={null}
      onSetPinned={(_epicId, pinned) => props.onSetPinned(item, pinned)}
      isPinPending={props.isPinPending}
      pinAlwaysVisible
      showOpenBadge={false}
      isOpen={false}
      worktrees={[]}
    />
  );
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
