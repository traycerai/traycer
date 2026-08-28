import type { CSSProperties } from "react";
import { describe, expect, it } from "vitest";
import {
  GIT_PANEL_PIERRE_FILE_TREE_THEME_STYLE,
  PIERRE_FILE_TREE_THEME_STYLE,
} from "@/components/epic-canvas/pierre-tree-theme";

/**
 * `@pierre/trees` paints `--trees-bg` on its list container, on every row and
 * on the sticky-header overlay, so that value has to be the surface the tree is
 * mounted on. It used to be the literal `var(--background)`, which is the
 * desktop sidebar's surface and therefore invisible there - and a visible slab
 * of the wrong colour anywhere else, which is what the mobile switcher sheet
 * (`bg-popover`) showed.
 *
 * Both halves are asserted because each one alone is satisfiable by a wrong
 * value: the indirection without the fallback would change desktop, and the
 * fallback without the indirection would leave the sheet broken.
 */
describe("Pierre file-tree theme surface", () => {
  // The overrides are CSS custom properties, which `CSSProperties` has no index
  // signature for - so read them off the entries rather than by key.
  const read = (style: CSSProperties): string | null => {
    const entry = Object.entries(style).find(
      ([name]) => name === "--trees-bg-override",
    );
    return entry === undefined ? null : String(entry[1]);
  };

  it("takes its background from the host-declared surface", () => {
    expect(String(read(PIERRE_FILE_TREE_THEME_STYLE))).toContain(
      "var(--pierre-tree-surface",
    );
  });

  it("falls back to the desktop sidebar's surface when no host declares one", () => {
    // Desktop mounts the tree in a `bg-background` column and declares nothing,
    // so this fallback is what keeps it rendering identically.
    expect(String(read(PIERRE_FILE_TREE_THEME_STYLE))).toBe(
      "var(--pierre-tree-surface, var(--background))",
    );
  });

  it("carries the same surface rule into the git panel theme", () => {
    // The git panel spreads the base theme; a future override that hardcoded a
    // colour here would reintroduce the slab on that mount alone.
    expect(read(GIT_PANEL_PIERRE_FILE_TREE_THEME_STYLE)).toBe(
      read(PIERRE_FILE_TREE_THEME_STYLE),
    );
  });
});
