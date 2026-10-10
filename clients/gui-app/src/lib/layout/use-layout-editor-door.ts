import { useSettingsAvailabilityContext } from "@/hooks/settings/use-settings-availability-context";
import { isLayoutEditorAvailable } from "@/lib/settings/settings-availability";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";

/**
 * What a door that names the editor offers right now (T6), asked once by every
 * such door - the palette's row, the chrome's menu item and the Settings
 * button - so no two can disagree:
 *
 * - `absent`: this shell can never open the editor (the installed app), so the
 *   door names Layout settings instead, or nothing;
 * - `held-elsewhere`: another window holds the lease (L-32), so the door is
 *   disabled and says `LAYOUT_EDITOR_HELD_ELSEWHERE_REASON`;
 * - `open`: pressing it opens the editor, or the width gate's redirect.
 *
 * `lockedBy` is kept current by the lease watcher the editor shell runs for
 * the window's whole life (`layout-editor.tsx`).
 */
export type LayoutEditorDoor = "absent" | "held-elsewhere" | "open";

export function useLayoutEditorDoor(): LayoutEditorDoor {
  const availability = useSettingsAvailabilityContext();
  const heldElsewhere = useLayoutEditorStore(
    (state) => state.lockedBy === "other-window",
  );
  if (!isLayoutEditorAvailable(availability)) return "absent";
  return heldElsewhere ? "held-elsewhere" : "open";
}
