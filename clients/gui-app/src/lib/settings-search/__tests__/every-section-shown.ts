import type { SettingsSectionId } from "@/lib/settings-sections";

/** A pick that hides no Environment row: the search sees every section. */
export function everySectionShown(_section: SettingsSectionId): boolean {
  return true;
}
