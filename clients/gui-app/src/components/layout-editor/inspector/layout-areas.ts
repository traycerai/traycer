import {
  LayoutTemplate,
  MessageSquare,
  PanelBottom,
  PanelLeft,
  PanelTop,
  SquarePen,
  type LucideIcon,
} from "lucide-react";
import {
  BAR_HOST_OPTIONS,
  SURFACE_GROUPS,
  READING_WIDTH_OPTIONS,
  TAB_STRIP_PLACEMENT_OPTIONS,
  type SurfaceGroupId,
} from "@/components/layout-editor/regions/region-grammar";
import { surfaceChanged } from "@/components/layout-editor/regions/surface-diff";
import { LAYOUT } from "@/components/settings/panels/layout-settings.definitions";
import type { LayoutArrangement } from "@/lib/layout/layout-arrangement";
import { layoutModified } from "@/lib/layout/layout-diff";
import {
  effectiveLayoutValues,
  PRESET_LABELS,
} from "@/lib/layout/layout-presets";
import type { LayoutSnapshot } from "@/lib/layout/layout-snapshot";
import {
  regionValuesHidden,
  type LayoutValues,
} from "@/lib/layout/layout-values";

/**
 * The layout form's areas: the Presets block and the five surfaces, each with
 * its icon, description, changed dot and one-line summary. Both hosts of the
 * form (Settings > Layout and the editor inspector) read them from here.
 */

export type LayoutAreaId = "presets" | SurfaceGroupId;

export interface LayoutArea {
  readonly id: LayoutAreaId;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly description: string;
}

const AREA_ICONS: Readonly<Record<SurfaceGroupId, LucideIcon>> = {
  topBar: PanelTop,
  sidebar: PanelLeft,
  chat: MessageSquare,
  composer: SquarePen,
  statusBar: PanelBottom,
};

const AREA_DESCRIPTIONS: Readonly<Record<SurfaceGroupId, string>> = {
  topBar: "Tabs for tasks and app pages. Tabs inside a task are not affected.",
  sidebar: "Which side the sidebar takes, and the panels on its rail.",
  chat: "How a conversation reads, and what sits beside it.",
  composer: "What sits above the message box, and on its toolbar.",
  statusBar:
    "Usage limits and the resource monitor: where each sits and how much it shows.",
};

/** The five areas that are surfaces of the app, in reading order. */
export const SURFACE_AREAS: ReadonlyArray<
  LayoutArea & { readonly id: SurfaceGroupId }
> = SURFACE_GROUPS.map((group) => ({
  id: group.id,
  label: group.label,
  icon: AREA_ICONS[group.id],
  description: AREA_DESCRIPTIONS[group.id],
}));

/** Presets first - the coarsest control - then the surfaces. */
export const LAYOUT_AREAS: ReadonlyArray<LayoutArea> = [
  {
    id: "presets",
    label: LAYOUT.definitions.presets.label,
    icon: LayoutTemplate,
    description:
      "How much the app shows at once. A preset never moves anything.",
  },
  ...SURFACE_AREAS,
];

/** Whether an area's dot is lit: something in it differs from its baseline. */
export function layoutAreaChanged(
  area: LayoutAreaId,
  snapshot: LayoutSnapshot,
): boolean {
  return area === "presets"
    ? layoutModified(snapshot)
    : surfaceChanged(snapshot, area);
}

/** The one-line state an area row reads out beside its name. */
export function layoutAreaSummary(
  area: LayoutAreaId,
  snapshot: LayoutSnapshot,
): string {
  const values = effectiveLayoutValues(snapshot.basePreset, snapshot.overrides);
  const arrangement = snapshot.arrangement;
  switch (area) {
    case "presets":
      return `${PRESET_LABELS[snapshot.basePreset]}${
        layoutModified(snapshot) ? " · Modified" : ""
      }`;
    case "topBar":
      return optionLabel(
        TAB_STRIP_PLACEMENT_OPTIONS,
        arrangement.tabStripPlacement,
      );
    case "sidebar":
      return sidebarSummary(values, arrangement);
    case "chat":
      // The area's leading row, the way Task tabs reads its Placement.
      return optionLabel(READING_WIDTH_OPTIONS, arrangement.readingWidth);
    case "composer":
      return composerSummary(values, arrangement);
    case "statusBar":
      return statusBarSummary(values, arrangement);
  }
}

function sidebarSummary(
  values: LayoutValues,
  arrangement: LayoutArrangement,
): string {
  const panels = arrangement.rail.flatMap((entry) =>
    entry.kind === "panel" ? [entry.id] : [],
  );
  const hidden = panels.filter((id) => regionValuesHidden(values[id])).length;
  const count = `${String(panels.length)} panels`;
  return hidden === 0 ? count : `${count} · ${String(hidden)} hidden`;
}

function composerSummary(
  values: LayoutValues,
  arrangement: LayoutArrangement,
): string {
  const shown = arrangement.dock.filter((id) => values[id].shown === "shown");
  if (shown.length === 0) return "Hidden";
  const chips = shown.filter((id) => values[id].size === "chip").length;
  if (chips === shown.length) return "Chips";
  return chips === 0 ? "Full rows" : "Chips and rows";
}

function statusBarSummary(
  values: LayoutValues,
  arrangement: LayoutArrangement,
): string {
  if (values.usageLimits.shown === "shown")
    return optionLabel(BAR_HOST_OPTIONS, arrangement.usageHost);
  if (values.resourceMonitor.shown === "shown")
    return optionLabel(BAR_HOST_OPTIONS, arrangement.resourceHost);
  return "Hidden";
}

function optionLabel(
  options: ReadonlyArray<{ readonly value: string; readonly label: string }>,
  value: string,
): string {
  return options.find((option) => option.value === value)?.label ?? value;
}
