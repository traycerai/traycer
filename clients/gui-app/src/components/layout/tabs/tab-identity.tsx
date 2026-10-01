import type { ReactNode } from "react";
import type { HeaderTabAppearance } from "@/stores/tabs/types";
import { firstGraphemes, tabMonogram } from "./tab-monogram";

/**
 * A task's identity as every surface draws it (the strip's rows and rail
 * tiles, the epic panel's header, the layout editor's depictions): its tile
 * and its colour. `MonogramChip` draws them.
 */

/** The tab colour at 28% over transparency; the colour arrives as `--side-tab-tint`. */
export const SIDE_TAB_TINT_FILL_CLASS =
  "bg-[color-mix(in_oklab,var(--side-tab-tint)_28%,transparent)]";
export const SIDE_TAB_COLORLESS_TILE_CLASS = "bg-foreground/8";
/** The monogram, on a 26x22 chip with a 6px radius. */
export const SIDE_TAB_MONOGRAM_CHIP_CLASS = "h-5.5 w-6.5 rounded-md";
export const SIDE_TAB_MONOGRAM_CLASS = "text-[0.6875rem] font-semibold";
/** A custom icon's glyphs on a 16px tile: one grapheme, or two. */
const SIDE_TAB_CUSTOM_ICON_SINGLE_CLASS = "text-xs leading-none";
const SIDE_TAB_CUSTOM_ICON_PAIR_CLASS = "text-micro font-medium leading-none";

/** What a task's tile shows. */
export type SideTabTile =
  | { readonly kind: "icon"; readonly icon: ReactNode }
  | { readonly kind: "monogram"; readonly text: string }
  | { readonly kind: "generating" };

/**
 * What a task's tile shows (S-17): the custom icon, else the spinner while
 * the title is generating, else the monogram of the resolved title, else
 * `fallback` (the row's status glyph) for a title with no letter or digit.
 * `title` is the resolved title, never the "Untitled" placeholder.
 */
export function sideTabTileOf(input: {
  readonly appearance: HeaderTabAppearance | null;
  readonly title: string;
  readonly titleGenerating: boolean;
  readonly fallback: ReactNode;
}): SideTabTile {
  const icon = firstGraphemes(input.appearance?.icon ?? "", 2);
  if (icon.length > 0) {
    return {
      kind: "icon",
      icon: (
        <span
          aria-hidden
          data-slot="tab-custom-icon"
          className={
            icon.length === 1
              ? SIDE_TAB_CUSTOM_ICON_SINGLE_CLASS
              : SIDE_TAB_CUSTOM_ICON_PAIR_CLASS
          }
        >
          {icon.join("")}
        </span>
      ),
    };
  }
  if (input.titleGenerating) return { kind: "generating" };
  const monogram = tabMonogram(input.title);
  if (monogram !== null) return { kind: "monogram", text: monogram };
  return { kind: "icon", icon: input.fallback };
}

/**
 * The hues an uncoloured task's monogram may take (D11): greens through cyans,
 * then violets through magentas, 15 degrees apart so neighbours stay
 * distinguishable. Amber and red (the status hues) and the info blue that
 * marks unread are left out.
 */
const AUTO_TINT_HUES: ReadonlyArray<number> = [
  125, 140, 155, 170, 185, 200, 280, 295, 310, 325,
];

/** FNV-1a over UTF-16 code units: stable across sessions and machines. */
function hashOf(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * The stable tint of a task with no tab colour (D11): a hue derived from the
 * epic id, lighter in a dark theme than in a light one, as a CSS colour for
 * `--side-tab-tint`. An explicit tab colour always wins over it.
 */
export function tabAutoTint(epicId: string): string {
  const hue = AUTO_TINT_HUES[hashOf(epicId) % AUTO_TINT_HUES.length];
  return `light-dark(oklch(0.6 0.13 ${String(hue)}), oklch(0.72 0.12 ${String(hue)}))`;
}
