import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import {
  FileDiff,
  FilePlus,
  GitPullRequest,
  Lock,
  SplitSquareHorizontal,
  SplitSquareVertical,
  Trash2,
  X,
} from "lucide-react";
import { AnimatePresence, LayoutGroup } from "motion/react";
import * as m from "motion/react-m";
import { mergeRefs } from "@/lib/merge-refs";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { DropLine } from "@/components/ui/drop-line";
import { Kbd } from "@/components/ui/kbd";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  useEpicTabDisplayTitle,
  useEpicLiveArtifactTitleGenerating,
  useRegisteredEpicNodeArchived,
} from "@/lib/epic-selectors";
import {
  useInlineRename,
  type InlineRenameInputProps,
} from "@/hooks/ui/use-inline-rename";
import {
  ARTIFACT_TAB_DND_TYPE,
  getArtifactTabDragId,
  getArtifactTabDropId,
  getArtifactTabStripEndDropId,
  type EpicCanvasArtifactTabDragData,
  type EpicCanvasDropTargetData,
} from "@/components/epic-canvas/dnd/dnd";
import { useTabStripDropIndex } from "@/components/epic-canvas/dnd/dnd-store";
import type {
  CommGraphTileRef,
  DeletedArtifactsTileRef,
  EpicCanvasTileRef,
  EpicTerminalRef,
  SplitDirection,
} from "@/stores/epics/canvas/types";
import {
  isBlankTileRef,
  isPublishedChatTileRef,
  isDiffTileRef,
  isGitDiffTileRef,
  isManagedCommandOutputTileRef,
  isOpenableEpicNodeKind,
  isPrDetailTileRef,
  isPrDiffTileRef,
} from "@/stores/epics/canvas/types";
import { CommGraphTileIcon } from "@/components/epic-canvas/comm-graph/comm-graph-tile-icon";
import { ManagedCommandMonitorIcon } from "@/components/managed-commands/managed-command-monitor-icon";
import { useManagedCommandOnHost } from "@/stores/managed-commands/managed-commands-for-chat";
import { useIsActivePane, useTabActivation } from "@/stores/epics/canvas/store";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostReachability } from "@/hooks/agent/use-host-reachability";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import { useTerminalRenameFor } from "@/hooks/terminal/use-terminal-rename-for-mutation";
import { useUsageSummarySupported } from "@/hooks/usage-analytics/use-usage-summary-support";
import { useChatUsageDialogStore } from "@/stores/chats/chat-usage-dialog-store";
import {
  TabStripContextMenu,
  type TabStripContextMenuProps,
} from "@/components/epic-canvas/canvas/tab-strip-context-menu";
import { EpicNodeTabIcon } from "@/components/epic-canvas/epic-node-tab-icon";
import { useHorizontalWheelScroll } from "@/hooks/use-horizontal-wheel-scroll";
import { ChatIndicatorHostScopes } from "@/components/notifications/chat-indicator-host-scopes";
import { chatIndicatorHostScopes } from "@/lib/notifications/chat-indicator-scopes";
import { useCanvasTabLeaderModifierForIndex } from "@/providers/keybinding-context";
import { LeaderDigitBadge } from "@/components/ui/leader-digit-badge";
import {
  leaderDigitFor,
  leaderHint,
} from "@/components/ui/leader-digit-shortcuts";
import {
  gitBundleGroupLabel,
  gitDiffRepositoryContextLabel,
  gitStageLabel,
} from "@/lib/git/git-diff-tile";
import { getBasename } from "@/lib/path/cross-platform-path";
import { formatChordForDisplay } from "@/lib/keybindings/chord";
import { useBindingForAction } from "@/stores/settings/keybinding-store";
import {
  reportShiftKeyHeld,
  useShiftKeyHeld,
} from "@/hooks/use-shift-key-held";
import { useClipboardCopy } from "@/hooks/ui/use-clipboard-copy";
import { resolveAbsolutePath } from "@/lib/path/cross-platform-path";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { useEpicTerminalAuthority } from "@/hooks/terminal/use-epic-terminal-authority";
import { NotificationConsumptionContext } from "@/components/notifications/notification-consumption-context";

const EPIC_TAB_LAYOUT_TRANSITION = {
  type: "spring",
  stiffness: 520,
  damping: 42,
  mass: 0.65,
} as const;

const EPIC_TAB_DROP_INDICATOR_TRANSITION = {
  duration: 0.12,
  ease: "easeOut",
} as const;

