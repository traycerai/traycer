import type { CSSProperties } from "react";
import type { EpicNodeKind } from "@/lib/artifacts/node-display";
import { useSettingsStore } from "@/stores/settings/settings-store";

/**
 * The tint Settings ▸ Appearance gives a node kind's static glyph: the
 * per-type colour as an inline style under `byType`, the muted class under
 * `none`.
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
  readonly className: string | false;
  readonly style: CSSProperties | undefined;
} {
  const colorMode = useSettingsStore((s) => s.artifactIconColorMode);
  const color = useSettingsStore((s) =>
    type === null ? null : s.artifactIconColors[type],
  );
  if (color === null || colorMode === "none") {
    return { className: "text-muted-foreground", style: undefined };
  }
  return { className: false, style: { color } };
}
