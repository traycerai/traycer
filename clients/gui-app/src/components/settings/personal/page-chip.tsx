import type { ReactNode } from "react";
import type { EnvironmentPick } from "@/lib/settings-environment-pages";
import type { SettingsSectionId } from "@/lib/settings-sections";

/**
 * STUB (P3 replaces its body): the status chip
 * under an Environment page's title, for the configuration `pick` names.
 * Drawn by the page frame on every Environment page. Renders nothing until
 * filled.
 */
export interface PageChipProps {
  readonly section: SettingsSectionId;
  readonly pick: EnvironmentPick;
}

export function PageChip(_props: PageChipProps): ReactNode {
  return null;
}