export interface TabStripProps {
  readonly epicId: string;
  readonly tabId: string;
  readonly groupId: string;
  readonly tabs: ReadonlyArray<EpicCanvasTileRef>;
  // For the auto-scroll effect only. Per-tab active/preview/globally-active
  // state is read inside `TabItem` via `useTabActivation`, NOT threaded through
  // the map - see the `tabs.map(...)` note below.
  readonly activeTabId: string | null;
  readonly onSelectTab: (groupId: string, tabId: string) => void;
  readonly onCloseTab: (groupId: string, tabId: string) => void;
  readonly onPromotePreview: (groupId: string) => void;
  readonly onSplit: (groupId: string, direction: SplitDirection) => void;
  readonly onCloseGroup: (groupId: string) => void;
  readonly onOpenBlankTab: (groupId: string) => void;
  readonly canRenameTabs: boolean;
  readonly menuHandlers: Pick<
    TabStripContextMenuProps,
    | "onClose"
    | "onCloseOthers"
    | "onCloseRight"
    | "onCloseAll"
    | "onSplit"
    | "onRevealInSidebar"
    | "onRename"
  >;
}

function useTabElementRegistry() {
  const tabRefs = useRef<Map<string, HTMLElement> | null>(null);

  const getTabElements = useCallback(() => {
    if (tabRefs.current === null) {
      tabRefs.current = new Map();
    }
    return tabRefs.current;
  }, []);

  const setTabRef = useCallback(
    (id: string) => (el: HTMLElement | null) => {
      const tabElements = getTabElements();
      if (el === null) tabElements.delete(id);
      else tabElements.set(id, el);
    },
    [getTabElements],
  );

  const getTabElement = useCallback(
    (id: string) => tabRefs.current?.get(id),
    [],
  );

  return { setTabRef, getTabElement };
}

/**
 * VS Code-style tab strip. Renders one tab item per canvas tile ref, with
 * preview-mode italic, hover/active close buttons, top-border accent on
 * the globally-active tab, an overflow chevron-dropdown, and far-right
 * "split right" + "close group" buttons (always shown). Acts as a drop
 * target for both new sidebar nodes and tab moves; computes the
 * insertion index from the cursor x against rendered tab rects.
 */
export function TabStrip(props: TabStripProps) {
  const {
    epicId,
    tabId,
    groupId,
    tabs,
    activeTabId,
    onSelectTab,
    onCloseTab,
    onPromotePreview,
    onSplit,
    onCloseGroup,
    onOpenBlankTab,
    canRenameTabs,
    menuHandlers,
  } = props;

  const stripRef = useRef<HTMLDivElement | null>(null);
  const handleWheel = useHorizontalWheelScroll();
  const { setTabRef, getTabElement } = useTabElementRegistry();
  const stripEndDropData = useMemo<EpicCanvasDropTargetData>(
    () => ({
      kind: "artifact-tab-strip-end",
      viewTabId: tabId,
      groupId,
      index: tabs.length,
    }),
    [groupId, tabId, tabs.length],
  );
  const { setNodeRef: stripEndDropRef } = useDroppable({
    id: getArtifactTabStripEndDropId(groupId),
    data: stripEndDropData,
  });

  // Auto-scroll active tab into view when it changes.
  useEffect(() => {
    if (activeTabId === null) return;
    const el = getTabElement(activeTabId);
    if (el === undefined) return;
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTabId, getTabElement]);

  // Double-clicking the empty area after the tabs opens a blank tab in this
  // group (browser new-tab gesture). Guarded to the strip-end container itself
  // so double-clicking a tab (preview-promote) is never hijacked.
  const handleStripEndDoubleClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) return;
      onOpenBlankTab(groupId);
    },
    [groupId, onOpenBlankTab],
  );

  // Narrow per-strip subscription: preview ticks re-render only the strip
  // actually hovered, not every strip on the canvas.
  const dndDropIndicator = useTabStripDropIndex(groupId);
  // Terminal-agent tabs are chat-scoped notification entities too: a TUI
  // agent's `agent.stopped` row is keyed by its agent id, and the tab icon
  // already reads `chats[tab.id]`.
  //
  // Grouped by the tab's OWN bound host, not asked of the app-wide active one.
  // A strip can hold a retained cross-host tab beside a local one, and
  // `indicatorState` only ever answers about the rows its own host holds: the
  // active-host read left host B's `pendingFork` permanently dark and could
  // light a tab from an unrelated chat on A that shares its host-minted id.
  const indicatorScopes = useMemo(
    () =>
      chatIndicatorHostScopes(
        tabs.flatMap((tab) =>
          tab.type === "chat" || tab.type === "terminal-agent"
            ? [{ hostId: tab.hostId, chatId: tab.id }]
            : [],
        ),
      ),
    [tabs],
  );

  return (
    <ChatIndicatorHostScopes scopes={indicatorScopes}>
      <div
        ref={stripRef}
        data-testid="tab-strip"
        data-group-id={groupId}
        className={cn(
          "relative flex h-9 shrink-0 items-stretch border-b border-canvas-border/70 bg-canvas",
        )}
      >
        <div className="relative flex min-w-0 flex-1 items-stretch">
          <div
            ref={stripEndDropRef}
            data-testid="tab-strip-end"
            onWheel={handleWheel}
            onDoubleClick={handleStripEndDoubleClick}
            className="no-scrollbar flex min-w-0 flex-1 touch-pan-x items-stretch overflow-x-auto overscroll-x-contain"
          >
            {/*
            Per-tab active/preview/globally-active state is read inside TabItem
            via `useTabActivation`, NOT computed here from `activeTabId`. If it
            were a map dep, React Compiler would re-run this whole map on every
            active/preview change and re-render every tab. Keeping the map's
            deps to `tabs` + stable handlers means a pure active-switch
            re-renders only the two tabs whose flags flip.
          */}
            <LayoutGroup id={`epic-tab-strip-${groupId}`}>
              {tabs.map((tab, index) => (
                <TabItem
                  key={tab.instanceId}
                  domRef={setTabRef(tab.instanceId)}
                  tab={tab}
                  epicId={epicId}
                  tabId={tabId}
                  groupId={groupId}
                  showDropIndicatorBefore={dndDropIndicator === index}
                  index={index}
                  onSelect={onSelectTab}
                  onClose={onCloseTab}
                  onPromotePreview={onPromotePreview}
                  canRenameTabs={canRenameTabs}
                  menuProps={{
                    groupId,
                    tabId: tab.instanceId,
                    canCloseRight: index < tabs.length - 1,
                    ...menuHandlers,
                  }}
                />
              ))}
              <TabStripEndDropIndicator
                visible={
                  dndDropIndicator !== null && dndDropIndicator >= tabs.length
                }
              />
            </LayoutGroup>
          </div>
        </div>
        <div
          className={cn(
            "flex shrink-0 items-center gap-0.5 bg-canvas px-1",
            // Every tab already draws its own right border, so a border here
            // too would stack two hairlines against each other. Only an empty
            // strip has no preceding tab to supply the separator.
            tabs.length === 0 && "border-l border-canvas-border/70",
          )}
        >
          <SplitGroupButton groupId={groupId} onSplit={onSplit} />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => onCloseGroup(groupId)}
            aria-label="Close group"
            data-testid="tab-strip-close-group"
          >
            <X className="size-4" />
          </Button>
        </div>
      </div>
    </ChatIndicatorHostScopes>
  );
}

