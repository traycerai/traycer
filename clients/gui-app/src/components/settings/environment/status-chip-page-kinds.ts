import { personalPageItemKinds } from "@/components/settings/personal/personal-page-status";
import type { SettingsSectionId } from "@/lib/settings-sections";

const ADDITIONAL_PAGE_KINDS: Readonly<
  Partial<Record<SettingsSectionId, ReadonlySet<string>>>
> = {
  permissions: new Set(["auto_policy", "browser_agent_access"]),
  "agent-memories": new Set(["agent_memory"]),
  secrets: new Set(["secret"]),
  members: new Set(["member"]),
};

/**
 * Kinds no chip and no count reports: a configuration's sandbox defaults,
 * storage policy and snapshot policy change nothing on a host (every host
 * answers them applied), and neither Sandboxes nor Storage, where they are
 * set, carries a chip.
 */
const UNREPORTED_ITEM_KINDS: ReadonlySet<string> = new Set([
  "sandbox_defaults",
  "storage_policy",
  "snapshot_policy",
]);

export function chipPageKinds(
  section: SettingsSectionId,
): ReadonlySet<string> | null {
  return ADDITIONAL_PAGE_KINDS[section] ?? personalPageItemKinds(section);
}

/** Whether an item of `kind` counts toward any host's delivery status. */
export function isReportedItemKind(kind: string): boolean {
  return !UNREPORTED_ITEM_KINDS.has(kind);
}

/** Whether a page's chip reports `kind`; `null` kinds is every reported kind. */
export function chipReportsKind(
  kinds: ReadonlySet<string> | null,
  kind: string,
): boolean {
  return kinds === null ? isReportedItemKind(kind) : kinds.has(kind);
}
