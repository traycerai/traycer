import {
  useCallback,
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
  SplitSquareHorizontal,
  SplitSquareVertical,
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
  EpicCanvasTileRef,
  SplitDirection,
} from "@/stores/epics/canvas/types";
import {
  isBlankTileRef,
  isDiffTileRef,
  isGitDiffTileRef,
  isOpenableEpicNodeKind,
} from "@/stores/epics/canvas/types";
import { useIsActivePane, useTabActivation } from "@/stores/epics/canvas/store";
import {
  TabStripContextMenu,
  type TabStripContextMenuProps,
} from "@/components/epic-canvas/canvas/tab-strip-context-menu";
import { EpicNodeTabIcon } from "@/components/epic-canvas/epic-node-tab-icon";
import { useHorizontalWheelScroll } from "@/hooks/use-horizontal-wheel-scroll";
import { useHostNotificationIndicators } from "@/hooks/notifications/use-host-notification-indicators-query";
import { NotificationIndicatorsProvider } from "@/components/notifications/notification-indicators-provider";
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
  const chatIds = useMemo(
    () => tabs.flatMap((tab) => (tab.type === "chat" ? [tab.id] : [])),
    [tabs],
  );
  const notificationIndicators = useHostNotificationIndicators({
    epicIds: [],
    chatIds,
    enabled: chatIds.length > 0,
  });

  return (
    <NotificationIndicatorsProvider indicators={notificationIndicators.data}>
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
        <div className="flex shrink-0 items-center gap-0.5 border-l border-canvas-border/70 bg-canvas px-1">
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
    </NotificationIndicatorsProvider>
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
    "canRename" | "onEditTitle"
  >;
  readonly domRef: (el: HTMLElement | null) => void;
}

function TabItem(props: TabItemProps) {
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
  const displayTitle = useEpicTabDisplayTitle({
    id: tab.id,
    name: tab.name,
    type: tab.type,
    instanceId: "instanceId" in tab ? tab.instanceId : undefined,
    titleSource: "titleSource" in tab ? tab.titleSource : undefined,
  });
  const titleGenerationPending = useEpicLiveArtifactTitleGenerating(
    tab.type === "chat" ? tab.id : null,
  );
  const setRef = useMemo(
    () => mergeRefs<HTMLElement>(domRef, dragRef, dropRef),
    [domRef, dragRef, dropRef],
  );

  // Only chat / artifact / terminal tabs carry an editable title; diff,
  // blank, and workspace-file tabs are not renameable.
  const canRename = canRenameTabs && isOpenableEpicNodeKind(tab.type);
  // Pull `onRename` out so the commit callback depends on the (stable) handler
  // rather than the per-render `menuProps` object literal.
  const { onRename } = menuProps;
  const handleRename = useCallback(
    (next: string) => {
      onRename(groupId, tab.instanceId, next);
    },
    [groupId, onRename, tab.instanceId],
  );
  const rename = useInlineRename({
    value: displayTitle,
    canEdit: canRename,
    onCommit: handleRename,
  });

  const selectTab = useCallback(() => {
    if (rename.isEditing) return;
    onSelect(groupId, tab.instanceId);
  }, [groupId, onSelect, rename.isEditing, tab.instanceId]);

  const handleDoubleClick = useCallback(() => {
    if (rename.isEditing) return;
    if (isPreview) onPromotePreview(groupId);
  }, [groupId, isPreview, onPromotePreview, rename.isEditing]);

  const handleClose = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      onClose(groupId, tab.instanceId);
    },
    [groupId, onClose, tab.instanceId],
  );

  const handleAuxClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      // Middle-click closes.
      if (event.button === 1) {
        event.preventDefault();
        onClose(groupId, tab.instanceId);
      }
    },
    [groupId, onClose, tab.instanceId],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (rename.isEditing) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onSelect(groupId, tab.instanceId);
      }
    },
    [groupId, onSelect, rename.isEditing, tab.instanceId],
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
        onEditTitle={rename.startEditing}
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
                "inline-block max-w-full truncate pr-1 align-bottom group-focus-within:opacity-0 group-hover:opacity-0",
                isPreview && "italic",
                isActive ? "font-medium" : "font-normal",
              )}
            >
              {displayTitle}
            </span>
          </TooltipTrigger>
          <TooltipContent>{tooltipContent}</TooltipContent>
        </Tooltip>
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-y-0 left-0 right-5 hidden truncate pr-1 group-focus-within:block group-hover:block",
            leaderBadge !== null && "right-7",
            isPreview && "italic",
            isActive ? "font-medium" : "font-normal",
          )}
        >
          {displayTitle}
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
            "hover:bg-muted",
            "group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100",
          )}
        >
          <X className="size-3" />
        </button>
      ) : null}
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
  if (props.titleGenerationPending) {
    return (
      <AgentSpinningDots
        className="size-3.5 text-muted-foreground"
        testId={`tab-title-generating-${props.tab.instanceId}`}
        variant="dots2"
      />
    );
  }
  if (isDiffTileRef(props.tab)) {
    return <FileDiff className="size-3.5 shrink-0 text-muted-foreground" />;
  }
  if (isBlankTileRef(props.tab)) {
    return <FilePlus className="size-3.5 shrink-0 text-muted-foreground" />;
  }
  return (
    <EpicNodeTabIcon
      node={props.tab}
      epicId={props.epicId}
      variant="live"
      className="size-3.5 shrink-0"
    />
  );
}
