import { personalPageItemKinds } from "@/components/settings/personal/personal-page-status";
import type { SettingsSectionId } from "@/lib/settings-sections";

const ADDITIONAL_PAGE_KINDS: Readonly<
  Partial<Record<SettingsSectionId, ReadonlySet<string>>>
> = {
  permissions: new Set(["auto_policy", "browser_agent_access"]),
  secrets: new Set(["secret"]),
  members: new Set(["member"]),
};

export function chipPageKinds(
  section: SettingsSectionId,
): ReadonlySet<string> | null {
  return ADDITIONAL_PAGE_KINDS[section] ?? personalPageItemKinds(section);
}
