import type { ReactNode } from "react";
import { useLayoutHotspot } from "@/components/customize/use-layout-hotspot";
import { useComposerTileId } from "@/components/home/composer/composer-tile-hooks";
import { UNAVAILABLE_DASH } from "@/lib/resources/memory-metric";

/**
 * Order-only toolbar tile: the active harness's name, so `composer.harness`
 * has a real element in the strip to reorder. No visibility toggle - the
 * catalog entry says "Move rows only" because there is nothing to hide here
 * that the model chip does not already carry; this exists to give that
 * ordering slot a place to render.
 */
export function ComposerHarnessLabel(props: {
  readonly label: string | null;
}): ReactNode {
  const tileId = useComposerTileId();
  const { ref } = useLayoutHotspot({
    settingId: "composer.harness",
    tileId,
    ghost: false,
    condition: null,
  });
  return (
    <span
      ref={ref}
      className="hidden shrink-0 truncate px-1 text-ui-xs text-muted-foreground/70 lg:inline-block"
    >
      {props.label ?? UNAVAILABLE_DASH}
    </span>
  );
}
