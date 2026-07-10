// Re-exported from the shared canonical implementation so Desktop and the
// CLI can never resolve a slot to different paths/labels - see
// `@traycer-clients/shared/platform/dev-desktop-slot` for the sanitization
// rules both sides must agree on byte-for-byte.
export {
  DEV_DESKTOP_SLOT_ENV,
  sanitizeDevDesktopSlot,
  devDesktopSlotForEnvironment,
  devDesktopSlotProtocolScheme,
} from "@traycer-clients/shared/platform/dev-desktop-slot";