interface SplitGroupButtonProps {
  readonly groupId: string;
  readonly onSplit: (groupId: string, direction: SplitDirection) => void;
}

function SplitGroupButton(props: SplitGroupButtonProps) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const shiftHeld = useShiftKeyHeld();
  const splitHorizontalBinding = useBindingForAction("group.split.horizontal");
  const splitVerticalBinding = useBindingForAction("group.split.vertical");
  const splitsDown = shiftHeld && (hovered || focused);
  const direction = splitsDown ? "vertical" : "horizontal";
  const actionLabel = splitsDown ? "Split group down" : "Split group right";
  const shortcut = splitsDown ? splitVerticalBinding : splitHorizontalBinding;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onPointerEnter={(event) => {
            setHovered(true);
            reportShiftKeyHeld(event.shiftKey);
          }}
          onPointerLeave={() => setHovered(false)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onClick={(event) =>
            props.onSplit(
              props.groupId,
              event.shiftKey ? "vertical" : "horizontal",
            )
          }
          aria-label={actionLabel}
          data-testid="tab-strip-split"
          data-split-direction={direction}
        >
          {splitsDown ? (
            <SplitSquareVertical className="size-4" />
          ) : (
            <SplitSquareHorizontal className="size-4" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        sideOffset={4}
        className="flex-col items-start gap-1"
      >
        <span className="flex items-center gap-2">
          <span>{actionLabel}</span>
          {shortcut === null ? null : (
            <Kbd>{formatChordForDisplay(shortcut)}</Kbd>
          )}
        </span>
        <span className="text-background/70">
          {splitsDown
            ? "Release Shift to split right"
            : "Shift+click to split down"}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

interface TabItemProps {
  readonly tab: EpicCanvasTileRef;
  readonly epicId: string;
  /** The view (canvas) tab id - scopes the per-tab activation selector. */
  readonly tabId: string;
  readonly groupId: string;
  readonly index: number;
  readonly showDropIndicatorBefore: boolean;
  readonly onSelect: (groupId: string, tabId: string) => void;
  readonly onClose: (groupId: string, tabId: string) => void;
  readonly onPromotePreview: (groupId: string) => void;
  readonly canRenameTabs: boolean;
  readonly menuProps: Omit<
    TabStripContextMenuProps,
    "canRename" | "onCopyFilePath" | "onEditTitle" | "onOpenUsage"
  >;
  readonly domRef: (el: HTMLElement | null) => void;
}

// Ticket 12's chat cost line: the tab's own overflow (this context menu),
// never the header. `null` for every non-chat tab kind and for a chat whose
// host hasn't negotiated `host.usage.summary` - "unsupported chats show
/** The tab's bound host, for the tile kinds that have one. */
function tabHostId(tab: EpicCanvasTileRef): string | null {
  return "hostId" in tab ? tab.hostId : null;
}

// nothing" applied to the menu item itself rather than opening a dialog that
// would then show a capability notice. Extracted out of `TabItem` to keep
// that component's branching under the complexity budget.
function useChatUsageMenuHandler(
  tab: EpicCanvasTileRef,
  chatTitle: string,
): (() => void) | null {
  const usageChatHostId = tab.type === "chat" ? tabHostId(tab) : null;
  const usageSupported = useUsageSummarySupported(usageChatHostId);
  const openChatUsageDialog = useChatUsageDialogStore((s) => s.open);
  return useMemo(() => {
    if (usageChatHostId === null || !usageSupported) return null;
    return () => {
      openChatUsageDialog({
        hostId: usageChatHostId,
        chatId: tab.id,
        chatTitle,
      });
    };
  }, [chatTitle, openChatUsageDialog, tab.id, usageChatHostId, usageSupported]);
}

interface TerminalTabControl {
  readonly mode: "unknown" | "legacy" | "capable";
  readonly displayTitle: string;
  readonly canMutate: boolean;
  readonly rename: (title: string) => void;
}

function TabItem(props: TabItemProps) {
  if (props.tab.type !== "terminal") {
    return <TabItemBody {...props} terminalControl={null} />;
  }
  return (
    <TabHostProvider hostId={props.tab.hostId}>
      <TerminalTabItem {...props} tab={props.tab} />
    </TabHostProvider>
  );
}

function TerminalTabItem(
  props: Omit<TabItemProps, "tab"> & { readonly tab: EpicTerminalRef },
) {
  const controller = useEpicTerminalAuthority({
    epicId: props.epicId,
    node: props.tab,
  });
  const rename = controller.rename;
  const terminalId = props.tab.id;
  const canMutate =
    controller.canMutate &&
    !controller.migrationPending &&
    controller.projection !== undefined;
  const control: TerminalTabControl = {
    mode: controller.capability,
    displayTitle: controller.viewModel?.displayTitle ?? props.tab.name,
    canMutate,
    rename: (title) => {
      if (!controller.canMutate) return;
      rename.mutate({
        hostId: props.tab.hostId,
        terminalId,
        manualTitle: title,
      });
    },
  };
  return <TabItemBody {...props} terminalControl={control} />;
}

function useTabRenameControl(args: {
  readonly tab: EpicCanvasTileRef;
  readonly epicId: string;
  readonly groupId: string;
  readonly canRenameTabs: boolean;
  readonly terminalControl: TerminalTabControl | null;
  readonly onRename: TabItemProps["menuProps"]["onRename"];
}) {
  const { tab, epicId, groupId, canRenameTabs, terminalControl, onRename } =
    args;
  const isTerminalTab = tab.type === "terminal";
  const resolvedHostClient = useHostClientForHostId(
    isTerminalTab ? tabHostId(tab) : null,
  );
  const terminalHostClient =
    isTerminalTab && terminalControl?.mode !== "capable"
      ? resolvedHostClient
      : null;
  const fallbackDisplayTitle = useEpicTabDisplayTitle(
    {
      id: tab.id,
      name: tab.name,
      type: tab.type,
      hostId: tabHostId(tab),
    },
    epicId,
    terminalHostClient,
  );
  const displayTitle =
    terminalControl?.mode === "capable" || terminalControl?.mode === "unknown"
      ? terminalControl.displayTitle
      : fallbackDisplayTitle;
  const canRename =
    canRenameTabs &&
    (isOpenableEpicNodeKind(tab.type) || tab.type === "terminal") &&
    (terminalControl === null ||
      terminalControl.mode === "legacy" ||
      (terminalControl.mode === "capable" && terminalControl.canMutate));
  const renameTerminal = useTerminalRenameFor(terminalHostClient);
  const { mutate: renameTerminalMutate } = renameTerminal;
  const handleRename = (next: string) => {
    if (isTerminalTab) {
      const trimmed = next.trim();
      if (trimmed.length === 0) return;
      if (terminalControl?.mode === "capable") {
        terminalControl.rename(trimmed);
        return;
      }
      if (terminalControl?.mode === "unknown") return;
      renameTerminalMutate({ sessionId: tab.id, title: trimmed });
      return;
    }
    onRename(groupId, tab.instanceId, next);
  };
  const rename = useInlineRename({
    value: displayTitle,
    canEdit: canRename,
    onCommit: handleRename,
  });
  return { displayTitle, canRename, rename };
}

function TabItemBody(
  props: TabItemProps & {
    readonly terminalControl: TerminalTabControl | null;
  },
) {
  const {
    tab,
    epicId,
    tabId,
    groupId,
    index,
    showDropIndicatorBefore,
    onSelect,
    onClose,
    onPromotePreview,
    canRenameTabs,
    menuProps,
    domRef,
  } = props;
  // Read this tab's active/preview/globally-active state per tab so the strip's
  // map need not depend on the group's `activeTabId`; an active-switch then
  // re-renders only the two tabs whose flags flip. See `makeSelectTabActivation`.
  const { isActive, isPreview, isGloballyActive } = useTabActivation(
    tabId,
    groupId,
    tab.instanceId,
  );
  const isActivePane = useIsActivePane(tabId, groupId);
  const leaderModifier = useCanvasTabLeaderModifierForIndex(
    index,
    isActivePane,
  );
  const dragData = useMemo<EpicCanvasArtifactTabDragData>(
    () => ({
      kind: ARTIFACT_TAB_DND_TYPE,
      epicId,
      viewTabId: tabId,
      sourceGroupId: groupId,
      tabId: tab.instanceId,
      isPreview,
    }),
    [epicId, groupId, isPreview, tab.instanceId, tabId],
  );
  const {
    listeners,
    setNodeRef: dragRef,
    isDragging,
  } = useDraggable({
    id: getArtifactTabDragId(groupId, tab.instanceId),
    data: dragData,
  });
  const dropData = useMemo<EpicCanvasDropTargetData>(
    () => ({
      kind: "artifact-tab",
      viewTabId: tabId,
      groupId,
      tabId: tab.instanceId,
      index,
    }),
    [groupId, index, tab.instanceId, tabId],
  );
  const { setNodeRef: dropRef } = useDroppable({
    id: getArtifactTabDropId(groupId, tab.instanceId),
    data: dropData,
  });
  const { onRename } = menuProps;
  const { displayTitle, canRename, rename } = useTabRenameControl({
    tab,
    epicId,
    groupId,
    canRenameTabs,
    terminalControl: props.terminalControl,
    onRename,
  });
  const isArchived = useRegisteredEpicNodeArchived(epicId, tab.id);
  const titleGenerationPending = useEpicLiveArtifactTitleGenerating(
    tab.type === "chat" ? tab.id : null,
  );
  const setRef = useMemo(
    () => mergeRefs<HTMLElement>(domRef, dragRef, dropRef),
    [domRef, dragRef, dropRef],
  );

  const { copy } = useClipboardCopy({
    resetMs: 1500,
    onSuccess: null,
    onError: null,
  });
  const absoluteFilePath =
    tab.type === "workspace-file"
      ? resolveAbsolutePath(tab.workspacePath, tab.filePath)
      : null;
  const handleCopyFilePath = useCallback(() => {
    if (absoluteFilePath !== null) copy(absoluteFilePath);
  }, [absoluteFilePath, copy]);

  const onOpenUsage = useChatUsageMenuHandler(tab, displayTitle);
  const consumeNotificationEntity = useContext(NotificationConsumptionContext);

  const selectTab = useCallback(() => {
    if (rename.isEditing) return;
    onSelect(groupId, tab.instanceId);
    if (
      isActive &&
      consumeNotificationEntity !== null &&
      (tab.type === "chat" ||
        tab.type === "terminal" ||
        tab.type === "terminal-agent")
    ) {
      consumeNotificationEntity({
        originHostId: tab.hostId,
        entity: { epicId, chatId: tab.id },
      });
    }
  }, [
    consumeNotificationEntity,
    epicId,
    groupId,
    isActive,
    onSelect,
    rename.isEditing,
    tab,
  ]);

  const handleDoubleClick = useCallback(() => {
    if (rename.isEditing) return;
    if (isPreview) onPromotePreview(groupId);
  }, [groupId, isPreview, onPromotePreview, rename.isEditing]);

  const handleClose = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onClose(groupId, tab.instanceId);
  };

  const handleAuxClick = (event: MouseEvent<HTMLDivElement>) => {
    // Middle-click closes.
    if (event.button === 1) {
      event.preventDefault();
      onClose(groupId, tab.instanceId);
    }
  };

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (rename.isEditing) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectTab();
      }
    },
    [rename.isEditing, selectTab],
  );
  const leaderBadge =
    leaderModifier === null
      ? null
      : {
          modifier: leaderModifier,
          hint: leaderHint(leaderDigitFor(index), "to switch to", displayTitle),
        };
  const tooltipContent = tabTooltipContent(tab, displayTitle);

  return (
    <ContextMenu>
      <TabItemMotionFrame isDragging={isDragging}>
        <ContextMenuTrigger asChild>
          <div
            ref={setRef}
            {...listeners}
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            data-testid={`tab-item-${tab.instanceId}`}
            data-tab-id={tab.instanceId}
            data-active={isActive ? "true" : "false"}
            data-preview={isPreview ? "true" : "false"}
            data-globally-active={isGloballyActive ? "true" : "false"}
            onClick={selectTab}
            onDoubleClick={handleDoubleClick}
            onKeyDown={handleKeyDown}
            onAuxClick={handleAuxClick}
            className={cn(
              "group relative flex h-9 shrink-0 cursor-pointer items-center gap-1.5 border-r border-canvas-border/70 px-3 text-ui-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              "transition-[background-color,color] duration-300 ease-spring",
              "hover:bg-card/60 active:scale-[0.97]",
              // Paint over the strip border so the active tab merges with the panel below.
              isActive &&
                "bg-(--app-background) text-canvas-foreground shadow-[inset_0_-1px_0_0_var(--app-background)]",
              !isActive && "text-muted-foreground hover:text-foreground/90",
            )}
          >
            <TabStripDropIndicator visible={showDropIndicatorBefore} />
            {isGloballyActive ? (
              <DropLine
                orientation="horizontal"
                glow={false}
                className="absolute inset-x-0 top-0 origin-left animate-in fade-in slide-in-from-left-2 duration-300 ease-spring"
                testId="tab-active-accent"
              />
            ) : null}
            <TabIcon
              epicId={epicId}
              tab={tab}
              titleGenerationPending={titleGenerationPending}
            />
            <TabItemLabelSlot
              displayTitle={displayTitle}
              isArchived={isArchived}
              tooltipContent={tooltipContent}
              inputProps={rename.inputProps}
              isActive={isActive}
              isEditing={rename.isEditing}
              isPreview={isPreview}
              leaderBadge={leaderBadge}
              onClose={handleClose}
              tabInstanceId={tab.instanceId}
              tabIndex={index}
            />
          </div>
        </ContextMenuTrigger>
      </TabItemMotionFrame>
      <TabStripContextMenu
        {...menuProps}
        canRename={canRename}
        onCopyFilePath={absoluteFilePath === null ? null : handleCopyFilePath}
        onEditTitle={rename.startEditing}
        onOpenUsage={onOpenUsage}
      />
    </ContextMenu>
  );
}

