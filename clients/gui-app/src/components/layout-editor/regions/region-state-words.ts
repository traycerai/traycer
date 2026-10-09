import {
  barPlacement,
  sideTabStripEdge,
  type BarRegionId,
  type EdgeSide,
  type LayoutArrangement,
} from "@/lib/layout/layout-arrangement";
import type {
  AccessValues,
  ContextUsageValues,
  ModelValues,
  AutoRailValues,
  ShownValues,
  SizedValues,
  ToolActivityValues,
} from "@/lib/layout/layout-values";
import type { LayoutFacts } from "@/components/layout-editor/regions/row-availability";

/**
 * The one word each region's row reads out beside its name (L-33, L-47).
 *
 * One per value SHAPE rather than one per region: of the twenty-six regions
 * nine are the rail's three-state and five are the Full row / Chip pair (the
 * dock members), so the tables beside this file point several regions at the
 * same function.
 */

export function shownStateWord(values: ShownValues): string {
  return values.shown === "shown" ? "Shown" : "Hidden";
}

/**
 * The microphone's word: a shown mic does nothing while General > Voice input
 * is off, which is what its row says too (C4).
 */
export function micStateWord(
  values: ShownValues,
  _arrangement: LayoutArrangement,
  facts: LayoutFacts,
): string {
  if (values.shown === "shown" && !facts.voiceInputEnabled) {
    return "Voice input off";
  }
  return shownStateWord(values);
}

export function sizedStateWord(values: SizedValues): string {
  if (values.shown === "hidden") return "Hidden";
  return values.size === "chip" ? "Chip" : "Full row";
}

/** A transcript row's default: `full` opens it, `chip` folds it. */
export function toolActivityStateWord(values: ToolActivityValues): string {
  return values.size === "full" ? "Open" : "Closed";
}

export function thinkingStateWord(values: SizedValues): string {
  if (values.shown === "hidden") return "Hidden";
  return values.size === "full" ? "Open" : "Closed";
}

/** The Access pill's size; it has no Hidden (G6). */
export function accessStateWord(values: AccessValues): string {
  return values.size === "chip" ? "Icon only" : "Icon and label";
}

export function sideStateWord(values: ShownValues, side: EdgeSide): string {
  if (values.shown === "hidden") return "Hidden";
  return side === "left" ? "Left" : "Right";
}

export function railStateWord(values: AutoRailValues | ShownValues): string {
  if (values.shown === "auto") return "Auto";
  return values.shown === "shown" ? "Shown" : "Hidden";
}

/**
 * Both halves of where a bar reading sits, in one phrase: "Tab strip, right"
 * (L-156).
 *
 * One word per axis would leave the index row saying "Tab strip" while the
 * region is drawn at the other end of it, which is half an answer to the only
 * question the row is asked.
 *
 * The header host is named for the tab strip in every placement; while the
 * stored placement is vertical the readings stack in the strip's foot, where
 * the stored `left` / `right` read as "start" / "end".
 */
export function barPlacementStateWord(
  values: ShownValues,
  arrangement: LayoutArrangement,
  region: BarRegionId,
): string {
  if (values.shown === "hidden") return "Hidden";
  const placement = barPlacement(arrangement, region);
  if (placement.host === "status-bar") return `Status bar, ${placement.side}`;
  if (sideTabStripEdge(arrangement.tabStripPlacement) === null) {
    return `Tab strip, ${placement.side}`;
  }
  return `Tab strip, ${placement.side === "left" ? "start" : "end"}`;
}

/**
 * Pinned before the style: the pinned strip never reads the chip's style
 * (C1), so naming one while the breakdown is pinned names nothing on screen.
 */
export function contextUsageStateWord(values: ContextUsageValues): string {
  if (values.shown === "hidden") return "Hidden";
  if (values.pinBreakdown) return "Pinned";
  if (values.style === "text") return "Text";
  return values.style === "ring" ? "Ring and number" : "Ring only";
}

export function modelStateWord(values: ModelValues): string {
  if (values.style === "text") return "Text";
  return values.style === "bars" ? "Bars" : "Bars and text";
}
