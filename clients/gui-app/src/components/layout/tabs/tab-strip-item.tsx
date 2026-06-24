import {
  memo,
  useCallback,
  useMemo,
  useRef,
  type KeyboardEvent,
  type TouchEvent,
} from "react";
import { X } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, type Transition } from "motion/react";
import * as m from "motion/react-m";
import {
  useDraggable,
  useDroppable,
  type DraggableSyntheticListeners,
} from "@dnd-kit/core";
import {
  HEADER_TAB_DND_TYPE,
  HEADER_TAB_SLOT_DND_TYPE,
  getHeaderTabDragId,
  getHeaderTabSlotDropId,
  type HeaderTabDragData,
  type HeaderTabSlotDropData,
} from "@/components/layout/tabs/header-tab-dnd";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { DropLine } from "@/components/ui/drop-line";
import {
  useRegisteredEpicPermissionRole,
  useRegisteredEpicTitle,
  useRegisteredEpicTitleGenerating,
} from "@/lib/epic-selectors";
import { displayTitle } from "@/lib/display-title";
import { isEditablePermissionRole } from "@/lib/epic-collaborator-roles";
import { getOpenEpicRegistry } from "@/lib/registries/epic-session-registry";
import { getHostBindingSnapshot } from "@/lib/host/runtime";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { toastFromHostError } from "@/lib/host-error-toast";
import { toast } from "sonner";
import { useInlineRename } from "@/hooks/ui/use-inline-rename";
import { updateEpicTitleInCloudTaskCaches } from "@/lib/cloud-epic-tasks-query/cache";
import {
  useTabLeaderModifierForIndex,
  type LeaderModifier,
} from "@/providers/keybinding-context";
import { LeaderDigitBadge } from "@/components/ui/leader-digit-badge";
import {
  leaderDigitFor,
  leaderHint,
} from "@/components/ui/leader-digit-shortcuts";
import { mergeRefs } from "@/lib/merge-refs";
import { TabContextMenuContent } from "@/components/layout/tabs/tab-strip-context-menu";
import { tabResolveIntent } from "@/stores/tabs/registry";
import type { HeaderTabKind } from "@/stores/tabs/registry";
import type { HeaderTab, TabIcon } from "@/stores/tabs/types";
import { navigateToTabIntent } from "@/lib/tab-navigation";
import { EpicActivityStatusIcon } from "@/components/epics/epic-activity-status-icon";
import {
  useEpicActivityStatus,
  type EpicActivityStatus,
} from "@/hooks/epic/use-epic-activity-status";

const TAB_CLASS_BASE =
  "group/tab relative flex h-10 w-full min-w-0 items-center gap-2 pl-6 pr-4 text-ui-sm transition-[color,transform] duration-300 ease-spring";
const NO_DRAG_CLASS = "[-webkit-app-region:no-drag]";
const HEADER_TAB_LAYOUT_TRANSITION = {
  type: "spring",
  stiffness: 520,
  damping: 42,
  mass: 0.72,
} satisfies Transition;
const LONG_PRESS_CONTEXT_MENU_MS = 500;

interface TabItemProps {
  readonly tab: HeaderTab;
  readonly index: number;
  readonly isActive: boolean;
  readonly showSeparatorAfter: boolean;
  readonly showDropIndicatorBefore: boolean;
  readonly showDropIndicatorAfter: boolean;
  readonly onClose: (tab: HeaderTab) => void;
  readonly onCloseOtherTabs: (tab: HeaderTab) => void;
  readonly onDuplicateTab: (tab: HeaderTab) => void;
  readonly canCloseOtherTabs: boolean;
  readonly onOpenInNewWindow: (tab: HeaderTab) => void;
  readonly canOpenInNewWindow: boolean;
}

