import type { SettingsSectionId } from "@/lib/settings-sections";
import { getSystemTabModalApi } from "@/stores/tabs/system-tab-modal-bridge";

/**
 * Move the Settings surface to `sectionId`, whichever surface it is.
 *
 * Settings renders in two places — a modal overlay and a system tab — and a
 * panel has no way to tell which one is hosting it. The modal bridge does:
 * with the overlay up it swaps the section in place, and otherwise
 * `openSettings` focuses an existing settings TAB at that section (or opens
 * the modal if there is none). Callers therefore get correct behaviour in both
 * modes without reaching for router hooks, which the modal — or a unit test —
 * may not have.
 *
 * The keybinding router adapter is currently the ONLY caller. The indirection
 * is what would let a panel navigate correctly from either surface, not a
 * description of panels that already do.
 *
 * No-ops when the bridge has not published an API yet.
 */
export function navigateToSettingsSection(sectionId: SettingsSectionId): void {
  const api = getSystemTabModalApi();
  if (api === null) return;
  if (api.isOverlayActive("settings")) {
    api.setSection(sectionId);
    return;
  }
  api.openSettings({ section: sectionId, resetToGeneral: false });
}
