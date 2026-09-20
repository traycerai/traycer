import { useEpicViewTabId } from "@/components/epic-canvas/view-tab-context";
import { usePaneVisible } from "@/components/epic-tabs/pane-visibility-context";
import { useCustomizeStore } from "@/stores/customize/customize-store";

/** Surface geometry only; the overlay registers its matching DnD destination. */
export function CustomizeDropSlot({
  id,
  group,
  tileId,
  className,
}: {
  id: string;
  group: string;
  tileId: string | null;
  className: string;
}) {
  const editing = useCustomizeStore((state) => state.session !== null);
  const sceneId = useEpicViewTabId() ?? "shell";
  const visible = usePaneVisible();
  if (!editing || !visible) return null;
  return (
    <span
      data-customize-drop-slot={`${id}@${sceneId}:${tileId ?? "-"}`}
      data-customize-drop-group={group}
      data-customize-drop-tile={tileId ?? undefined}
      className={className}
    />
  );
}
