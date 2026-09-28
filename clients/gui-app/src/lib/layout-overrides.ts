import { createContext, use, useMemo } from "react";
import type {
  BarPlacement,
  BarRegionId,
  LayoutArrangement,
  ReadingWidth,
} from "@/lib/layout/layout-arrangement";
import {
  type HideableRegionId,
  type LayoutOverrides,
  type LayoutValues,
} from "@/lib/layout/layout-values";
import { PRESET_VALUES } from "@/lib/layout/layout-presets";
import type { RailRegionId, RegionId } from "@/lib/layout/region-id";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import { useLayoutStore } from "@/stores/layout/layout-store";

/**
 * The ONE seam every layout value is read through, so a picture of an element
 * under a DIFFERENT value can be drawn by the real component rather than by a
 * second, drifting copy of it.
 *
 * The problem it solves: the editor's specimen stages, its style examples and
 * its preset miniatures all have to show what an option WOULD look like.
 * Wrapping the real leaf in an override makes the picture and the shipping
 * element the same implementation (L-11).
 *
 * Its shape is the store's shape one level down: a region's value bag and the
 * arrangement, both as partials. A region is the unit because a region is what
 * a section edits, and every leaf under one is a scalar (`pinnedFields`
 * aside) - so one spread per region IS the merge, and there is no second level
 * for an inner override to drop.
 *
 * ## The passivity contract (D11) - the part that is easy to get wrong
 *
 * An override changes what a mounted component DRAWS. It does not, and must
 * not, change whether one exists. So what may be wrapped is a VISUAL LEAF:
 * something that renders from props and these hooks and performs no app action.
 * A preview mount does no host fetch, opens no stream, registers no keyboard
 * handler, activates no picker and writes to no store. Mounting `AppStatusBar`
 * or a live `HarnessModelPicker` inside an override is not previewing, it is
 * running a second copy of the app's chrome.
 *
 * ## Ancestor seams an override cannot reach
 *
 * Several values decide whether a child is rendered at all, and they are read
 * by ancestors a depiction is nowhere near:
 *
 * - `AppShell` mounts the status-bar strip;
 * - `AppStatusBar` decides the usage cluster and the resource segment exist;
 * - `chat-messages` mounts the turn minimap;
 * - the chat tile decides its dock exists;
 * - `top-level-tab-host`, the mobile drawer and the palette gate on the Home
 *   tab's existence.
 *
 * Those read the same values through the same hooks, which is what makes a
 * region's `shown` one answer rather than two - but they are never WRAPPED: an
 * override above a mount decision would make a depiction mount real chrome.
 */
export interface LayoutOverride {
  /** Per region, then per leaf inside that region's value bag. */
  readonly values?: LayoutOverrides;
  /** Whole fields: an order, a side, a host. Each one is a leaf. */
  readonly arrangement?: Partial<LayoutArrangement>;
}

/**
 * Frozen and shared, so the common case - no provider anywhere above - costs
 * one stable context read. A fresh `{}` default would hand every consumer a new
 * identity on every render.
 */
const NO_OVERRIDE: LayoutOverride = Object.freeze({});

/**
 * Exported for `providers/layout-override-provider.tsx` and nothing else. The
 * provider lives in its own file because a module that exports both a component
 * and hooks breaks fast refresh (`react-refresh/only-export-components`), which
 * is the same three-file split `providers/runner-host-*` uses.
 */
export const LayoutOverrideContext = createContext<LayoutOverride>(NO_OVERRIDE);

/**
 * One override's regions onto another's, per region AND per leaf inside it.
 *
 * Two levels rather than one: the value under a region id is that region's
 * whole value bag, so `{...parent, ...child}` at the region level would let an
 * inner override about the model chip's style drop an outer override of the
 * chip's `shown` beside it.
 *
 * Used by `LayoutOverrideProvider`; not part of the read API.
 */
export function mergeOverrides(
  parent: LayoutOverride,
  child: LayoutOverride,
): LayoutOverride {
  return {
    values: mergeValues(parent.values, child.values),
    arrangement:
      parent.arrangement === undefined && child.arrangement === undefined
        ? undefined
        : { ...parent.arrangement, ...child.arrangement },
  };
}

function mergeValues(
  parent: LayoutOverrides | undefined,
  child: LayoutOverrides | undefined,
): LayoutOverrides | undefined {
  if (parent === undefined) return child;
  if (child === undefined) return parent;
  const merged: Record<string, object> = { ...parent };
  for (const [regionId, patch] of Object.entries(child)) {
    merged[regionId] = { ...merged[regionId], ...patch };
  }
  return merged;
}

/**
 * One region's whole value bag as this subtree should draw it.
 *
 * For a reader that genuinely draws from the whole bag - a usage segment reads
 * five leaves, the resource monitor four.
 */
export function useRegionValues<K extends RegionId>(
  regionId: K,
): LayoutValues[K] {
  const { base, stored } = useRegionBase(regionId);
  const override = use(LayoutOverrideContext).values?.[regionId];
  return useMemo(
    () => layered(base, stored, override),
    [base, stored, override],
  );
}

/** What a region's values rest on: the last-applied preset and the stored delta. */
function useRegionBase<K extends RegionId>(
  regionId: K,
): {
  readonly base: LayoutValues[K];
  readonly stored: Partial<LayoutValues[K]> | undefined;
} {
  const basePreset = useLayoutStore((state) => state.basePreset);
  const stored = useLayoutStore((state) => state.overrides[regionId]);
  return { base: PRESET_VALUES[basePreset][regionId], stored };
}

