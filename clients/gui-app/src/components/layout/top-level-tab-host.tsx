import {
  Suspense,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
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
import type { HeaderTab, TabRef } from "@/stores/tabs/types";
import { TabSurfaceActivityProvider } from "./tab-surface-activity";

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
  const activeItem = items.find((item) => item.id === activeItemId) ?? null;
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
      (activeItem === null ? [] : flattenStripItemRefs(activeItem))
        .map(tabRefKey)
        .filter((key) => tabsByRefKey.has(key)),
    [activeItem, tabsByRefKey],
  );
  const mountedRefKeys = useMountedSurfaceKeys(availableRefKeys, activeRefKeys);
  const mounts = mountedRefKeys.flatMap((key) => {
    const tab = tabsByRefKey.get(key);
    if (tab === undefined) return [];
    const placement = placementForRef(activeItem, tab);
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
      className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden"
      data-testid="top-level-tab-host"
    >
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
          style={surfaceStyle(mount.placement)}
        >
          <TabSurfaceActivityProvider activity={mount.activity}>
            <Suspense fallback={null}>
              <TabSurface tab={mount.tab} />
            </Suspense>
          </TabSurfaceActivityProvider>
        </div>
      ))}
      {activeItem?.kind === "split" ? renderFillableSlots(activeItem) : null}
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

function renderFillableSlots(item: SplitStripItem): ReactNode {
  return (["left", "right"] as const).flatMap((side) => {
    const slot = side === "left" ? item.left : item.right;
    if (slot.kind === "tab") return [];
    const placement = splitSidePlacement(item, side);
    return (
      <div
        key={`${item.id}:${side}`}
        aria-label="Empty split slot"
        className={surfaceClassName(placement)}
        data-slot-kind={slot.kind}
        data-slot-side={side}
        data-testid={`top-level-fillable-slot-${side}`}
        style={surfaceStyle(placement)}
      />
    );
  });
}

function TabSurface(props: { readonly tab: HeaderTab }): ReactNode {
  switch (props.tab.kind) {
    case "epic":
      return tabSurfaceDescriptor("epic").render(props.tab);
    case "draft":
      return tabSurfaceDescriptor("draft").render(props.tab);
    case "history":
      return tabSurfaceDescriptor("history").render(props.tab);
    case "settings":
      return tabSurfaceDescriptor("settings").render(props.tab);
  }
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
