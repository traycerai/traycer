import type {
  BrowserCookieCryptoState,
  BrowserPersistenceState,
} from "@traycer-clients/shared/platform/browser-view";

export function browserCookieDegradedMessage(
  cryptoState: BrowserCookieCryptoState,
): string {
  if (cryptoState.reason === "not-enabled") {
    return "Logins aren't saved yet. Enable saved logins from the shield to keep them.";
  }
  if (cryptoState.reason === "keychain-denied") {
    return "Logins in this browser are temporary for this session. Choose Always Allow for Traycer Safe Storage on the next launch to keep persistent logins.";
  }
  return "Logins in this browser are temporary for this session because secure cookie storage is unavailable.";
}

/**
 * The one affordance the shield offers, per spec §7.1. `relaunch` exists
 * because Chromium caches a macOS keychain denial for the life of the process:
 * retrying in-process would fail silently forever (decision #23).
 */
export type BrowserPersistenceShieldAction =
  | { readonly kind: "none" }
  | { readonly kind: "enable"; readonly label: string }
  | { readonly kind: "relaunch"; readonly label: string }
  | { readonly kind: "settings"; readonly label: string };

export type BrowserPersistenceShieldTone = "secure" | "off" | "warning";

export interface BrowserPersistenceShieldCopy {
  readonly tone: BrowserPersistenceShieldTone;
  readonly headline: string;
  readonly detail: string;
  readonly action: BrowserPersistenceShieldAction;
}

/**
 * Spec §7.1's states table, in one place so the shield, its tooltip and its
 * accessible label can never describe different states.
 */
export function browserPersistenceShieldCopy(
  state: BrowserPersistenceState,
): BrowserPersistenceShieldCopy {
  const reason = state.cryptoState.reason;
  if (reason === "os-backed") {
    return {
      tone: "secure",
      headline: "Logins saved securely",
      detail: `Cookies and saved logins are encrypted by ${keystoreName(state)}, so agents can reuse the sites you're signed into.`,
      action: { kind: "settings", label: "Settings › Browser" },
    };
  }
  if (reason === "keychain-denied") {
    return {
      tone: "warning",
      headline: "Traycer couldn't use your keychain",
      detail:
        state.decision.kind === "relaunch-pending"
          ? "Your system cached the denial for this run. Restart Traycer and choose Always Allow to save logins."
          : "Logins are temporary until Traycer can use the keychain. Choose Always Allow when your system asks.",
      action:
        state.decision.kind === "relaunch-pending"
          ? { kind: "relaunch", label: "Restart Traycer" }
          : { kind: "enable", label: "Try again" },
    };
  }
  if (reason === "linux-basic-text" || reason === "encryption-unavailable") {
    return {
      tone: "warning",
      headline: "No secure keyring found",
      detail:
        "This machine has no OS keystore Traycer can encrypt cookies with, so browser logins last only for this session.",
      action: { kind: "none" },
    };
  }
  return {
    tone: "off",
    headline: "Logins aren't saved yet",
    detail: `Turn this on and Traycer keeps website logins in ${keystoreName(state)} so agents can reuse them.`,
    action: { kind: "enable", label: "Enable saved logins" },
  };
}

/** The keystore, named the way the user's own OS names it. */
export function keystoreName(state: BrowserPersistenceState): string {
  if (state.platform === "darwin") return "your macOS Keychain";
  if (state.platform === "win32") return "Windows Credential Manager";
  if (state.platform === "linux") return "your system keyring";
  return "your system keystore";
}
