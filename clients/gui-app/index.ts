export { TraycerApp, type TraycerAppProps } from "@/traycer-app";
export {
  isMobileApp,
  setMobileApp,
  setMobileAppPlatform,
} from "@/lib/mobile-app";
export {
  DESKTOP_RETENTION_PROFILE,
  MOBILE_RETENTION_PROFILE,
  setRetentionProfile,
  type RetentionProfile,
} from "@/stores/replica-memory/retention-profile";
export { setNativeKeyboardState } from "@/lib/native-keyboard";
export {
  hostRpcRegistry,
  type HostRpcRegistry,
  type MessengerFactory,
} from "@/lib/host";
export {
  installTitleBarOverlayThemeSync,
  type TitleBarOverlaySink,
} from "@/lib/title-bar-overlay-theme";
