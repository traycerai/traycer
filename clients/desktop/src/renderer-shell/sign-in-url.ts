import {
  DEV_CLOUD_UI_BASE_URL_ENV,
  devBackendUrlFromEnv,
} from "@traycer-clients/shared/platform/dev-backend-urls";
import {
  devDesktopSlotProtocolScheme,
  sanitizeDevDesktopSlot,
} from "@traycer-clients/shared/platform/dev-desktop-slot";
import { DESKTOP_PROTOCOL_SCHEME, DESKTOP_SIGN_IN_BASE_URL } from "../config";

// Sanitized with the shared canonical rules so this derivation can never disagree with the main process's registration in `electron-main/auth/deep-link.ts`.
function rendererProtocolScheme(): string {
  const raw = import.meta.env.VITE_DEV_DESKTOP_SLOT;
  if (typeof raw !== "string") return DESKTOP_PROTOCOL_SCHEME;
  const slot = sanitizeDevDesktopSlot(raw);
  if (slot.length === 0) return DESKTOP_PROTOCOL_SCHEME;
  return devDesktopSlotProtocolScheme(DESKTOP_PROTOCOL_SCHEME, slot);
}

function rendererSignInBaseUrl(): string {
  const raw = import.meta.env.VITE_DEV_CLOUD_UI_BASE_URL;
  if (!import.meta.env.DEV || typeof raw !== "string" || raw.length === 0) {
    return DESKTOP_SIGN_IN_BASE_URL;
  }
  return devBackendUrlFromEnv(
    "dev",
    DEV_CLOUD_UI_BASE_URL_ENV,
    DESKTOP_SIGN_IN_BASE_URL,
    { [DEV_CLOUD_UI_BASE_URL_ENV]: raw },
  );
}

export const DESKTOP_REDIRECT_URI = `${rendererProtocolScheme()}://auth/callback`;

export function composeDesktopSignInUrl(redirectUri: string): string {
  const signInBaseUrl = rendererSignInBaseUrl();
  const separator = signInBaseUrl.includes("?") ? "&" : "?";
  return `${signInBaseUrl}${separator}redirect_uri=${encodeURIComponent(
    redirectUri,
  )}`;
}
