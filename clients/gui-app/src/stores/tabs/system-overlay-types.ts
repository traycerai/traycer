import type { SettingsSectionId } from "@/lib/settings-sections";

export type SystemOverlayKind = "history" | "settings";

export type SystemModalKind = SystemOverlayKind;

export interface SystemModalActive {
  readonly kind: SystemOverlayKind;
  readonly section: SettingsSectionId | null;
}

export interface OpenSettingsModalOpts {
  readonly section: SettingsSectionId | null;
  readonly resetToGeneral: boolean;
}
