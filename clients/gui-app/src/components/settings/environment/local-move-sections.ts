import type { SettingsSectionId } from "@/lib/settings-sections";

/**
 * The pages a computer that has not moved has none of: a cloud
 * configuration's. Under a Local pick each is an offer to move in place of
 * its panel (`LocalMovePageOr`).
 */
const LOCAL_MOVE_SECTIONS = [
  "mcp-servers",
  "skills",
  "sandboxes",
  "storage",
] as const satisfies readonly SettingsSectionId[];

export type LocalMoveSection = (typeof LOCAL_MOVE_SECTIONS)[number];

/** Whether a Local pick shows `section` as the move offer rather than its panel. */
export function isLocalMovePageSection(
  section: SettingsSectionId,
): section is LocalMoveSection {
  return LOCAL_MOVE_SECTIONS.some((entry) => entry === section);
}
