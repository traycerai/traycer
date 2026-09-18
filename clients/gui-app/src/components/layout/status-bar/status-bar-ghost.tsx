import type { ReactNode } from "react";
import { useLayoutHotspot } from "@/components/customize/use-layout-hotspot";

/**
 * Reserves the strip's slot while `placement` is `header`, so the row that
 * would carry the usage cluster is still a click away during a Customize
 * session. Renders nothing outside one - `useLayoutHotspot` only registers
 * (and this only draws) while `editing` is true.
 */
export function StatusBarGhost(): ReactNode {
  const { ref, editing } = useLayoutHotspot({
    settingId: "statusBar.placement",
    tileId: null,
    ghost: true,
    condition: "Usage is placed in the header",
  });
  if (!editing) return null;
  return (
    <div
      ref={ref}
      data-testid="status-bar-ghost"
      aria-hidden
      className="h-6 shrink-0 border-t border-dashed border-border/60 bg-canvas/60 pb-safe-bottom"
    />
  );
}
