import type { BrowserCookieCryptoState } from "@traycer-clients/shared/platform/browser-view";

export function browserCookieDegradedMessage(
  cryptoState: BrowserCookieCryptoState,
  inAppBrowserBetaEnabled: boolean,
): string {
  if (cryptoState.reason === "mock-keychain") {
    return inAppBrowserBetaEnabled
      ? "Logins in this browser are temporary until Traycer restarts. Restart Traycer to apply the in-app browser setting and enable persistent logins."
      : 'Logins in this browser are temporary. Enable "In-app browser (beta)" in Settings, then restart Traycer, for persistent logins.';
  }
  if (cryptoState.reason === "keychain-denied") {
    return "Logins in this browser are temporary for this session. Choose Always Allow for Traycer Safe Storage on the next launch to keep persistent logins.";
  }
  return "Logins in this browser are temporary for this session because secure cookie storage is unavailable.";
}
