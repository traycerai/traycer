import {
  type FocusEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Pin } from "lucide-react";
import type { WorktreeHostEntryV12 } from "@traycer/protocol/host/worktree-schemas";
import type { HistoryItem } from "@/components/home/data/home-page.data";
import { HistoryRowLeadingIcon } from "@/components/epics/epics-list-shared";
import { historyItemDisplayTitle } from "@/components/epics/history-item-title";
import {
  historyPinControlLabel,
  historyPinUnavailableReason,
  historyPinUnavailableTooltip,
} from "@/components/epics/history-pin-availability";
import {
  historyRowProvenance,
  historyRowProvenanceLabel,
  type HistoryRowProvenance,
} from "@/components/epics/history-row-provenance";
import { ImportedUnseenDot } from "@/components/session-import/imported-unseen-dot";
import { Badge } from "@/components/ui/badge";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useEpicPinLocalHomeSupported } from "@/hooks/epic/use-epic-pin-local-home-support";
import {
  closeOpenTooltips,
  StatusGlyphFocusContext,
  useStatusGlyphFocusHold,
} from "@/components/notifications/status-glyph-focus";
import { ROW_TARGET_SELECTOR } from "@/components/epics/use-history-list-keyboard-nav";
import { cn } from "@/lib/utils";
import { WorktreePrPills } from "@/components/worktree/worktree-pr-metadata";
import { worktreePrReferences } from "@/components/worktree/worktree-pr-metadata-model";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";

const ROW_TARGET_OWN_TOOLTIP_ATTRIBUTE = "data-history-row-target-own-tooltip";

export interface HistoryTaskRowProps {
  readonly item: HistoryItem;
  readonly selectionMode: boolean;
  readonly selectionDisabled: boolean;
  readonly selectedForDelete: boolean;
  readonly selectionControl: ReactNode;
  readonly renderInteractionTarget: (describedBy: string) => ReactNode;
  readonly renameEditor: ReactNode;
  readonly renameControl: ReactNode;
  readonly deleteControl: ReactNode;
  readonly sweepControl: ReactNode;
  readonly sweepMenuItem: ReactNode;
  readonly hasSweepControl: boolean;
  readonly contextMenuItems: ReactNode;
  readonly openInNewWindowControl: ReactNode;
  readonly onSetPinned: ((epicId: string, pinned: boolean) => void) | null;
  readonly isPinPending: boolean;
  readonly pinAlwaysVisible: boolean;
  readonly showOpenBadge: boolean;
  readonly isOpen: boolean;
  readonly worktrees: readonly WorktreeHostEntryV12[];
}

