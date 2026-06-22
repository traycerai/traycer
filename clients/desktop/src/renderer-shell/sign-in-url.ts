import { DESKTOP_PROTOCOL_SCHEME, DESKTOP_SIGN_IN_BASE_URL } from "../config";

// The cloud redirects the browser to this exact URI; its scheme must match the
// one this build registers (`DESKTOP_PROTOCOL_SCHEME`) so the OS opens THIS app,
// not a sibling install sharing `traycer://`.
export const DESKTOP_REDIRECT_URI = `${DESKTOP_PROTOCOL_SCHEME}://auth/callback`;

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