interface CanvasLeaderBadge {
  readonly modifier: "mod";
  readonly hint: string;
}

interface TabItemLabelSlotProps {
  readonly displayTitle: string;
  readonly isArchived: boolean;
  readonly tooltipContent: ReactNode;
  readonly inputProps: InlineRenameInputProps;
  readonly isActive: boolean;
  readonly isEditing: boolean;
  readonly isPreview: boolean;
  readonly leaderBadge: CanvasLeaderBadge | null;
  readonly onClose: (event: MouseEvent<HTMLButtonElement>) => void;
  readonly tabInstanceId: string;
  readonly tabIndex: number;
}

function TabItemLabelSlot(props: TabItemLabelSlotProps) {
  const {
    displayTitle,
    isArchived,
    tooltipContent,
    inputProps,
    isActive,
    isEditing,
    isPreview,
    leaderBadge,
    onClose,
    tabInstanceId,
    tabIndex,
  } = props;

  if (isEditing) {
    return (
      <input
        {...inputProps}
        aria-label="Edit tab title"
        data-testid={`tab-title-input-${tabInstanceId}`}
        className="h-6 min-w-[7ch] max-w-40 rounded-sm border border-border bg-background px-1 text-ui-sm text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
    );
  }

  return (
    <>
      <span className="relative min-w-[7ch] max-w-40">
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              data-testid={`tab-title-${tabInstanceId}`}
              className={cn(
                "inline-flex max-w-full min-w-0 items-center gap-1 pr-1 align-bottom group-focus-within:opacity-0 group-hover:opacity-0",
                isPreview && "italic",
                isActive ? "font-medium" : "font-normal",
              )}
            >
              <TabDisplayTitle
                displayTitle={displayTitle}
                isArchived={isArchived}
              />
            </span>
          </TooltipTrigger>
          <TooltipContent>{tooltipContent}</TooltipContent>
        </Tooltip>
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-y-0 left-0 right-5 hidden min-w-0 items-center gap-1 pr-1 group-focus-within:flex group-hover:flex",
            leaderBadge !== null && "right-7",
            isPreview && "italic",
            isActive ? "font-medium" : "font-normal",
          )}
        >
          <TabDisplayTitle
            displayTitle={displayTitle}
            isArchived={isArchived}
          />
        </span>
      </span>
      <AnimatePresence initial={false}>
        {leaderBadge !== null ? (
          <LeaderDigitBadge
            key={`${leaderBadge.modifier}:${tabInstanceId}`}
            digit={leaderDigitFor(tabIndex)}
            modifier={leaderBadge.modifier}
            ariaLabel={leaderBadge.hint}
            testId={`canvas-tab-digit-${leaderDigitFor(tabIndex)}`}
            className={undefined}
          />
        ) : null}
      </AnimatePresence>
      {leaderBadge === null ? (
        <button
          type="button"
          onClick={onClose}
          aria-label={`Close ${displayTitle}`}
          data-testid={`tab-close-${tabInstanceId}`}
          className={cn(
            "pointer-events-none absolute right-2 inline-flex size-4 items-center justify-center rounded-sm opacity-0 transition-[background-color,color,opacity] focus-visible:opacity-100",
            "hover:bg-foreground/5",
            "group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100",
          )}
        >
          <X className="size-3" />
        </button>
      ) : null}
    </>
  );
}