export function HistoryTaskRow(props: HistoryTaskRowProps): ReactNode {
  const statusDescriptionId = useId();
  const importedDescriptionId = useId();
  const rowDescribedBy = `${statusDescriptionId} ${importedDescriptionId}`;
  const pointerPressRef = useRef(false);
  const focusSessionRef = useRef(0);
  const [rowFocusSession, setRowFocusSession] = useState<number | null>(null);
  const forgetPointerPressRef = useRef<(() => void) | null>(null);
  const rememberPointerPress = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      forgetPointerPressRef.current?.();
      pointerPressRef.current = true;
      const ownerDocument = event.currentTarget.ownerDocument;
      const forgetPointerPress = () => {
        pointerPressRef.current = false;
        forgetPointerPressRef.current = null;
        ownerDocument.removeEventListener("pointerup", forgetPointerPress);
        ownerDocument.removeEventListener("pointercancel", forgetPointerPress);
      };
      forgetPointerPressRef.current = forgetPointerPress;
      ownerDocument.addEventListener("pointerup", forgetPointerPress);
      ownerDocument.addEventListener("pointercancel", forgetPointerPress);
    },
    [],
  );
  useEffect(
    () => () => {
      forgetPointerPressRef.current?.();
    },
    [],
  );
  const onRowFocus = useCallback((event: FocusEvent<HTMLDivElement>) => {
    const byPointer = pointerPressRef.current;
    pointerPressRef.current = false;
    const keyboardFocused =
      !byPointer &&
      event.target.matches(ROW_TARGET_SELECTOR) &&
      !event.target.hasAttribute(ROW_TARGET_OWN_TOOLTIP_ATTRIBUTE);
    focusSessionRef.current += 1;
    if (keyboardFocused) closeOpenTooltips(event.currentTarget.ownerDocument);
    setRowFocusSession(keyboardFocused ? focusSessionRef.current : null);
  }, []);
  const onRowBlur = useCallback(() => {
    setRowFocusSession(null);
  }, []);
  const rowCard = (
    <div
      data-testid="epics-list-row-card"
      data-selection-disabled={props.selectionDisabled ? "true" : undefined}
      onPointerDown={rememberPointerPress}
      onFocus={onRowFocus}
      onBlur={onRowBlur}
      className={historyRowCardClassName({
        selectionDisabled: props.selectionDisabled,
        selectedForDelete: props.selectedForDelete,
      })}
    >
      {props.renderInteractionTarget(rowDescribedBy)}
      <div className={historyRowContentClassName(props.hasSweepControl)}>
        <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden max-md:basis-full">
          <HistoryRowStatusSlot
            id={statusDescriptionId}
            rowFocusSession={rowFocusSession}
          >
            <HistoryRowLeadingIcon item={props.item} />
          </HistoryRowStatusSlot>
          {props.renameEditor ?? (
            <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
              <span className="truncate font-medium text-foreground">
                {historyItemDisplayTitle(props.item)}
              </span>
              <HistoryRowStatusSlot
                id={importedDescriptionId}
                rowFocusSession={null}
              >
                <ImportedUnseenDot epicId={props.item.epicId} />
              </HistoryRowStatusSlot>
              {props.showOpenBadge ? (
                <HistoryOpenBadge
                  epicId={props.item.epicId}
                  isOpen={props.isOpen}
                />
              ) : null}
              {props.onSetPinned === null ? null : (
                <HistoryPinControl
                  item={props.item}
                  isPending={props.isPinPending}
                  selectionMode={props.selectionMode}
                  alwaysVisible={props.pinAlwaysVisible}
                  onSetPinned={props.onSetPinned}
                />
              )}
              {props.renameControl}
            </span>
          )}
        </span>
        <HistoryRowTrailingMetadata
          epicId={props.item.epicId}
          selectionMode={props.selectionMode}
          updatedLabel={props.item.updatedLabel}
          worktrees={props.worktrees}
          provenance={historyRowProvenance(props.item)}
        />
      </div>
      {props.sweepControl}
      {props.deleteControl}
    </div>
  );
  return (
    <li
      data-testid="epics-list-row"
      data-pinned={props.item.isPinned}
      className="group/list-row flex items-stretch gap-1.5"
    >
      {props.selectionControl === null ? null : (
        <div className="flex w-5 shrink-0 items-center justify-center">
          {props.selectionControl}
        </div>
      )}
      {props.contextMenuItems === null &&
      props.openInNewWindowControl === null &&
      props.sweepMenuItem === null ? (
        rowCard
      ) : (
        <ContextMenu>
          <ContextMenuTrigger asChild>{rowCard}</ContextMenuTrigger>
          <ContextMenuContent
            onCloseAutoFocus={(event) => event.preventDefault()}
          >
            {props.contextMenuItems}
            {props.openInNewWindowControl}
            {props.sweepMenuItem}
          </ContextMenuContent>
        </ContextMenu>
      )}
    </li>
  );
}

function HistoryRowTrailingMetadata(props: {
  readonly epicId: string;
  readonly selectionMode: boolean;
  readonly updatedLabel: string;
  readonly worktrees: readonly WorktreeHostEntryV12[];
  readonly provenance: HistoryRowProvenance | null;
}): ReactNode {
  const hasPrPills =
    !props.selectionMode && worktreePrReferences(props.worktrees).length > 0;
  return (
    <span className="grid shrink-0 items-center justify-items-end text-ui-xs max-md:flex max-md:min-w-0 max-md:gap-2 max-md:pl-6">
      <span
        className={cn(
          "col-start-1 row-start-1 text-muted-foreground",
          hasPrPills &&
            "transition-opacity md:group-hover/list-row:opacity-0 md:group-focus-within/list-row:opacity-0",
        )}
      >
        updated {props.updatedLabel}
        {props.provenance === null ? null : (
          <span
            data-testid={`epics-list-row-coarse-provenance-label-${props.provenance}`}
            className={cn(
              "hidden pointer-coarse:inline",
              props.provenance === "preserved-orphan" && "text-destructive",
            )}
          >
            {" · "}
            {historyRowProvenanceLabel(props.provenance)}
          </span>
        )}
      </span>
      {hasPrPills ? (
        <WorktreePrPills
          worktrees={props.worktrees}
          detailOnHover
          maximumVisible={2}
          className="pointer-events-none col-start-1 row-start-1 max-w-[min(36vw,22rem)] overflow-hidden opacity-0 transition-opacity group-hover/list-row:pointer-events-auto group-hover/list-row:opacity-100 group-focus-within/list-row:pointer-events-auto group-focus-within/list-row:opacity-100 has-data-[state=open]:pointer-events-auto has-data-[state=open]:opacity-100 max-md:pointer-events-auto max-md:max-w-full max-md:opacity-100"
          testId={`task-history-prs-${props.epicId}`}
          openPrInApp={null}
        />
      ) : null}
    </span>
  );
}

