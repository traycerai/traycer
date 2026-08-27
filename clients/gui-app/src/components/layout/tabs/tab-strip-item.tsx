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
import { AnimatePresence } from "motion/react";
import { useHeaderTabDisplacement } from "./use-header-tab-displacement";
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
import { useDragSourceDisabled } from "@/components/epic-canvas/dnd/use-drag-source-disabled";
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
import { isEditableRole } from "@/lib/epic-permissions";
import { getOpenEpicRegistry } from "@/lib/registries/epic-session-registry";
import { getAppHostClientSnapshot } from "@/lib/host/runtime";
import { buildTransientHostClient } from "@/hooks/host/use-host-client-for";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { toastFromHostError } from "@/lib/host-error-toast";
import { useInlineRename } from "@/hooks/ui/use-inline-rename";
import { updateEpicTitleInCloudTaskCaches } from "@/lib/cloud-epic-tasks-query/cache";
import { useTabLeaderModifierForIndex } from "@/providers/keybinding-context";
import { LeaderDigitBadge } from "@/components/ui/leader-digit-badge";
import {
  leaderDigitFor,
  leaderHint,
} from "@/components/ui/leader-digit-shortcuts";
import { useTopLevelStripPairPreview } from "@/components/epic-canvas/dnd/dnd-store";
import {
  useHeaderTabDisplacementTransition,
  TAB_CLASS_BASE,
} from "@/components/layout/tabs/tab-chrome-tokens";
import { mergeRefs } from "@/lib/merge-refs";
import { TabContextMenuContent } from "@/components/layout/tabs/tab-strip-context-menu";
import type { TabSplitCommandId } from "@/stores/tabs/tab-split-commands";
import { tabResolveIntent } from "@/stores/tabs/registry";
import type { HeaderTabKind } from "@/stores/tabs/registry";
import type { HeaderTab, TabIcon } from "@/stores/tabs/types";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { navigateToTabIntent } from "@/lib/tab-navigation";
import { NotificationIndicatorIcon } from "@/components/notifications/notification-indicator-icon";
import { useSurfaceNotificationIndicatorState } from "@/components/notifications/notification-indicator-context";
import {
  useEpicActivityStatus,
  type EpicActivityStatus,
} from "@/hooks/epic/use-epic-activity-status";
import { reportableErrorToast } from "@/lib/reportable-error-toast";

const NO_DRAG_CLASS = "[-webkit-app-region:no-drag]";
const LONG_PRESS_CONTEXT_MENU_MS = 500;

interface TabItemProps {
  readonly tab: HeaderTab;
  readonly index: number;
  /** `null` makes this a member control inside a group-level reorder frame. */
  readonly dnd: HeaderTabDndConfig | null;
  /**
   * `"own"` draws the tab's own chrome silhouette. `"member"` is for the halves
   * of a split group: the group draws one shared silhouette around both, so a
   * member drawing its own would nest a second outline inside it. Members get a
   * flat focus wash and tighter padding instead.
   */
  readonly chrome: "own" | "member";
  readonly includeMotionFrame: boolean;
  readonly offsetX: number;
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
  readonly onSplitCommand: (id: TabSplitCommandId, tab: HeaderTab) => void;
  readonly taskPinned: boolean | null;
  readonly isTaskPinPending: boolean;
  readonly onSetTaskPinned: (
    epicId: string,
    pinned: boolean,
    displayName: string,
  ) => void;
}

export interface HeaderTabDndConfig {
  readonly stripItemId: string;
  readonly index: number;
  readonly isDropSlot: boolean;
}

/**
 * The client an epic rename should be sent on.
 *
 * `null` host - no live session for that epic - keeps the app-wide client,
 * which is what this surface used before tabs carried a host at all. A NAMED
 * host resolves that host's own requester, and returning `null` when it cannot
 * be built is deliberate: the caller reports a failure rather than falling
 * back, because "rename the epic on the machine that holds it" and "rename it
 * on whichever machine this window happens to be pointed at" are different
 * requests, and silently substituting the second is how a rename lands against
 * a host that never had the epic.
 *
 * Built through `buildTransientHostClient` - the same builder every other
 * explicit-host consumer uses - rather than a second construction path.
 */