function TabDisplayTitle(props: {
  readonly displayTitle: string;
  readonly isArchived: boolean;
}): ReactNode {
  return (
    <>
      {props.isArchived ? (
        <>
          <span className="shrink-0 font-semibold text-muted-foreground">
            Archived
          </span>
          <span aria-hidden="true" className="shrink-0 text-muted-foreground">
            ·
          </span>
        </>
      ) : null}
      <span className="min-w-0 flex-1 truncate">{props.displayTitle}</span>
    </>
  );
}

function tabTooltipContent(
  tab: EpicCanvasTileRef,
  displayTitle: string,
): ReactNode {
  if (!isGitDiffTileRef(tab)) return displayTitle;
  const context = tab.repositoryContext;
  const repositoryLabel =
    context?.repositoryLabel ?? getBasename(tab.diff.runningDir);
  const scopeLabel =
    tab.diff.kind === "bundle"
      ? gitBundleGroupLabel(tab.diff.bundleGroup)
      : gitStageLabel(tab.diff.stage);
  const heading =
    context === null ? repositoryLabel : gitDiffRepositoryContextLabel(context);
  return (
    <div
      className="flex w-[min(80vw,24rem)] min-w-0 flex-col gap-1 text-left"
      data-testid={`git-diff-tab-tooltip-${tab.instanceId}`}
    >
      <div className="truncate font-medium">{heading}</div>
      {context === null ? null : (
        <GitDiffTooltipSummaryRow
          label="Workspace"
          value={context.workspaceLabel}
          testId="git-diff-tooltip-workspace"
          wrap={false}
        />
      )}
      <GitDiffTooltipSummaryRow
        label="Repository"
        value={repositoryLabel}
        testId="git-diff-tooltip-repository"
        wrap={false}
      />
      <GitDiffTooltipSummaryRow
        label="Diff"
        value={scopeLabel}
        testId="git-diff-tooltip-scope"
        wrap={false}
      />
      {tab.diff.kind === "file" ? (
        <GitDiffTooltipSummaryRow
          label="File"
          value={tab.diff.filePath}
          testId="git-diff-tooltip-file"
          wrap
        />
      ) : null}
      <div className="mt-0.5 border-t border-background/15 pt-1">
        <GitDiffTooltipSummaryRow
          label="Path"
          value={tab.diff.runningDir}
          testId="git-diff-tooltip-path"
          wrap
        />
      </div>
    </div>
  );
}

