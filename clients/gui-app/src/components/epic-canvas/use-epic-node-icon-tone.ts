import type { CSSProperties } from "react";
import type { EpicNodeKind } from "@/lib/artifacts/node-display";
import { useSettingsStore } from "@/stores/settings/settings-store";

/**
 * The tint Settings ▸ Appearance gives a node kind's static glyph: the
 * per-type colour under `byType`, the muted class under `none`.
 *
 * The colour travels as a custom property rather than as `color`, the same way
 * every other site that resolves this setting does (`useNodeIconDisplay`, the
 * add-node dropdown, the artifact child index, the view menu, the colour
 * picker, the file icons). Two idioms for one concept is how a setting ends up
 * half-applied, and a literal in `--swatch` still fails `no-inline-styles`
 * where a literal in `color` would not.
 *
 * Its own module rather than a second export of `epic-node-tab-icon.tsx`
 * (fast refresh wants that file to export components only), and a hook rather
 * than only `StaticEpicNodeIcon` so a surface that cannot render that
 * component - Home's agent rows, which need their own glyph for an unknown
 * surface and their own data attributes - still follows the one rule the tab
 * strip and the sidebars follow. The regression it guards against is an icon
 * column whose colour encodes which SURFACE drew it rather than what kind of
 * node it is.
 *
 * `null` is a node with no kind established, and it is muted in every mode: a
 * placeholder glyph has no type to take a colour from.
 */
export function useEpicNodeIconTone(type: EpicNodeKind | null): {
  readonly className: string;
  readonly style: CSSProperties | undefined;
} {
  const colorMode = useSettingsStore((s) => s.artifactIconColorMode);
  const color = useSettingsStore((s) =>
    type === null ? null : s.artifactIconColors[type],
  );
  if (color === null || colorMode === "none") {
    return { className: "text-muted-foreground", style: undefined };
  }
  return {
    className: "text-[var(--swatch)]",
    style: { "--swatch": color } as CSSProperties,
  };
}
