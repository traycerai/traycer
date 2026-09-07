import {
  CURRENT_CLIENT_COMPATIBILITY_EPOCH,
  type FirstPartyClientIdentity,
} from "@traycer/protocol/framework/index";
import { getClientAppVersion } from "@/lib/app-version";
import { isMobileApp } from "@/lib/mobile-app";

/** The deterministic diagnostic version a DEVELOPMENT renderer reports. */
export const LOCAL_CLIENT_APP_VERSION = "0.0.0-local";

/**
 * THE GUI's client identity - one reviewed value, read by every transport this renderer builds (local unary, local stream, remote mux).
 */
export function getGuiClientIdentity(): FirstPartyClientIdentity {
  return {
    kind: isMobileApp() ? "mobile" : "desktop",
    compatibilityEpoch: CURRENT_CLIENT_COMPATIBILITY_EPOCH,
    appVersion:
      getClientAppVersion() ??
      (import.meta.env.DEV ? LOCAL_CLIENT_APP_VERSION : null),
  };
}