function GitDiffTooltipSummaryRow(props: {
  readonly label: string;
  readonly value: string;
  readonly testId: string;
  readonly wrap: boolean;
}): ReactNode {
  return (
    <div
      className="flex min-w-0 items-start justify-between gap-3"
      data-testid={props.testId}
    >
      <span className="shrink-0 text-background/70">{props.label}</span>
      <span
        className={cn(
          "min-w-0 text-right font-medium",
          props.wrap ? "break-all" : "truncate",
        )}
      >
        {props.value}
      </span>
    </div>
  );
}

function TabItemMotionFrame(props: {
  readonly isDragging: boolean;
  readonly children: ReactNode;
}) {
  return (
    <m.div
      layout="position"
      initial={false}
      animate={{
        opacity: props.isDragging ? 0.36 : 1,
        scale: props.isDragging ? 0.97 : 1,
      }}
      transition={EPIC_TAB_LAYOUT_TRANSITION}
      className="relative flex shrink-0 items-stretch"
    >
      {props.children}
    </m.div>
  );
}

function TabStripDropIndicator(props: { readonly visible: boolean }) {
  return (
    <AnimatePresence initial={false}>
      {props.visible ? (
        <m.span
          aria-hidden
          initial={{ opacity: 0, scaleY: 0.45 }}
          animate={{ opacity: 1, scaleY: 1 }}
          exit={{ opacity: 0, scaleY: 0.45 }}
          transition={EPIC_TAB_DROP_INDICATOR_TRANSITION}
          className="absolute inset-y-1 left-0 z-20 -translate-x-0.5 origin-center"
        >
          <DropLine
            orientation="vertical"
            glow={false}
            className="h-full"
            testId="tab-strip-drop-indicator"
          />
        </m.span>
      ) : null}
    </AnimatePresence>
  );
}