export const TabItem = memo(function TabItem(props: TabItemProps) {
  const {
    tab,
    index,
    isActive,
    showSeparatorAfter,
    showDropIndicatorBefore,
    showDropIndicatorAfter,
    onClose,
    onCloseOtherTabs,
    onDuplicateTab,
    canCloseOtherTabs,
    onOpenInNewWindow,
    canOpenInNewWindow,
  } = props;
  const {
    ref: dndRef,
    listeners,
    isDragging,
  } = useHeaderTabDnd(tab.kind, tab.id, index);
  const tabRef = useRef<HTMLDivElement | null>(null);
  const scrollActiveTabIntoView = useCallback(
    (element: HTMLDivElement | null) => {
      if (element === null || !isActive) return;
      element.scrollIntoView({ block: "nearest", inline: "nearest" });
    },
    [isActive],
  );
  const combinedRef = useMemo(
    () => mergeRefs<HTMLDivElement>(dndRef, tabRef, scrollActiveTabIntoView),
    [dndRef, scrollActiveTabIntoView],
  );
  const longPressTimerRef = useRef<number | null>(null);
  const modifier = useTabLeaderModifierForIndex(index);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const liveEpicTitle = useRegisteredEpicTitle(
    tab.kind === "epic" ? tab.epicId : null,
  );
  const titleGenerationPending = useRegisteredEpicTitleGenerating(
    tab.kind === "epic" ? tab.epicId : null,
  );
  const activityStatus = useEpicActivityStatus(
    tab.kind === "epic" ? tab.epicId : null,
  );
  const permissionRole = useRegisteredEpicPermissionRole(
    tab.kind === "epic" ? tab.epicId : null,
  );
  const canEditTitle =
    tab.kind === "epic" && isEditablePermissionRole(permissionRole);
  // Epic tabs can carry an empty name; render through `displayTitle` so it falls
  // back to "Untitled epic". Other kinds render their name verbatim.
  const resolvedTabName = liveEpicTitle ?? tab.name;
  const displayName =
    tab.kind === "epic"
      ? displayTitle(resolvedTabName, "epic")
      : resolvedTabName;
  const displayTab = useMemo(
    () =>
      resolvedTabName === tab.name
        ? tab
        : {
            ...tab,
            name: resolvedTabName,
          },
    [resolvedTabName, tab],
  );
  const commitEpicTitle = useCallback(
    (next: string) => {
      if (tab.kind !== "epic") return;
      const epicId = tab.epicId;
      const handle = getOpenEpicRegistry().peek(epicId);
      const previousTitle =
        handle?.store.getState().epic.title ?? resolvedTabName;
      // Optimistic local update for instant feedback; rolled back to the prior
      // title if the authoritative cloud rename can't be applied.
      handle?.store.getState().setEpicTitle(next);
      const rollback = () => {
        handle?.store.getState().setEpicTitle(previousTitle);
      };
      // The header strip is app-global and not guaranteed to sit inside a
      // HostRuntimeProvider, so reach the host client through the binding
      // snapshot rather than a render-time hook.
      const binding = getHostBindingSnapshot();
      if (binding === null) {
        rollback();
        toast.error("Couldn't reach the host to rename the epic.");
        return;
      }
      const hostId = binding.hostClient.getActiveHostId();
      const userId = binding.hostClient.getRequestContextUserId();
      void binding.hostClient
        .request("epic.updateTitle", {
          epicDelta: { id: epicId, title: next, updatedAt: Date.now() },
        })
        .then(
          () => {
            if (userId === null) return;
            updateEpicTitleInCloudTaskCaches(
              queryClient,
              { hostId, userId },
              epicId,
              next,
            );
          },
          (error: unknown) => {
            rollback();
            if (error instanceof HostRpcError) {
              toastFromHostError(error, "Couldn't rename epic.");
            } else {
              toast.error("Couldn't rename epic.");
            }
          },
        );
    },
    [resolvedTabName, queryClient, tab],
  );
  const rename = useInlineRename({
    // Bind to the RAW title, not `displayName` - editing must never seed the
    // "Untitled epic" fallback into the input and persist it as a real title.
    value: resolvedTabName,
    canEdit: canEditTitle,
    onCommit: commitEpicTitle,
  });

  const activateTab = useCallback(() => {
    if (rename.isEditing) return;
    navigateToTabIntent(navigate, tabResolveIntent(tab));
  }, [navigate, rename.isEditing, tab]);
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (rename.isEditing) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      activateTab();
    },
    [activateTab, rename.isEditing],
  );
  const cancelLongPress = useCallback(() => {
    if (longPressTimerRef.current === null) return;
    window.clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = null;
  }, []);
  const handleTouchStart = useCallback(
    (event: TouchEvent<HTMLDivElement>) => {
      cancelLongPress();
      if (event.touches.length !== 1) return;
      const touch = event.touches[0];
      longPressTimerRef.current = window.setTimeout(() => {
        longPressTimerRef.current = null;
        tabRef.current?.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: touch.clientX,
            clientY: touch.clientY,
          }),
        );
      }, LONG_PRESS_CONTEXT_MENU_MS);
    },
    [cancelLongPress],
  );

  const leaderBadge: LeaderBadge | null =
    modifier === null
      ? null
      : {
          modifier,
          index,
          hint: leaderHint(index, "to switch to", displayName),
        };
  return (
    <ContextMenu>
      <HeaderTabMotionFrame isDragging={isDragging}>
        <ContextMenuTrigger asChild>
          <div
            ref={combinedRef}
            {...listeners}
            role="tab"
            tabIndex={0}
            aria-selected={isActive}
            data-testid={`tab-${tab.kind}-${tab.id}`}
            data-tab-kind={tab.kind}
            data-tab-index={index}
            onClick={activateTab}
            onKeyDown={handleKeyDown}
            onTouchCancel={cancelLongPress}
            onTouchEnd={cancelLongPress}
            onTouchMove={cancelLongPress}
            onTouchStart={handleTouchStart}
            className={cn(
              TAB_CLASS_BASE,
              tabStateClass(isActive),
              NO_DRAG_CLASS,
              "cursor-pointer",
            )}
          >
            <HeaderTabDropIndicator
              visible={showDropIndicatorBefore}
              side="left"
            />
            <TabChrome isActive={isActive} />
            <span className="relative flex min-w-0 flex-1 items-center justify-center gap-1.5 outline-none">
              <TabLeadingIcon
                icon={tab.icon}
                titleGenerationPending={titleGenerationPending}
                activityStatus={activityStatus}
                tabId={tab.id}
              />
              {rename.isEditing ? (
                <input
                  {...rename.inputProps}
                  aria-label="Edit epic title"
                  data-testid={`tab-title-input-${tab.kind}-${tab.id}`}
                  className="min-w-0 flex-1 rounded-sm border border-border bg-background px-1 text-center text-ui-sm text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring [-webkit-app-region:no-drag]"
                />
              ) : (
                <>
                  <span className="min-w-0 flex-1 text-center">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span
                          data-testid={`tab-title-${tab.kind}-${tab.id}`}
                          className="inline-block max-w-full truncate align-bottom"
                        >
                          {displayName}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>{displayName}</TooltipContent>
                    </Tooltip>
                  </span>
                  <TabTrailingSlot
                    label={`Close ${displayName}`}
                    testId={`tab-close-${tab.kind}-${tab.id}`}
                    onClose={() => onClose(displayTab)}
                    leaderBadge={leaderBadge}
                    active={isActive}
                  />
                </>
              )}
            </span>
            <HeaderTabSeparator visible={showSeparatorAfter} />
            <HeaderTabDropIndicator
              visible={showDropIndicatorAfter}
              side="right"
            />
          </div>
        </ContextMenuTrigger>
      </HeaderTabMotionFrame>
      <TabContextMenuContent
        tab={displayTab}
        canCloseOtherTabs={canCloseOtherTabs}
        canOpenInNewWindow={canOpenInNewWindow}
        canEditTitle={canEditTitle}
        onCloseOtherTabs={onCloseOtherTabs}
        onDuplicateTab={onDuplicateTab}
        onOpenInNewWindow={onOpenInNewWindow}
        onEditTitle={rename.startEditing}
      />
    </ContextMenu>
  );
});

