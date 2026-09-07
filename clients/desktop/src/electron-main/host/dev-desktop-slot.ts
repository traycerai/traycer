// Re-exported from the shared canonical implementation so Desktop and the CLI can never resolve a slot to different paths/labels.
export {
  DEV_DESKTOP_SLOT_ENV,
  sanitizeDevDesktopSlot,
  devDesktopSlotForEnvironment,
  devDesktopSlotProtocolScheme,
} from "@traycer-clients/shared/platform/dev-desktop-slot";