function TabStripEndDropIndicator(props: { readonly visible: boolean }) {
  return (
    <AnimatePresence initial={false}>
      {props.visible ? (
        <m.div
          initial={{ opacity: 0, scaleY: 0.45 }}
          animate={{ opacity: 1, scaleY: 1 }}
          exit={{ opacity: 0, scaleY: 0.45 }}
          transition={EPIC_TAB_DROP_INDICATOR_TRANSITION}
          className="my-1 origin-center self-stretch"
        >
          <DropLine
            orientation="vertical"
            glow={false}
            className="h-full"
            testId="tab-strip-drop-indicator"
          />
        </m.div>
      ) : null}
    </AnimatePresence>
  );
}

function TabIcon(props: {
  readonly epicId: string;
  readonly tab: EpicCanvasTileRef;
  readonly titleGenerationPending: boolean;
}): ReactNode {
  // Unconditional so hook order holds across tab kinds; the placeholder
  // answers "reachable", which keeps every non-chat tab on its normal glyph.
  const boundHostReachability = useHostReachability(
    props.tab.type === "chat" ? props.tab.hostId : UNKNOWN_HOST_PLACEHOLDER,
  );
  // Same live lookup the title already runs (`useEpicTabDisplayTitle`), so the
  // glyph and the name in one tab can never disagree about whether the shell is
  // watching. Unconditional for hook order; an empty id resolves to null.
  const managedCommand = useManagedCommandOnHost({
    epicId: props.epicId,
    // Scoped to the tab's own bound host: a clone's tab must never wear the
    // source host's shell (same rule the card's presence follows).
    hostId: isManagedCommandOutputTileRef(props.tab) ? props.tab.hostId : "",
    commandId: isManagedCommandOutputTileRef(props.tab) ? props.tab.id : "",
  });
  if (isDiffTileRef(props.tab) || isPrDiffTileRef(props.tab)) {
    return <FileDiff className="size-3.5 shrink-0 text-muted-foreground" />;
  }
  if (isPrDetailTileRef(props.tab)) {
    return (
      <GitPullRequest className="size-3.5 shrink-0 text-muted-foreground" />
    );
  }
  if (isBlankTileRef(props.tab)) {
    return <FilePlus className="size-3.5 shrink-0 text-muted-foreground" />;
  }
  if (isManagedCommandOutputTileRef(props.tab)) {
    // A tab opened for a shell whose chat has no live session yet resolves to
    // nothing; the quiet glyph is the honest guess, since a watcher announces
    // itself the moment its record lands.
    return (
      <ManagedCommandMonitorIcon
        monitoring={managedCommand !== null && managedCommand.monitoring}
        decorative
        className="size-3.5"
      />
    );
  }
  if (isUtilityTileRef(props.tab)) return utilityTileIcon(props.tab);
  // A published copy carries the lock rather than a chat glyph: the tab is
  // readable but cannot be steered, and that is the one thing about it that
  // differs from the chat tab beside it.
  if (isPublishedChatTileRef(props.tab)) {
    return <Lock className="size-3.5 shrink-0 text-muted-foreground" />;
  }
  // A live chat tab whose bound host is unreachable renders the published
  // copy (see tab-group-view's fallback), so its strip icon must say the same
  // thing the surface does: locked, not steerable, exactly like a copy tab.
  // Flips back to the chat glyph reactively when the host returns.
  if (
    props.tab.type === "chat" &&
    boundHostReachability.status === "unreachable"
  ) {
    return (
      <Lock
        className="size-3.5 shrink-0 text-muted-foreground"
        data-testid={`tab-live-chat-lock-${props.tab.instanceId}`}
      />
    );
  }
  // Title generation is the idle default for chat tabs only - threaded into
  // ChatProgressIcon so running / notification / read-only semantics win
  // (mirrors global TabLeadingIcon). Non-chat tabs never subscribe to the
  // indicator store from this component.
  const defaultIcon =
    props.tab.type === "chat" && props.titleGenerationPending ? (
      <AgentSpinningDots
        className="size-3.5 text-muted-foreground"
        testId={`tab-title-generating-${props.tab.instanceId}`}
        variant="dots2"
      />
    ) : undefined;
  return (
    <EpicNodeTabIcon
      node={props.tab}
      epicId={props.epicId}
      variant="live"
      className="size-3.5 shrink-0"
      defaultIcon={defaultIcon}
    />
  );
}

type UtilityTileRef = CommGraphTileRef | DeletedArtifactsTileRef;

function isUtilityTileRef(tab: EpicCanvasTileRef): tab is UtilityTileRef {
  return tab.type === "comm-graph" || tab.type === "deleted-artifacts";
}

function utilityTileIcon(tab: UtilityTileRef): ReactNode {
  if (tab.type === "comm-graph") {
    return <CommGraphTileIcon className="size-3.5" />;
  }
  return <Trash2 className="size-3.5 shrink-0 text-muted-foreground" />;
}
