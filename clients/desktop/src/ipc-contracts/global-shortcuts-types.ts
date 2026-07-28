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

/**
 * Wire snapshot pushed to every window on `globalShortcutsChange` and
 * returned by `globalShortcutsGetSnapshot`. `sequence` guards against an
 * out-of-order frame overwriting a newer one in the renderer's store, the
 * same monotonic pattern `DesktopAppUpdateSnapshot` uses.
 */
export interface GlobalShortcutsSnapshot {
  readonly sequence: number;
  readonly statuses: Readonly<Record<GlobalShortcutId, GlobalShortcutStatus>>;
}