function epicRenameClient(
  hostId: string | null,
): HostClient<HostRpcRegistry> | null {
  const appClient = getAppHostClientSnapshot();
  if (appClient === null) return null;
  if (hostId === null || hostId === appClient.getActiveHostId()) {
    return appClient;
  }
  const entry = appClient.resolveHostById(hostId);
  if (entry === null) return null;
  return buildTransientHostClient(appClient, entry);
}

export const TabItem = memo(function TabItem(props: TabItemProps) {
  const {
    tab,
    index,
    dnd,
    chrome,
    includeMotionFrame,
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
    onSplitCommand,
    taskPinned,
    isTaskPinPending,
    onSetTaskPinned,
  } = props;
  const {
    ref: dndRef,
    listeners,
    isDragging,
  } = useHeaderTabDnd(tab.kind, tab.id, dnd);
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
  const canEditTitle = tab.kind === "epic" && isEditableRole(permissionRole);
  const canClose = tab.kind !== "epic" || tab.canClose;
  // Epic tabs can carry an empty name; render through `displayTitle` so it falls
  // back to "Untitled task". Other kinds render their name verbatim.
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
      const tabHostId = tab.hostId;
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
      // HostRuntimeProvider, so reach the host client through the snapshot
      // rather than a render-time hook. It is the app-wide client, already
      // pinned to the effective host: this rename used to be issued on the
      // SPINE, which answered from the active slot, so the call landed on
      // whichever host was bound at the instant it was dispatched. Post-P4.2
      // the client addresses the host it resolved, and `hostId` below is that
      // same resolution rather than a second, independently-timed read.
      //
      // HOST-SCOPED where the tab knows its host. An epic served by a session
      // on host B was renamed through the app-wide client - host A - purely
      // because the strip had no way to know about B. `tab.hostId` is that
      // session's own answer projected onto the tab, so the rename now goes
      // where the epic actually lives. `null` (no live session) keeps the
      // app-wide client, which is all this surface ever had.
      const client = epicRenameClient(tabHostId);
      if (client === null) {
        rollback();
        reportableErrorToast(
          "Couldn't reach the host to rename the epic.",
          undefined,
          {
            title: "Could not rename Epic",
            message: "The host was unavailable.",
            code: null,
            source: "Epic tabs",
          },
        );
        return;
      }
      const hostId = client.getActiveHostId();
      const userId = client.getRequestContextUserId();
      void client
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
              reportableErrorToast("Couldn't rename epic.", undefined, {
                title: "Could not rename Epic",
                message: null,
                code: null,
                source: "Epic tabs",
              });
            }
          },
        );
    },
    [resolvedTabName, queryClient, tab],
  );
  const rename = useInlineRename({
    // Bind to the RAW title, not `displayName` - editing must never seed the
    // "Untitled task" fallback into the input and persist it as a real title.
    value: resolvedTabName,
    canEdit: canEditTitle,
    onCommit: commitEpicTitle,
  });

  const activateTab = useCallback(() => {
    if (rename.isEditing) return;
    navigateToTabIntent(navigate, tabResolveIntent(tab), undefined);
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
  const handleSetTaskPinned = useCallback(
    (pinned: boolean) => {
      if (tab.kind !== "epic") return;
      onSetTaskPinned(tab.epicId, pinned, displayName);
    },
    [displayName, onSetTaskPinned, tab],
  );

  const leaderBadge: LeaderBadge | null =
    modifier === null
      ? null
      : {
          modifier,
          index,
          hint: leaderHint(leaderDigitFor(index), "to switch to", displayName),
        };
  const control = (
    <ContextMenu>
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
            // A split half shares the group's silhouette and only has half the
            // width, so it trades the tab's generous side padding for enough
            // room to still show an icon plus a readable title.
            chrome === "member" && cn("gap-1", isActive ? "px-5" : "px-1.5"),
            tabStateClass(isActive),
            NO_DRAG_CLASS,
            "cursor-pointer",
          )}
        >
          <HeaderTabDropIndicator
            visible={showDropIndicatorBefore}
            side="left"
          />
          {chrome === "own" ? (
            <TabChrome isActive={isActive} />
          ) : (
            <SplitMemberChrome focused={isActive} />
          )}
          <StripPairPreview tabKind={tab.kind} tabId={tab.id} />
          <span className="relative z-20 flex min-w-0 flex-1 items-center justify-center gap-1.5 outline-none">
            <TabLeadingIcon
              icon={tab.icon}
              titleGenerationPending={titleGenerationPending}
              activityStatus={activityStatus}
              tabId={tab.id}
              epicId={tab.kind === "epic" ? tab.epicId : null}
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
                  disabled={!canClose}
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
      <TabContextMenuContent
        tab={displayTab}
        canCloseOtherTabs={canCloseOtherTabs}
        canOpenInNewWindow={canOpenInNewWindow}
        canEditTitle={canEditTitle}
        taskPinned={taskPinned}
        isTaskPinPending={isTaskPinPending}
        onCloseOtherTabs={onCloseOtherTabs}
        onDuplicateTab={onDuplicateTab}
        onOpenInNewWindow={onOpenInNewWindow}
        onSplitCommand={onSplitCommand}
        onEditTitle={rename.startEditing}
        onSetTaskPinned={handleSetTaskPinned}
      />
    </ContextMenu>
  );
  if (!includeMotionFrame) return control;
  return (
    <HeaderTabMotionFrame
      isDragging={isDragging}
      offsetX={props.offsetX}
      dnd={dnd}
    >
      {control}
    </HeaderTabMotionFrame>
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
  config: HeaderTabDndConfig | null,
): UseHeaderTabDndReturn {
  const dragData = useMemo<HeaderTabDragData>(
    () => ({
      kind: HEADER_TAB_DND_TYPE,
      stripItemId: config?.stripItemId ?? `member:${tabKind}:${tabId}`,
      tabKind,
      tabId,
      index: config?.index ?? 0,
    }),
    [config, tabId, tabKind],
  );
  // A `tab:` strip item is already unique per tab, so it keys on the tab id
  // alone. A split member shares its tab id with nothing but must stay distinct
  // per half, so it keys on `<splitId>:<tabId>`; an unconfigured (undraggable)
  // item falls back to the same shape under `member`.
  const stripItemId = config?.stripItemId ?? "member";
  const dragKey = stripItemId.startsWith("tab:")
    ? tabId
    : `${stripItemId}:${tabId}`;
  const dragDisabled = useDragSourceDisabled();
  const {
    listeners,
    setNodeRef: dragRef,
    isDragging,
  } = useDraggable({
    id: getHeaderTabDragId(tabKind, dragKey),
    data: dragData,
    disabled: config === null || dragDisabled,
  });
  const dropData = useMemo<HeaderTabSlotDropData>(
    () => ({
      kind: HEADER_TAB_SLOT_DND_TYPE,
      index: config?.index ?? 0,
      isTrailing: false,
    }),
    [config],
  );
  const { setNodeRef: dropRef } = useDroppable({
    id: getHeaderTabSlotDropId(
      tabKind,
      `${config?.stripItemId ?? "member"}:${tabId}`,
    ),
    data: dropData,
    // The source stays mounted as a full-width layout placeholder while the
    // overlay follows the pointer. It must not remain a collision target: once
    // provisional order moves that placeholder under the pointer it would
    // steal `over` from the neighbour whose center actually opened the slot.
    disabled: config === null || !config.isDropSlot || isDragging,
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
  // No AnimatePresence: its exit animation keeps the OLD indicator mounted
  // while the new one enters, so the strip shows two landing positions at once
  // for the length of the exit (~110ms measured). A drop indicator states one
  // destination, so it unmounts immediately and only its entry animates.
  if (!props.visible) return null;
  return (
    <m.span
      aria-hidden
      data-testid="tab-drop-indicator"
      initial={{ opacity: 0, scaleY: 0.45 }}
      animate={{ opacity: 1, scaleY: 1 }}
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
  );
}

function TabLeadingIcon(props: {
  readonly icon: TabIcon | null;
  readonly titleGenerationPending: boolean;
  readonly activityStatus: EpicActivityStatus;
  readonly tabId: string;
  readonly epicId: string | null;
}) {
  const indicatorState = useSurfaceNotificationIndicatorState(
    { epicId: props.epicId ?? props.tabId },
    null,
  );
  let defaultIcon: React.ReactNode = null;
  if (props.titleGenerationPending) {
    defaultIcon = (
      <AgentSpinningDots
        className="size-3.5 text-muted-foreground"
        testId={`header-tab-title-generating-${props.tabId}`}
        variant="dots2"
      />
    );
  } else if (props.icon !== null) {
    const Icon = props.icon;
    defaultIcon = <Icon className="size-3.5 shrink-0" />;
  }
  return (
    <NotificationIndicatorIcon
      state={indicatorState}
      running={props.activityStatus === "idle" ? false : props.activityStatus}
      subjectId={props.tabId}
      testIdPrefix="header-tab"
      className="text-muted-foreground"
      style={undefined}
      runningTitle="Task activity in progress"
      defaultIcon={defaultIcon}
      statusPresentation="message"
      agentSurface="gui"
    />
  );
}

function HeaderTabMotionFrame(props: {
  readonly isDragging: boolean;
  readonly offsetX: number;
  /** Drag config; its `stripItemId` is the drag model's measurement anchor. */
  readonly dnd: HeaderTabDndConfig | null;
  readonly children: React.ReactNode;
}) {
  const transition = useHeaderTabDisplacementTransition();
  const frameRef = useRef<HTMLDivElement | null>(null);
  const x = useHeaderTabDisplacement({
    nodeRef: frameRef,
    offsetX: props.offsetX,
    transition,
  });

  return (
    <m.div
      ref={frameRef}
      initial={false}
      animate={{ opacity: props.isDragging ? 0 : 1 }}
      style={{ x }}
      // Explicit x from the drag model - deliberately NOT `layout="position"`
      // plus CSS `order`. That pairing strands a translateX when the item set
      // changes under an in-flight projection; binding x to state makes the
      // class unrepresentable rather than merely currently unreachable.
      //
      // Position springs, opacity does not: the dragged tab's source frame must
      // become invisible on the same frame the overlay is painted, or the strip
      // briefly shows two copies of one tab.
      transition={transition}
      data-strip-item-id={props.dnd?.stripItemId}
      data-strip-item-mergeable="true"
      // Keep the 14rem cap in sync with TAB_WIDTH_CAP_PX in the desktop
      // resolution harness.
      className="relative flex w-56 min-w-[120px] max-w-56 flex-[1_1_14rem] items-end [container-type:inline-size]"
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
  modifier: "alt";
  index: number;
  hint: string;
}

interface TabTrailingSlotProps {
  label: string;
  testId: string;
  onClose: () => void;
  leaderBadge: LeaderBadge | null;
  active: boolean;
  disabled: boolean;
}

/**
 * Inline trailing slot that defaults to zero width so compact tabs stay
 * icon-first. A container query reveals the close button only after the tab is
 * wide enough to spare the room, and only when one of:
 * - the user hovers a non-compact tab
 * - keyboard focus enters a non-compact tab
 * - the leader modifier is held (renders the digit badge)
 *
 * The collapsed close button stays mounted (just zero-width and
 * hidden) so the same `<Button>` keeps its focus + click behavior
 * across the hover transition.
 */
function TabTrailingSlot(props: TabTrailingSlotProps) {
  const { label, testId, onClose, leaderBadge, active, disabled } = props;
  const showLeader = leaderBadge !== null;
  return (
    <span
      className={cn(
        "z-20 flex shrink-0 items-center justify-center overflow-hidden transition-[width,opacity] duration-150 ease-spring [-webkit-app-region:no-drag]",
        showLeader ? "w-fit opacity-100" : "header-tab-trailing-slot",
      )}
    >
      <AnimatePresence initial={false}>
        {leaderBadge ? (
          <LeaderDigitBadge
            key={`${leaderBadge.modifier}:${leaderBadge.index}`}
            digit={leaderDigitFor(leaderBadge.index)}
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
          disabled={disabled}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }}
          className={cn(
            "header-tab-close-button size-5 text-muted-foreground hover:text-foreground [-webkit-app-region:no-drag]",
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

/**
 * The hairline between two adjacent, non-active strip items. Exported because a
 * split group is a strip item too and needs the identical rule at its own right
 * edge - see `SplitTabItem`.
 */
export function HeaderTabSeparator(props: { readonly visible: boolean }) {
  if (!props.visible) return null;
  return (
    <span
      aria-hidden
      // Shared id, disambiguated by scoping the query to the owning strip item
      // (`tab-<kind>-<id>` or `split-tab-group-<id>`).
      data-testid="header-tab-separator"
      className="pointer-events-none absolute right-0 top-1/2 z-10 h-5 w-px -translate-y-1/2 bg-border/80"
    />
  );
}

export function TabChrome(props: { readonly isActive: boolean }) {
  if (!props.isActive) {
    return (
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-2 inset-y-1 rounded-md bg-accent/45 opacity-0 transition-opacity duration-150 ease-out group-focus-visible/tab:opacity-100 group-has-[:focus-visible]/tab:opacity-100 group-hover/tab:opacity-100"
      />
    );
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

/**
 * Shown on the tab a pair-into-split drop would combine with, once its dwell
 * has fired. The two panes mirror the content-pane edge-split preview so both
 * routes into a split announce the same outcome.
 */
function StripPairPreview(props: {
  readonly tabKind: HeaderTabKind;
  readonly tabId: string;
}) {
  const previewing = useTopLevelStripPairPreview(props.tabKind, props.tabId);
  if (!previewing) return null;
  return (
    <span
      aria-hidden
      data-testid={`tab-strip-pair-preview-${props.tabKind}-${props.tabId}`}
      className="pointer-events-none absolute inset-x-1 inset-y-1 z-30 grid grid-cols-2 gap-px overflow-hidden rounded-sm bg-primary/15 ring-2 ring-primary"
    >
      <span className="bg-primary/10" />
      <span className="bg-primary/25" />
    </span>
  );
}

/**
 * Selection treatment for one member of a split group. The focused member uses
 * the same raised silhouette as an ordinary selected tab; group membership is
 * communicated independently by the split group's accent underline.
 */
export function SplitMemberChrome(props: { readonly focused: boolean }) {
  if (props.focused) {
    return (
      <TabChromeBackground
        fill="var(--color-background)"
        borderColor="var(--color-primary)"
        coversBaseline
      />
    );
  }

  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-x-px inset-y-1 rounded-sm transition-colors duration-200 ease-out group-hover/tab:bg-accent/20"
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
        data-testid="tab-chrome-center"
        className={cn("-mx-px h-full flex-1", borderColor && "border-t")}
        style={{ backgroundColor: fill, borderTopColor: borderColor }}
      />
      <TabCap side="right" fill={fill} borderColor={borderColor} />
      {coversBaseline ? (
        <span
          aria-hidden
          data-testid="tab-baseline-cover"
          className="absolute inset-x-0 bottom-0 z-0 h-px"
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
  // SVG strokes are centered on their path. Inset the top edge by half the
  // stroke width so it occupies the same inside pixel row as the center's CSS
  // border; placing it at y=0 clips the outer half and makes the center look
  // like a second line at display scaling.
  const outline =
    side === "left"
      ? "M -2 39.5 L 0 39.5 C 4.8 39.5 8 36.8 8 32 L 8 7 C 8 2.8 10.6 0.5 15 0.5 L 20 0.5"
      : "M 0 0.5 L 5 0.5 C 9.4 0.5 12 2.8 12 7 L 12 32 C 12 36.8 15.2 39.5 20 39.5 L 22 39.5";
  return (
    <svg
      data-testid={`tab-cap-${side}`}
      viewBox="0 0 20 40"
      preserveAspectRatio="none"
      className="relative z-10 h-full w-5 shrink-0 overflow-visible"
    >
      <path d={d} fill={fill} />
      {borderColor ? (
        <path
          data-testid={`tab-cap-outline-${side}`}
          d={outline}
          fill="none"
          stroke={borderColor}
          strokeWidth="1"
          strokeLinecap="square"
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
    </svg>
  );
}
