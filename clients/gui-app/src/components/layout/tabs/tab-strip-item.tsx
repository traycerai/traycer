import { memo, useRef } from "react";
import { X } from "lucide-react";
import { AnimatePresence } from "motion/react";
import { useStripItemDisplacement } from "./use-strip-item-displacement";
import * as m from "motion/react-m";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { DropLine } from "@/components/ui/drop-line";
import type { TaskPinnedState } from "@/hooks/epic/use-epic-task-pinned-states-query";
import { LeaderDigitBadge } from "@/components/ui/leader-digit-badge";
import { leaderDigitFor } from "@/components/ui/leader-digit-shortcuts";
import { useTopLevelStripPairPreview } from "@/components/epic-canvas/dnd/dnd-store";
import { HeaderTabVisual } from "./header-tab-visual";
import {
  useStripTabItem,
  type HeaderTabDndConfig,
  type StripTabLeaderBadge,
} from "./use-strip-tab-item";
import {
  StripTabContextMenu,
  StripTabTitleInput,
} from "./strip-tab-item-parts";
import {
  useHeaderTabDisplacementTransition,
  headerTabClassName,
} from "@/components/layout/tabs/tab-chrome-tokens";
import type { TabSplitCommandId } from "@/stores/tabs/tab-split-commands";
import type { HeaderTabKind } from "@/stores/tabs/registry";
import type { HeaderTab } from "@/stores/tabs/types";
import { tabRefKey } from "@/stores/tabs/layout";
import { useConcealedForTravel } from "./strip-selection-travel";
import { useStripEntrance } from "./use-strip-entrance";

const NO_DRAG_CLASS = "[-webkit-app-region:no-drag]";
const TITLE_INPUT_CLASS =
  "min-w-0 flex-1 rounded-sm border border-border bg-background px-1 text-left text-ui-sm text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring [-webkit-app-region:no-drag]";

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
  readonly taskPinnedState: TaskPinnedState | null;
  readonly isTaskPinPending: boolean;
  readonly onSetTaskPinned: (
    epicId: string,
    pinned: boolean,
    displayName: string,
  ) => void;
  /** Re-asks for this epic's pin reading when the menu opens without one. */
  readonly onTaskPinMenuOpen: (epicId: string) => void;
}

/** The top strip's presentation of a tab over `useStripTabItem`. */
export const TabItem = memo(function TabItem(props: TabItemProps) {
  const { tab, dnd, chrome, includeMotionFrame, isActive } = props;
  const { rootRef, ...item } = useStripTabItem(props);
  // While the selection slides here, the traveller draws the joined box.
  const concealed = useConcealedForTravel(dnd?.stripItemId ?? null);
  const joined = isActive && chrome === "own" && !item.isDragging && !concealed;
  const control = (
    <StripTabContextMenu item={item} input={props}>
      <div
        ref={rootRef}
        {...item.dragListeners}
        {...item.rootProps}
        className={cn(
          headerTabClassName(chrome, isActive),
          NO_DRAG_CLASS,
          "cursor-pointer",
        )}
      >
        <HeaderTabDropIndicator
          visible={props.showDropIndicatorBefore}
          side="left"
        />
        <HeaderTabVisual
          tab={tab}
          appearance={item.appearance}
          indicatorState={item.indicatorState}
          displayName={item.displayName}
          chrome={chrome}
          isActive={isActive}
          joined={joined}
          concealed={concealed}
          titleControl={
            item.rename.isEditing ? (
              <StripTabTitleInput
                item={item}
                tab={tab}
                className={TITLE_INPUT_CLASS}
              />
            ) : null
          }
          trailingControl={
            <TabTrailingSlot
              label={`Close ${item.displayName}`}
              testId={`tab-close-${tab.kind}-${tab.id}`}
              onClose={item.close}
              leaderBadge={item.leaderBadge}
              disabled={!item.canClose}
            />
          }
          leaderVisible={item.leaderBadge !== null}
        />
        <StripPairPreview tabKind={tab.kind} tabId={tab.id} />
        <HeaderTabSeparator visible={props.showSeparatorAfter} />
        <HeaderTabDropIndicator
          visible={props.showDropIndicatorAfter}
          side="right"
        />
      </div>
    </StripTabContextMenu>
  );
  if (!includeMotionFrame) return control;
  return (
    <HeaderTabMotionFrame
      isDragging={item.isDragging}
      offsetX={props.offsetX}
      dnd={dnd}
      entranceKeys={tabRefKey(tab)}
    >
      {control}
    </HeaderTabMotionFrame>
  );
});

TabItem.displayName = "TabItem";

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
      data-side={props.side}
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

function HeaderTabMotionFrame(props: {
  readonly isDragging: boolean;
  readonly offsetX: number;
  /** Drag config; its `stripItemId` is the drag model's measurement anchor. */
  readonly dnd: HeaderTabDndConfig | null;
  /** The tab's ref key, the mark an open or a reopen leaves for it. */
  readonly entranceKeys: string;
  readonly children: React.ReactNode;
}) {
  const transition = useHeaderTabDisplacementTransition();
  const frameRef = useRef<HTMLDivElement | null>(null);
  useStripEntrance(frameRef, props.entranceKeys, "tab");
  const x = useStripItemDisplacement({
    nodeRef: frameRef,
    offset: props.offsetX,
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
      className="relative flex w-56 min-w-[min(40vw,12rem)] group-data-[tab-layout=shrink]/strip:min-w-12 max-w-56 flex-[1_1_14rem] items-end [container-type:inline-size]"
    >
      {props.children}
    </m.div>
  );
}

interface TabTrailingSlotProps {
  label: string;
  testId: string;
  onClose: () => void;
  leaderBadge: StripTabLeaderBadge | null;
  disabled: boolean;
}

/**
 * Close controls overlay the label; leader badges reserve their intrinsic width.
 * The title's tooltip anchor keeps a stable width across hover.
 */
function TabTrailingSlot(props: TabTrailingSlotProps) {
  const { label, testId, onClose, leaderBadge, disabled } = props;
  const showLeader = leaderBadge !== null;
  return (
    <span
      className={cn(
        "z-20 flex shrink-0 items-center justify-center overflow-hidden transition-opacity duration-150 ease-spring [-webkit-app-region:no-drag]",
        showLeader
          ? "relative w-fit opacity-100"
          : "header-tab-trailing-slot absolute right-0 top-1/2 -translate-y-1/2",
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
          variant="muted"
          aria-label={label}
          data-testid={testId}
          disabled={disabled}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }}
          className="header-tab-close-button size-5 [-webkit-app-region:no-drag]"
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

/**
 * Shown on the tab a pair-into-split drop would combine with, the moment the
 * pointer is on its approach half. The highlight covers ONLY the half the
 * DRAGGED tab will take - the side it approaches from, the same side the
 * commit writes. A full-tab ring reads inverted mid-drag: the opaque drag
 * overlay sits over the approach half, so the only visible part of a whole-tab
 * highlight is the OPPOSITE half.
 */
function StripPairPreview(props: {
  readonly tabKind: HeaderTabKind;
  readonly tabId: string;
}) {
  const side = useTopLevelStripPairPreview(props.tabKind, props.tabId);
  if (side === null) return null;
  return (
    <span
      aria-hidden
      data-testid={`tab-strip-pair-preview-${props.tabKind}-${props.tabId}`}
      data-side={side}
      className={cn(
        "pointer-events-none absolute inset-y-0.5 z-30 rounded-xl bg-primary/20 ring-2 ring-primary",
        side === "left" ? "left-0.5 right-1/2" : "left-1/2 right-0.5",
      )}
    />
  );
}