/**
 * One leaf of one region.
 *
 * Subscribed to the region's own patch rather than to the whole store, which is
 * as fine-grained as the delta can be: an untouched region has no patch at all,
 * so its readers re-render only once the user first changes that region.
 */
export function useRegionValue<
  K extends RegionId,
  Key extends keyof LayoutValues[K] & string,
>(regionId: K, key: Key): LayoutValues[K][Key] {
  const { base, stored } = useRegionBase(regionId);
  const override = use(LayoutOverrideContext).values?.[regionId];
  return override?.[key] ?? stored?.[key] ?? base[key];
}

/**
 * Whether a region draws at all, which is the question every mount decision
 * asks. The rail regions are excluded because their `shown` is three-state:
 * `auto` needs the panel's own presence rule to answer (L-47), which
 * `lib/layout/rail-view.ts` resolves.
 */
export function useRegionShown(
  regionId: Exclude<HideableRegionId, RailRegionId>,
): boolean {
  return useRegionValue(regionId, "shown") === "shown";
}

/**
 * One arrangement field, subscribed to exactly that field.
 *
 * There is deliberately no whole-arrangement hook: every reader wants one or
 * two fields, and subscribing to the object made a dock reorder or a divider
 * drag re-render the rate-limit segment hook, the profile-selection hook, the
 * visibility menu and the header popover (G1-14).
 */
export function useArrangementValue<Key extends keyof LayoutArrangement>(
  key: Key,
): LayoutArrangement[Key] {
  const stored = useLayoutStore((state) => state.arrangement[key]);
  const override = use(LayoutOverrideContext).arrangement?.[key];
  return override === undefined ? stored : override;
}

/**
 * The content column the transcript, every lower surface of the composer and
 * an artifact's body share, as a class. One answer for all of them, because a
 * chat and the document read beside it must agree on their measure (audit R2).
 * Literal class names, so Tailwind sees both.
 */
const READING_WIDTH_CLASS: Readonly<Record<ReadingWidth, string>> = {
  comfortable: "max-w-3xl",
  wide: "max-w-5xl",
};

export function useReadingWidthClass(): string {
  return READING_WIDTH_CLASS[useArrangementValue("readingWidth")];
}

/**
 * Where both bar readings say they are (L-156), for the two surfaces that
 * draw a cluster.
 *
 * Four fields read one at a time, which is what the seam serves, assembled
 * once: the strip and the header need the same pair to ask
 * `barClusterRegionsAt` what they are holding, and a second copy of the read
 * is the one thing that could still make the two bars disagree about one
 * arrangement. `barClusterRegions` stays the arrangement-holding variant, for
 * the depictions that have the whole thing in hand.
 */
export function useBarPlacements(): Readonly<
  Record<BarRegionId, BarPlacement>
> {
  const usageHost = useArrangementValue("usageHost");
  const usageSide = useArrangementValue("usageSide");
  const resourceHost = useArrangementValue("resourceHost");
  const resourceSide = useArrangementValue("resourceSide");
  return useMemo(
    () => ({
      usageLimits: { host: usageHost, side: usageSide },
      resourceMonitor: { host: resourceHost, side: resourceSide },
    }),
    [usageHost, usageSide, resourceHost, resourceSide],
  );
}

/**
 * Whether the app-wide status bar strip should actually mount - the app
 * shell's own gate, distinct from {@link statusBarHostsAnyRegion}
 * (`layout-arrangement.ts`), which only answers whether either reading is
 * ASSIGNED to this bar. That narrower question is right for placement logic
 * (the menu, the toggle) - but a reading that is hosted here and individually
 * switched off (never re-hosted, just hidden) still passes it, which used to
 * leave the strip mounted forever as an empty, still-bordered shell: its own
 * `GhostRegion` placeholder only materialises while the layout editor has a
 * session open and is pointing at it, so outside editing there was nothing
 * left to draw.
 *
 * Shown once at least one hosted reading is actually on; while editing, shown
 * as soon as anything is hosted here at all, so a hidden reading's ghost
 * stays a click away to switch back on rather than disappearing along with
 * the strip it belongs to.
 */
export function useStatusBarVisible(): boolean {
  const isMobileViewport = useIsMobileViewport();
  const mobileFooter = useArrangementValue("mobileFooter");
  const usageHost = useArrangementValue("usageHost");
  const resourceHost = useArrangementValue("resourceHost");
  const usageShown = useRegionShown("usageLimits");
  const resourcesShown = useRegionShown("resourceMonitor");
  const editing = useLayoutEditorStore((state) => state.session !== null);
  if (isMobileViewport) return mobileFooter;
  const hostedHere =
    usageHost === "status-bar" || resourceHost === "status-bar";
  if (!hostedHere) return false;
  if (editing) return true;
  return (
    (usageHost === "status-bar" && usageShown) ||
    (resourceHost === "status-bar" && resourcesShown)
  );
}

/**
 * The base, then the stored delta, then the subtree's override - the same order
 * the store itself resolves in, with one more layer on top.
 *
 * Generic over the VALUE BAG rather than the region id, so the base argument
 * infers it and the spread of two `Partial<Values>` onto a `Values` is a
 * `Values` rather than an indexed access TypeScript cannot follow.
 */
function layered<Values extends object>(
  base: Values,
  stored: Partial<Values> | undefined,
  override: Partial<Values> | undefined,
): Values {
  if (stored === undefined && override === undefined) return base;
  return { ...base, ...stored, ...override };
}
