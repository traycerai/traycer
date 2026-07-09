import {
  devDesktopSlotProtocolScheme,
  sanitizeDevDesktopSlot,
} from "@traycer-clients/shared/platform/dev-desktop-slot";
import { DESKTOP_PROTOCOL_SCHEME, DESKTOP_SIGN_IN_BASE_URL } from "../config";

// The renderer has no `process.env`, so multi-run dev threads the slot in via
// Vite (`VITE_DEV_DESKTOP_SLOT`, forwarded from `DEV_DESKTOP_SLOT` by
// `scripts/dev/dev-stack.cjs`). Absent everywhere else - packaged builds and
// no-slot dev - so those keep the base scheme. Sanitized with the shared
// canonical rules so this derivation can never disagree with the main
// process's registration in `electron-main/auth/deep-link.ts`.
function rendererProtocolScheme(): string {
  const raw = import.meta.env.VITE_DEV_DESKTOP_SLOT;
  if (typeof raw !== "string") return DESKTOP_PROTOCOL_SCHEME;
  const slot = sanitizeDevDesktopSlot(raw);
  if (slot.length === 0) return DESKTOP_PROTOCOL_SCHEME;
  return devDesktopSlotProtocolScheme(DESKTOP_PROTOCOL_SCHEME, slot);
}

// The cloud redirects the browser to this exact URI; its scheme must match the
// one this build registers (`DESKTOP_PROTOCOL_SCHEME`, slot-suffixed under
// multi-run dev) so the OS opens THIS app, not a sibling install or sibling
// dev run sharing a scheme.
export const DESKTOP_REDIRECT_URI = `${rendererProtocolScheme()}://auth/callback`;

/**
 * Compose the desktop sign-in URL by appending the deep-link redirect to the
 * source-controlled Cloud UI base URL (`DESKTOP_SIGN_IN_BASE_URL`, from
 * `config`). `environment` decides which deployment we're pointed at.
 */
export function composeDesktopSignInUrl(redirectUri: string): string {
  const signInBaseUrl = DESKTOP_SIGN_IN_BASE_URL;
  const separator = signInBaseUrl.includes("?") ? "&" : "?";
  return `${signInBaseUrl}${separator}redirect_uri=${encodeURIComponent(
    redirectUri,
  )}`;
}