function HistoryOpenBadge(props: {
  readonly epicId: string;
  readonly isOpen: boolean;
}): ReactNode {
  if (!props.isOpen) return null;
  return (
    <Badge
      variant="secondary"
      data-testid={`task-history-open-${props.epicId}`}
      className="h-4"
      size="sm"
    >
      Open
    </Badge>
  );
}

function HistoryPinControl(props: {
  readonly item: HistoryItem;
  readonly isPending: boolean;
  readonly selectionMode: boolean;
  readonly alwaysVisible: boolean;
  readonly onSetPinned: (epicId: string, pinned: boolean) => void;
}): ReactNode {
  const cloudAuthorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  const localHomePinSupported = useEpicPinLocalHomeSupported(null);
  if (props.selectionMode || props.item.taskType === "phase") return null;
  const displayTitle = historyItemDisplayTitle(props.item);
  const unavailableReason = historyPinUnavailableReason(
    props.item,
    cloudAuthorized,
    localHomePinSupported,
  );
  const pinUnavailable = unavailableReason !== null;
  const label = historyPinControlLabel({
    displayTitle,
    unavailableReason,
    isPinned: props.item.isPinned,
  });
  const unavailableTooltip =
    unavailableReason === null
      ? null
      : historyPinUnavailableTooltip(unavailableReason);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-pressed={props.item.isPinned}
          data-testid="epics-list-row-pin"
          data-local-home-pin-unavailable={pinUnavailable || undefined}
          aria-disabled={pinUnavailable || undefined}
          disabled={props.isPending}
          className={cn(
            "pointer-events-auto flex size-5 shrink-0 items-center justify-center rounded-sm outline-none transition-[color,opacity] hover:bg-foreground/5 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-wait",
            historyPinClassName({
              pinUnavailable,
              isPinned: props.item.isPinned,
              alwaysVisible: props.alwaysVisible,
            }),
          )}
          onClick={() => {
            if (pinUnavailable) return;
            props.onSetPinned(props.item.epicId, !props.item.isPinned);
          }}
        >
          <Pin
            className={cn("size-3.5", props.item.isPinned && "fill-current")}
          />
        </button>
      </TooltipTrigger>
      <TooltipContent>{unavailableTooltip ?? label}</TooltipContent>
    </Tooltip>
  );
}

function historyPinClassName(args: {
  readonly pinUnavailable: boolean;
  readonly isPinned: boolean;
  readonly alwaysVisible: boolean;
}): string {
  if (args.pinUnavailable) {
    return "cursor-default text-muted-foreground opacity-40";
  }
  if (args.isPinned) return "text-primary opacity-100 active:press-scrim";
  if (args.alwaysVisible) {
    return "text-muted-foreground opacity-100 active:press-scrim";
  }
  return "text-muted-foreground opacity-0 group-hover/list-row:opacity-100 group-focus-within/list-row:opacity-100 pointer-coarse:opacity-100 active:press-scrim";
}

function HistoryRowStatusSlot(props: {
  readonly id: string;
  readonly rowFocusSession: number | null;
  readonly children: ReactNode;
}): ReactNode {
  const focusHold = useStatusGlyphFocusHold(props.rowFocusSession);
  const forwardClickToRow = useCallback(
    (event: React.MouseEvent<HTMLSpanElement>) => {
      if (event.type === "auxclick" && event.button !== 1) return;
      const target = event.currentTarget
        .closest("li")
        ?.querySelector<HTMLElement>(ROW_TARGET_SELECTOR);
      if (target === null || target === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      target.dispatchEvent(
        new MouseEvent(event.type, {
          bubbles: true,
          cancelable: true,
          button: event.button,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
        }),
      );
    },
    [],
  );
  return (
    <StatusGlyphFocusContext.Provider value={focusHold}>
      <span
        id={props.id}
        role="presentation"
        className="pointer-events-auto inline-flex shrink-0 items-center empty:hidden"
        data-testid="epics-list-row-status-slot"
        onClick={forwardClickToRow}
        onAuxClick={forwardClickToRow}
      >
        {props.children}
      </span>
    </StatusGlyphFocusContext.Provider>
  );
}

function historyRowContentClassName(hasSweepControl: boolean): string {
  return cn(
    "pointer-events-none relative z-10 flex items-center justify-between gap-3 p-3 pr-12 text-ui-sm",
    "max-md:flex-wrap max-md:gap-y-1",
    hasSweepControl && "pr-20",
  );
}

function historyRowCardClassName(args: {
  readonly selectionDisabled: boolean;
  readonly selectedForDelete: boolean;
}): string {
  return cn(
    "group relative min-w-0 flex-1 rounded-md transition-colors hover:bg-accent/40 active:press-scrim pointer-coarse:touch-chrome",
    args.selectionDisabled && "opacity-50",
    args.selectedForDelete && "bg-accent/40 ring-1 ring-inset ring-primary/40",
  );
}
