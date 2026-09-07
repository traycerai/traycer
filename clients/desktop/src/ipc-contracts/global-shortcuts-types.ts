import type {
  GlobalShortcutId,
  GlobalShortcutStatus,
} from "@traycer-clients/shared/keybindings/global-shortcuts";

export type {
  GlobalShortcutId,
  GlobalShortcutIntent,
  GlobalShortcutRegistrationStatus,
  GlobalShortcutStatus,
} from "@traycer-clients/shared/keybindings/global-shortcuts";
export {
  GLOBAL_SHORTCUT_DEFAULT_CHORDS,
  GLOBAL_SHORTCUT_IDS,
} from "@traycer-clients/shared/keybindings/global-shortcuts";

export interface GlobalShortcutsSnapshot {
  readonly sequence: number;
  readonly statuses: Readonly<Record<GlobalShortcutId, GlobalShortcutStatus>>;
}
