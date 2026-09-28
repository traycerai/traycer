import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
  type TransitionEvent,
} from "react";
import { flushSync } from "react-dom";
import { SheetJoinBridge } from "../sheet-join";
import { useLayoutSurface } from "@/components/layout-editor/use-layout-surface";
import { ColumnEdgeContext } from "@/components/layout/column-edge-context";
import { HoverCardGroup } from "@/components/ui/hover-card";
import { isFramelessDesktop } from "@/components/layout/header/title-bar-drag";
import { useMotionEnabled } from "@/lib/animation/use-motion-enabled";
import { registerDynamicActionHandler } from "@/lib/keybindings/dispatch";
import type { EdgeSide } from "@/lib/layout/layout-arrangement";
import { cn } from "@/lib/utils";
import { useWindowsBridgeHydrated } from "@/providers/windows-bridge-context";
import {
  useSideStripCollapsed,
  useSideTabStripStore,
} from "@/stores/layout/side-tab-strip-store";
import { useTitleBarDraggingSuppressed } from "@/stores/layout/title-bar-drag-store";
import { useTabsStore } from "@/stores/tabs/store";
import { useTabStripController } from "../tab-strip-controller";
import { TabStripIndicatorScope } from "../tab-strip-indicator-scope";
import { SideStripFoot } from "./side-strip-foot";
import { SideStripResizeHandle } from "./side-strip-resize-handle";
import { SideStripRowList } from "./side-strip-row-list";
import { SideStripSkeleton } from "./side-strip-skeleton";
import { SideStripTopBlock } from "./side-strip-top-block";
import type { SideTabRowVariant } from "./side-tab-row";
import {
  SIDE_STRIP_MAX_WIDTH_CLASS,
  SIDE_STRIP_RAIL_WIDTH_PX,
  SIDE_STRIP_TITLE_ROW_MIN_WIDTH_CLASS,
} from "./side-strip-tokens";

const DRAG_REGION_CLASS = "[-webkit-app-region:drag]";
const NO_DRAG_REGION_CLASS = "[-webkit-app-region:no-drag]";

/**
 * The task tabs as a vertical strip at the left or right edge (S-01, S-05):
 * the header's leading actions in the top block, the rows in a scrolling
 * column, the header's trailing actions in the foot, and a resize handle on
 * the content-facing edge.
 *
 * It never returns `null` (S-27): with no tabs, no Home and the landing route
 * only the row list is empty, and before the windows bridge hydrates the rows
 * are placeholders while the top block and the foot are live.
 *
 * `ownsTitleBar` is true only on macOS with the strip at the left, where the
 * top block's first row is the window's title bar (S-04).
 */