// Re-export for backwards compatibility with tests
TabItem.displayName = "TabItem";

interface UseHeaderTabDndReturn {
  readonly ref: (element: HTMLElement | null) => void;
  readonly listeners: DraggableSyntheticListeners;
  readonly isDragging: boolean;
}

function useHeaderTabDnd(
  tabKind: HeaderTabKind,
  tabId: string,
  index: number,
): UseHeaderTabDndReturn {
  const dragData = useMemo<HeaderTabDragData>(
    () => ({ kind: HEADER_TAB_DND_TYPE, tabKind, tabId, index }),
    [index, tabId, tabKind],
  );
  const {
    listeners,
    setNodeRef: dragRef,
    isDragging,
  } = useDraggable({
    id: getHeaderTabDragId(tabKind, tabId),
    data: dragData,
  });
  const dropData = useMemo<HeaderTabSlotDropData>(
    () => ({ kind: HEADER_TAB_SLOT_DND_TYPE, index, isTrailing: false }),
    [index],
  );
  const { setNodeRef: dropRef } = useDroppable({
    id: getHeaderTabSlotDropId(tabKind, tabId),
    data: dropData,
  });
  const ref = useMemo(
    () => mergeRefs<HTMLElement>(dragRef, dropRef),
    [dragRef, dropRef],
  );
  return { ref, listeners, isDragging };
}

