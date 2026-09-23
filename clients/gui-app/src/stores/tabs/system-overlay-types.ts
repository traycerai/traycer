import type { SettingsSectionId } from "@/lib/settings-sections";

export type SystemOverlayKind = "history" | "settings";

export type SystemModalKind = SystemOverlayKind;

export interface SystemModalActive {
  readonly kind: SystemOverlayKind;
  readonly section: SettingsSectionId | null;
}

/**
 * The Auto mode policy section a prepared rule lands in. The four headings the
 * host parses (`Environment`, `Allow`, `Soft deny`, `Hard deny`), spelled as
 * the Permissions ▸ Rules tab keys them.
 */
export type SettingsRuleDraftSection =
  | "environment"
  | "allow"
  | "softDeny"
  | "hardDeny";

/**
 * A rule a surface prepared for the user to review and save, never saved by
 * itself: the Rules tab appends `text` to `section` and leaves the tab dirty.
 */
export interface SettingsRuleDraft {
  readonly section: SettingsRuleDraftSection;
  readonly text: string;
}

export interface OpenSettingsModalOpts {
  readonly section: SettingsSectionId | null;
  readonly resetToGeneral: boolean;
  /**
   * A tab inside `section` to land on, or `null` for the section's own
   * default. A plain string because each page names its own tabs; a page
   * ignores a tab it does not have.
   */
  readonly tab: string | null;
  /** A prepared rule for the Permissions page, or `null`. */
  readonly draft: SettingsRuleDraft | null;
}
