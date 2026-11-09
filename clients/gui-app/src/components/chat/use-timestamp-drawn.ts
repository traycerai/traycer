import { useRegionGhost } from "@/components/layout-editor/use-layout-region";
import { useRegionShown } from "@/lib/layout-overrides";
import { hasRenderableMessageTime } from "@/lib/relative-time";

/**
 * Whether `ChatMessageTimestamp` draws anything for `timestamp`: the
 * Timestamps region is shown, or ghosted while the editor points at it
 * (L-14), and the instant names a time. A control wrapped around the stamp
 * reads this so it is never drawn around nothing.
 */
export function useTimestampDrawn(timestamp: number): boolean {
  const shown = useRegionShown("timestamps");
  const ghost = useRegionGhost("timestamps");
  return (shown || ghost) && hasRenderableMessageTime(timestamp);
}
