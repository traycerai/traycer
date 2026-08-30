import type { BrowserCookieCryptoState } from "@traycer-clients/shared/platform/browser-view";

export function browserCookieDegradedMessage(
  cryptoState: BrowserCookieCryptoState,
): string {
  if (cryptoState.reason === "keychain-denied") {
    return "Logins in this browser are temporary for this session. Choose Always Allow for Traycer Safe Storage on the next launch to keep persistent logins.";
  }
  return "Logins in this browser are temporary for this session because secure cookie storage is unavailable.";
}
