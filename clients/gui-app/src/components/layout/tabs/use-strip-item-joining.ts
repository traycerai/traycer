import { useEpicDndStore } from "@/components/epic-canvas/dnd/dnd-store";
import { useTabsStore } from "@/stores/tabs/store";
import { stripItemGroupId } from "@/stores/tabs/tab-groups";

/**
 * Whether the strip drop under way would newly join the group this strip item
 * is in, so the top bar can brighten the group's outline (its members' colour
 * edge) while a drop will join it.
 */
export function useStripItemJoining(itemId: string | undefined): boolean {
  const joinsGroupId = useEpicDndStore((state) => {
    const drag = state.headerStripDragState;
    return drag?.kind === "reorder" && drag.joinsGroup ? drag.groupId : null;
  });
  const itemGroupId = useTabsStore((state) => {
    if (joinsGroupId === null) return null;
    const item = state.items.find((candidate) => candidate.id === itemId);
    return item === undefined
      ? null
      : stripItemGroupId(item, state.customizations);
  });
  return joinsGroupId !== null && joinsGroupId === itemGroupId;
}