function HeaderTabDropIndicator(props: {
  readonly visible: boolean;
  readonly side: "left" | "right";
}) {
  return (
    <AnimatePresence initial={false}>
      {props.visible ? (
        <m.span
          aria-hidden
          data-testid="tab-drop-indicator"
          initial={{ opacity: 0, scaleY: 0.45 }}
          animate={{ opacity: 1, scaleY: 1 }}
          exit={{ opacity: 0, scaleY: 0.45 }}
          transition={{ duration: 0.12, ease: "easeOut" }}
          className={cn(
            "absolute inset-y-1 z-20 origin-center",
            props.side === "left" ? "left-2" : "right-2",
          )}
        >
          <DropLine
            orientation="vertical"
            glow={false}
            className="h-full"
            testId={undefined}
          />
        </m.span>
      ) : null}
    </AnimatePresence>
  );
}

function TabLeadingIcon(props: {
  readonly icon: TabIcon | null;
  readonly titleGenerationPending: boolean;
  readonly activityStatus: EpicActivityStatus;
  readonly tabId: string;
}) {
  if (props.titleGenerationPending) {
    return (
      <AgentSpinningDots
        className="size-3.5 text-muted-foreground"
        testId={`header-tab-title-generating-${props.tabId}`}
        variant="dots2"
      />
    );
  }
  if (props.activityStatus !== "idle") {
    return (
      <EpicActivityStatusIcon
        status={props.activityStatus}
        subjectId={props.tabId}
        testIdPrefix="header-tab"
        className="text-muted-foreground"
      />
    );
  }
  if (props.icon === null) return null;
  const Icon = props.icon;
  return <Icon className="size-3.5 shrink-0" />;
}

function HeaderTabMotionFrame(props: {
  readonly isDragging: boolean;
  readonly children: React.ReactNode;
}) {
  return (
    <m.div
      layout="position"
      initial={false}
      animate={{
        opacity: props.isDragging ? 0.36 : 1,
        scale: props.isDragging ? 0.96 : 1,
      }}
      transition={HEADER_TAB_LAYOUT_TRANSITION}
      className="relative flex min-w-[120px] flex-1 basis-0 items-end"
    >
      {props.children}
    </m.div>
  );
}

function tabStateClass(isActive: boolean): string {
  return isActive
    ? "z-10 font-medium text-foreground"
    : "text-muted-foreground hover:text-foreground";
}

interface LeaderBadge {
  modifier: LeaderModifier;
  index: number;
  hint: string;
}

interface TabTrailingSlotProps {
  label: string;
  testId: string;
  onClose: () => void;
  leaderBadge: LeaderBadge | null;
  active: boolean;
}

/**
 * Inline trailing slot that defaults to zero width so the tab label
 * can occupy the full available space. The slot expands only as needed
 * - and the label truncates to make room - only when one of:
 * - the user hovers the tab (reveals the close button)
 * - keyboard focus enters the tab (reveals the close button)
 * - the leader modifier is held (renders the digit badge)
 *
 * The collapsed close button stays mounted (just zero-width and
 * hidden) so the same `<Button>` keeps its focus + click behavior
 * across the hover transition.
 */