export function SideTabStrip(props: {
  readonly edge: EdgeSide;
  readonly ownsTitleBar: boolean;
}): ReactNode {
  const { edge, ownsTitleBar } = props;
  const controller = useTabStripController();
  const hydrated = useWindowsBridgeHydrated();
  const persistedStripCount = useTabsStore((state) => state.stripOrder.length);
  const collapsed = useSideStripCollapsed();
  const widthPx = useSideTabStripStore((state) => state.widthPx);
  const variant: SideTabRowVariant = collapsed ? "collapsed" : "expanded";
  const stripRef = useRef<HTMLElement | null>(null);
  const widthEasing = useCollapseWidthEasing(stripRef);
  const stopWidthEasing = widthEasing.stop;
  // The keyboard's collapse is instant (L-165); only this strip registers it,
  // so the action exists exactly while the tabs are at the side.
  useEffect(
    () =>
      registerDynamicActionHandler("app.tabs.vertical.collapse", () => {
        stopWidthEasing();
        const { collapsed, setCollapsed } = useSideTabStripStore.getState();
        setCollapsed(!collapsed);
      }),
    [stopWidthEasing],
  );
  const dragClass = useStripDragClass();
  const surfaceRef = useLayoutSurface("topBar");
  const bindStrip = useCallback(
    (node: HTMLElement | null) => {
      stripRef.current = node;
      surfaceRef(node);
    },
    [surfaceRef],
  );
  return (
    <ColumnEdgeContext.Provider value={edge}>
      {/* One clock for every row's and tile's card, the home row's included:
          the first waits, the next one along opens at once. */}
      <HoverCardGroup>
        <nav
          ref={bindStrip}
          aria-label="Tabs"
          data-testid="side-tab-strip"
          data-edge={edge}
          data-collapsed={collapsed}
          onTransitionEnd={widthEasing.settle}
          onTransitionCancel={widthEasing.settle}
          className={cn(
            "relative flex h-full min-h-0 shrink-0 flex-col bg-canvas text-canvas-foreground md:bg-transparent",
            collapsed ? undefined : SIDE_STRIP_MAX_WIDTH_CLASS,
            // The rail never gets narrower than the traffic lights need (S-18),
            // and the expanded strip never narrower than the lights plus the title
            // row's controls (S-43).
            ownsTitleBar &&
              (collapsed
                ? "wco:min-w-[var(--window-leading-inset)]"
                : SIDE_STRIP_TITLE_ROW_MIN_WIDTH_CLASS),
            // The collapse button and a handle drag's snap-point crossing ease
            // the width once; everything else changes it instantly (L-165).
            widthEasing.easing &&
              "transition-[width] duration-(--panel-motion-duration) ease-spring",
            dragClass,
          )}
          style={{ width: collapsed ? SIDE_STRIP_RAIL_WIDTH_PX : widthPx }}
        >
          <SideStripTopBlock
            edge={edge}
            variant={variant}
            ownsTitleBar={ownsTitleBar}
            dragClass={dragClass}
            homeTabDrawn={controller.homeTabDrawn}
            homeIsActive={controller.homeIsActive}
            onHomeTab={controller.onHomeTab}
            onNewTab={controller.onNewTab}
            onToggleCollapsed={widthEasing.toggle}
            taskCount={controller.tabs.length}
          />
          <TabStripIndicatorScope indicators={controller.indicators}>
            {hydrated ? (
              <SideStripRowList
                controller={controller}
                edge={edge}
                variant={variant}
              />
            ) : (
              <SideStripSkeleton
                count={persistedStripCount}
                variant={variant}
              />
            )}
          </TabStripIndicatorScope>
          {/* A direct child of the nav: Electron honours a drag region reliably
            only on the title bar's top-level elements. */}
          <div
            aria-hidden
            data-testid="side-strip-drag-spacer"
            className={cn("min-h-0 flex-1", dragClass)}
          />
          <SideStripFoot variant={variant} />
          {/* The joined tab's run onto its task's sheet, anchored to the joined
            row and drawn only while one exists (`index.css`). */}
          <div data-strip-drag-overlay-host className="contents" />
          <SheetJoinBridge edge={edge} />
          <SideStripResizeHandle
            edge={edge}
            stripRef={stripRef}
            easeWidth={widthEasing.ease}
            stopWidthEasing={widthEasing.stop}
          />
          {controller.dialogs}
        </nav>
      </HoverCardGroup>
    </ColumnEdgeContext.Provider>
  );
}

/**
 * The strip's window drag region on a frameless desktop window, dropped to
 * no-drag while an overlay anchored in the strip needs the clicks.
 */
function useStripDragClass(): string | undefined {
  const dragSuppressed = useTitleBarDraggingSuppressed();
  if (!isFramelessDesktop()) return undefined;
  return dragSuppressed ? NO_DRAG_REGION_CLASS : DRAG_REGION_CLASS;
}

/**
 * Whether the width is easing between the rail and the expanded strip (L-165).
 * Two things start it, and only while motion is enabled: the collapse button,
 * and a handle drag's frame that crosses the snap point, a discrete jump
 * between 192 and 60 rather than pointer tracking. The end of that width
 * transition clears it, and so does `stop`, synchronously, so the keyboard's
 * collapse, a drag's start, its release and Escape all land instantly. The
 * width a drag writes while the ease runs retargets it. A nudge and a window
 * resize never turn it on.
 *
 * `stop` also cancels the running transition itself: Chromium keeps it running
 * when the class goes but the inline width stays the value it was easing to,
 * which is exactly a release on the snap target.
 */
function useCollapseWidthEasing(stripRef: RefObject<HTMLElement | null>): {
  readonly easing: boolean;
  readonly toggle: () => void;
  readonly ease: () => void;
  readonly stop: () => void;
  readonly settle: (event: TransitionEvent<HTMLElement>) => void;
} {
  const motionEnabled = useMotionEnabled();
  const [easing, setEasing] = useState(false);
  const ease = (): void => {
    setEasing(motionEnabled);
  };
  const toggle = (): void => {
    const { collapsed, setCollapsed } = useSideTabStripStore.getState();
    ease();
    setCollapsed(!collapsed);
  };
  const stop = useCallback((): void => {
    flushSync(() => {
      setEasing(false);
    });
    const strip = stripRef.current;
    // jsdom has no Web Animations.
    if (strip === null || !("getAnimations" in strip)) return;
    for (const animation of strip.getAnimations()) {
      if (
        animation instanceof CSSTransition &&
        animation.transitionProperty === "width"
      )
        animation.cancel();
    }
  }, [stripRef]);
  const settle = (event: TransitionEvent<HTMLElement>): void => {
    if (event.target !== event.currentTarget) return;
    if (event.propertyName !== "width") return;
    setEasing(false);
  };
  return { easing, toggle, ease, stop, settle };
}
