import {
  Suspense,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { FocusEvent, PointerEvent } from "react";
import { useDroppable } from "@dnd-kit/core";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import {
  flattenStripItemRefs,
  type SplitSide,
  type SplitSideName,
  type SplitStripItem,
  type StripItem,
} from "@/stores/tabs/layout";
import { tabSurfaceDescriptor } from "@/stores/tabs/registry";
import { useHeaderTabs } from "@/stores/tabs/use-header-tabs";
import { useTabsStore } from "@/stores/tabs/store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { HeaderTab, TabRef } from "@/stores/tabs/types";
import { SplitDivider } from "@/components/layout/tabs/split-divider";
import { SplitSlotChooser } from "@/components/layout/tabs/split-slot-chooser";
import {
  TOP_LEVEL_EDGE_SPLIT_TARGET,
  TOP_LEVEL_FILLABLE_TARGET,
  edgeSplitDropId,
  fillableSlotDropId,
  type TopLevelEdgeSplitTarget,
  type TopLevelFillableTarget,
} from "@/components/layout/tabs/top-level-tab-dnd";
import { useTopLevelEdgeSplitPreview } from "@/components/epic-canvas/dnd/dnd-store";
import { PhaseMigrationControllerHost } from "@/components/epic-tabs/phase-migration-controller-host";
import { PhaseMigrationSurface } from "@/components/epic-tabs/phase-migration-surface";
import { TabSurfaceActivityProvider } from "./tab-surface-activity";
import { SurfaceReadinessBoundary } from "./host-readiness-controller";
import { SurfacePresentationBoundary } from "./surface-presentation-boundary";
import {
  activateTopLevelSurfaceFromFocus,
  activateTopLevelSurfaceFromPointer,
  useTopLevelSurfaceActivator,
} from "./top-level-surface-activation-context";

export const MAX_RETAINED_TOP_LEVEL_SURFACES = 5;

type SurfacePlacement =
  | { readonly kind: "hidden" }
  | { readonly kind: "single" }
  | { readonly kind: "left"; readonly width: string }
  | { readonly kind: "right"; readonly left: string; readonly width: string };

/**
 * One keyed keep-alive layer for every top-level tab kind. Active split members
 * are pinned; all remaining capacity is global MRU across hidden surfaces.
 */
export function TopLevelTabHost() {
  const { items, activeItemId } = useTabsStore(
    useShallow((state) => ({
      items: state.items,
      activeItemId: state.activeItemId,
    })),
  );
  const headerTabs = useHeaderTabs();
  const hostBoundsRef = useRef<HTMLDivElement | null>(null);
  const [previewRatio, setPreviewRatio] = useState<number | null>(null);
  const activeItem = items.find((item) => item.id === activeItemId) ?? null;
  const renderedActiveItem = useMemo(
    () =>
      activeItem?.kind === "split" && previewRatio !== null
        ? { ...activeItem, leftRatio: previewRatio }
        : activeItem,
    [activeItem, previewRatio],
  );
  const tabsByRefKey = useMemo(
    () => new Map(headerTabs.map((tab) => [tabRefKey(tab), tab])),
    [headerTabs],
  );
  const availableRefKeys = useMemo(
    () =>
      items
        .flatMap(flattenStripItemRefs)
        .map(tabRefKey)
        .filter((key, index, keys) => keys.indexOf(key) === index)
        .filter((key) => tabsByRefKey.has(key)),
    [items, tabsByRefKey],
  );
  const activeRefKeys = useMemo(
    () =>
      (renderedActiveItem === null
        ? []
        : flattenStripItemRefs(renderedActiveItem)
      )
        .map(tabRefKey)
        .filter((key) => tabsByRefKey.has(key)),
    [renderedActiveItem, tabsByRefKey],
  );
  const mountedRefKeys = useMountedSurfaceKeys(availableRefKeys, activeRefKeys);
  const activateSurface = useTopLevelSurfaceActivator();
  const mounts = mountedRefKeys.flatMap((key) => {
    const tab = tabsByRefKey.get(key);
    if (tab === undefined) return [];
    const placement = placementForRef(renderedActiveItem, tab);
    return [
      {
        tab,
        placement,
        activity: {
          visible: placement.kind !== "hidden",
          focused: refIsFocused(activeItem, tab),
        },
      },
    ];
  });

  return (
    <div
      ref={hostBoundsRef}
      className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden"
      data-testid="top-level-tab-host"
    >
      <PhaseMigrationControllerHost />
      {mounts.map((mount) => (
        <div
          key={tabRefKey(mount.tab)}
          aria-hidden={!mount.activity.visible}
          className={surfaceClassName(mount.placement)}
          data-focused={mount.activity.focused ? "true" : "false"}
          data-surface-kind={mount.tab.kind}
          data-surface-ref={tabRefKey(mount.tab)}
          data-testid={`top-level-surface-${mount.tab.kind}-${mount.tab.id}`}
          data-visible={mount.activity.visible ? "true" : "false"}
          onFocusCapture={(event: FocusEvent<HTMLDivElement>) => {
            activateTopLevelSurfaceFromFocus(
              event,
              mount.activity.focused,
              mount.tab,
              activateSurface,
            );
          }}
          onPointerDownCapture={(event: PointerEvent<HTMLDivElement>) => {
            activateTopLevelSurfaceFromPointer(
              event,
              mount.activity.focused,
              mount.tab,
              activateSurface,
            );
          }}
          style={surfaceStyle(mount.placement)}
        >
          <TabSurfaceActivityProvider activity={mount.activity}>
            <SurfacePresentationBoundary
              visible={mount.activity.visible}
              focused={mount.activity.focused}
            >
              <SurfaceReadinessBoundary
                scope={tabSurfaceDescriptor(mount.tab.kind).readinessScope}
                // T11 supplies a durable per-Epic host id. Current top-level
                // members deliberately use their descriptor's default/none key.
                tabHostId={null}
              >
                <Suspense fallback={null}>
                  <TabSurface tab={mount.tab} />
                </Suspense>
              </SurfaceReadinessBoundary>
            </SurfacePresentationBoundary>
          </TabSurfaceActivityProvider>
        </div>
      ))}
      {renderedActiveItem?.kind === "tab" ? (
        <TopLevelEdgeSplitTargets targetRef={renderedActiveItem.ref} />
      ) : null}
      {renderedActiveItem?.kind === "split" ? (
        <>
          <FillableSplitSlots item={renderedActiveItem} />
          <SplitDivider
            splitId={renderedActiveItem.id}
            leftRatio={renderedActiveItem.leftRatio}
            hostBoundsRef={hostBoundsRef}
            onPreviewRatioChange={setPreviewRatio}
          />
        </>
      ) : null}
    </div>
  );
}

function useMountedSurfaceKeys(
  availableRefKeys: ReadonlyArray<string>,
  activeRefKeys: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const activeSignature = activeRefKeys.join("\u001f");
  const [seenActiveSignature, setSeenActiveSignature] =
    useState(activeSignature);
  const [recency, setRecency] = useState<ReadonlyArray<string>>(activeRefKeys);

  if (activeSignature !== seenActiveSignature) {
    setSeenActiveSignature(activeSignature);
    setRecency((previous) => [
      ...activeRefKeys,
      ...previous.filter((key) => !activeRefKeys.includes(key)),
    ]);
  }

  return useMemo(() => {
    const available = new Set(availableRefKeys);
    const ordered = [
      ...activeRefKeys,
      ...recency.filter(
        (key) => available.has(key) && !activeRefKeys.includes(key),
      ),
    ];
    const retained = new Set(ordered.slice(0, MAX_RETAINED_TOP_LEVEL_SURFACES));
    return availableRefKeys.filter((key) => retained.has(key));
  }, [activeRefKeys, availableRefKeys, recency]);
}

function FillableSplitSlots(props: {
  readonly item: SplitStripItem;
}): ReactNode {
  return (["left", "right"] as const).flatMap((side) => {
    const slot = side === "left" ? props.item.left : props.item.right;
    if (slot.kind === "tab") return [];
    const placement = splitSidePlacement(props.item, side);
    return (
      <FillableSplitSlot
        key={`${props.item.id}:${side}`}
        splitId={props.item.id}
        side={side}
        slot={slot}
        placement={placement}
        focused={props.item.focusedSide === side}
      />
    );
  });
}

function FillableSplitSlot(props: {
  readonly splitId: string;
  readonly side: SplitSideName;
  readonly slot: Exclude<SplitSide, { readonly kind: "tab" }>;
  readonly placement: SurfacePlacement;
  readonly focused: boolean;
}): ReactNode {
  const dropData: TopLevelFillableTarget = {
    kind: TOP_LEVEL_FILLABLE_TARGET,
    splitId: props.splitId,
    side: props.side,
  };
  const { setNodeRef } = useDroppable({
    id: fillableSlotDropId(props.splitId, props.side),
    data: dropData,
  });
  return (
    <div
      ref={setNodeRef}
      aria-label="Fillable split slot"
      className={surfaceClassName(props.placement)}
      data-slot-kind={props.slot.kind}
      data-slot-side={props.side}
      data-testid={`top-level-fillable-slot-${props.side}`}
      style={surfaceStyle(props.placement)}
      onFocusCapture={() => {
        tabCommandCoordinator.focusSplitSide({
          splitId: props.splitId,
          side: props.side,
        });
      }}
      onPointerDownCapture={() => {
        tabCommandCoordinator.focusSplitSide({
          splitId: props.splitId,
          side: props.side,
        });
      }}
    >
      <TabSurfaceActivityProvider
        activity={{ visible: true, focused: props.focused }}
      >
        <SurfacePresentationBoundary visible focused={props.focused}>
          <SplitSlotChooser
            splitId={props.splitId}
            side={props.side}
            slot={props.slot}
            focused={props.focused}
          />
        </SurfacePresentationBoundary>
      </TabSurfaceActivityProvider>
    </div>
  );
}

function TopLevelEdgeSplitTargets(props: {
  readonly targetRef: TabRef;
}): ReactNode {
  const left: TopLevelEdgeSplitTarget = {
    kind: TOP_LEVEL_EDGE_SPLIT_TARGET,
    targetRef: props.targetRef,
    side: "left",
  };
  const right: TopLevelEdgeSplitTarget = {
    kind: TOP_LEVEL_EDGE_SPLIT_TARGET,
    targetRef: props.targetRef,
    side: "right",
  };
  const { setNodeRef: setLeftRef } = useDroppable({
    id: edgeSplitDropId(props.targetRef, "left"),
    data: left,
  });
  const { setNodeRef: setRightRef } = useDroppable({
    id: edgeSplitDropId(props.targetRef, "right"),
    data: right,
  });
  const preview = useTopLevelEdgeSplitPreview(
    props.targetRef.kind,
    props.targetRef.id,
  );
  return (
    <>
      {preview !== null ? (
        <div
          aria-hidden
          data-preview-side={preview}
          data-testid="top-level-edge-split-preview"
          className="pointer-events-none absolute inset-0 z-10 grid grid-cols-2 gap-px bg-border/70 p-px"
        >
          <div
            data-testid="top-level-edge-split-preview-left"
            data-destination={preview === "left" ? "true" : "false"}
            className={cn(
              "bg-background/85",
              preview === "left" &&
                "bg-primary/15 ring-2 ring-inset ring-primary",
            )}
          />
          <div
            data-testid="top-level-edge-split-preview-right"
            data-destination={preview === "right" ? "true" : "false"}
            className={cn(
              "bg-background/85",
              preview === "right" &&
                "bg-primary/15 ring-2 ring-inset ring-primary",
            )}
          />
        </div>
      ) : null}
      <div
        ref={setLeftRef}
        aria-hidden
        data-testid="top-level-edge-target-left"
        className={cn(
          "pointer-events-none absolute inset-y-0 left-0 z-20 w-1/5 border-2 border-transparent transition-colors",
          preview === "left" && "border-primary bg-primary/10",
        )}
      />
      <div
        ref={setRightRef}
        aria-hidden
        data-testid="top-level-edge-target-right"
        className={cn(
          "pointer-events-none absolute inset-y-0 right-0 z-20 w-1/5 border-2 border-transparent transition-colors",
          preview === "right" && "border-primary bg-primary/10",
        )}
      />
    </>
  );
}

function TabSurface(props: { readonly tab: HeaderTab }): ReactNode {
  switch (props.tab.kind) {
    case "epic":
      return <EpicTabSurface tab={props.tab} />;
    case "draft":
      return tabSurfaceDescriptor("draft").render(props.tab);
    case "history":
      return tabSurfaceDescriptor("history").render(props.tab);
    case "settings":
      return tabSurfaceDescriptor("settings").render(props.tab);
  }
}

function EpicTabSurface(props: {
  readonly tab: Extract<HeaderTab, { kind: "epic" }>;
}): ReactNode {
  const surfaceMode = useEpicCanvasStore(
    (state) => state.tabsById[props.tab.id]?.surfaceMode,
  );
  if (surfaceMode?.kind === "phase-migration") {
    return (
      <PhaseMigrationSurface
        phaseId={surfaceMode.phaseId}
        tabId={props.tab.id}
      />
    );
  }
  return tabSurfaceDescriptor("epic").render(props.tab);
}

function placementForRef(
  activeItem: StripItem | null,
  tab: HeaderTab,
): SurfacePlacement {
  if (activeItem === null) return { kind: "hidden" };
  if (activeItem.kind === "tab") {
    return refsMatch(activeItem.ref, tab)
      ? { kind: "single" }
      : { kind: "hidden" };
  }
  if (refsMatch(activeItem.left, tab)) {
    return splitSidePlacement(activeItem, "left");
  }
  if (refsMatch(activeItem.right, tab)) {
    return splitSidePlacement(activeItem, "right");
  }
  return { kind: "hidden" };
}

function splitSidePlacement(
  item: SplitStripItem,
  side: SplitSideName,
): SurfacePlacement {
  const leftWidth = `${item.leftRatio * 100}%`;
  if (side === "left") return { kind: "left", width: leftWidth };
  return {
    kind: "right",
    left: leftWidth,
    width: `${(1 - item.leftRatio) * 100}%`,
  };
}

function refIsFocused(activeItem: StripItem | null, tab: HeaderTab): boolean {
  if (activeItem === null) return false;
  if (activeItem.kind === "tab") return refsMatch(activeItem.ref, tab);
  const focused =
    activeItem.focusedSide === "left" ? activeItem.left : activeItem.right;
  return refsMatch(focused, tab);
}

function refsMatch(ref: TabRef | SplitSide, tab: HeaderTab): boolean {
  const candidate = ref.kind === "tab" ? ref.ref : ref;
  return (
    candidate.kind === tab.kind && "id" in candidate && candidate.id === tab.id
  );
}

function tabRefKey(ref: TabRef | HeaderTab): string {
  return `${ref.kind}:${ref.id}`;
}

function surfaceClassName(placement: SurfacePlacement): string {
  return cn(
    "absolute inset-y-0 flex h-full min-h-0 min-w-0 flex-col overflow-hidden",
    placement.kind === "single" && "inset-x-0",
    placement.kind === "hidden" && "hidden pointer-events-none",
  );
}

function surfaceStyle(placement: SurfacePlacement): CSSProperties | undefined {
  switch (placement.kind) {
    case "hidden":
    case "single":
      return undefined;
    case "left":
      return { left: "0%", width: placement.width };
    case "right":
      return { left: placement.left, width: placement.width };
  }
}