function TabTrailingSlot(props: TabTrailingSlotProps) {
  const { label, testId, onClose, leaderBadge, active } = props;
  const showLeader = leaderBadge !== null;
  return (
    <span
      className={cn(
        "z-20 flex shrink-0 items-center justify-center overflow-hidden transition-[width,opacity] duration-150 ease-spring [-webkit-app-region:no-drag]",
        showLeader
          ? "w-fit opacity-100"
          : "w-0 opacity-0 group-hover/tab:w-5 group-hover/tab:opacity-100 group-focus-within/tab:w-5 group-focus-within/tab:opacity-100",
      )}
    >
      <AnimatePresence initial={false}>
        {leaderBadge ? (
          <LeaderDigitBadge
            key={`${leaderBadge.modifier}:${leaderBadge.index}`}
            index={leaderBadge.index}
            modifier={leaderBadge.modifier}
            ariaLabel={leaderBadge.hint}
            testId={`tab-digit-${leaderDigitFor(leaderBadge.index)}`}
            className={undefined}
          />
        ) : null}
      </AnimatePresence>
      {leaderBadge === null ? (
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={label}
          data-testid={testId}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }}
          className={cn(
            "pointer-events-none size-5 text-muted-foreground hover:text-foreground group-focus-within/tab:pointer-events-auto group-hover/tab:pointer-events-auto [-webkit-app-region:no-drag]",
            active &&
              "text-foreground/70 hover:bg-accent hover:text-accent-foreground",
          )}
        >
          <X className="size-3" />
        </Button>
      ) : null}
    </span>
  );
}

function HeaderTabSeparator(props: { readonly visible: boolean }) {
  if (!props.visible) return null;
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute right-0 top-1/2 z-10 h-5 w-px -translate-y-1/2 bg-border/80"
    />
  );
}

function TabChrome(props: { readonly isActive: boolean }) {
  if (!props.isActive) {
    return null;
  }

  return (
    <TabChromeBackground
      fill="var(--color-background)"
      borderColor="var(--color-border)"
      coversBaseline
      className="transition-opacity duration-300 ease-spring"
    />
  );
}

interface TabChromeBackgroundProps {
  fill: string;
  borderColor: string | undefined;
  coversBaseline: boolean;
  className?: string;
}

function TabChromeBackground({
  fill,
  borderColor,
  coversBaseline,
  className,
}: TabChromeBackgroundProps) {
  return (
    <span
      aria-hidden
      className={cn("pointer-events-none absolute inset-0 flex", className)}
    >
      <TabCap side="left" fill={fill} borderColor={borderColor} />
      <span
        className={cn("-mx-px h-full flex-1", borderColor && "border-t")}
        style={{ backgroundColor: fill, borderTopColor: borderColor }}
      />
      <TabCap side="right" fill={fill} borderColor={borderColor} />
      {coversBaseline ? (
        <span
          aria-hidden
          className="absolute inset-x-0 -bottom-px h-px"
          style={{ backgroundColor: fill }}
        />
      ) : null}
    </span>
  );
}

function TabCap({
  side,
  fill,
  borderColor,
}: {
  side: "left" | "right";
  fill: string;
  borderColor: string | undefined;
}) {
  const d =
    side === "left"
      ? "M 20 0 L 15 0 C 10.6 0 8 2.8 8 7 L 8 32 C 8 36.8 4.8 40 0 40 L 20 40 Z"
      : "M 0 0 L 5 0 C 9.4 0 12 2.8 12 7 L 12 32 C 12 36.8 15.2 40 20 40 L 0 40 Z";
  const outline =
    side === "left"
      ? "M 0 40 C 4.8 40 8 36.8 8 32 L 8 7 C 8 2.8 10.6 0 15 0 L 20 0"
      : "M 0 0 L 5 0 C 9.4 0 12 2.8 12 7 L 12 32 C 12 36.8 15.2 40 20 40";
  return (
    <svg
      viewBox="0 0 20 40"
      preserveAspectRatio="none"
      className="h-full w-5 shrink-0"
    >
      <path d={d} fill={fill} />
      {borderColor ? (
        <path
          d={outline}
          fill="none"
          stroke={borderColor}
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
    </svg>
  );
}
