import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";

/** Shared by every read-only host surface with a Settings cta, rather than copied per popover: two
 * implementations of one rule is how one of them silently stops matching the other. */
export function carryViewedHostIntoSettingsScope(
  displayedHostId: string | null,
): void {
  if (displayedHostId === null) return;
  useSettingsHostScopeStore.getState().setScopedHostId(displayedHostId);
}
