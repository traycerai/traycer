import { app, safeStorage } from "electron";
import type {
  BrowserCookieCryptoReason,
  BrowserCookieCryptoState,
  BrowserCookieStorageBackend,
} from "../../ipc-contracts/browser-view-types";
import { log } from "../app/logger";

export interface BrowserCookieCryptoDetectionInput {
  readonly platform: NodeJS.Platform | string;
  readonly encryptionAvailable: boolean;
  readonly selectedStorageBackend: BrowserCookieStorageBackend;
  readonly mockKeychainEnabled: boolean;
}

let resolvedState: BrowserCookieCryptoState | null = null;

export function shouldUseMockKeychain(input: {
  readonly inAppBrowserBetaEnabled: boolean;
}): boolean {
  return !input.inAppBrowserBetaEnabled;
}

export function resolveBrowserCookieCryptoStateFromInputs(
  input: BrowserCookieCryptoDetectionInput,
): BrowserCookieCryptoState {
  if (input.mockKeychainEnabled) {
    return buildState(input, "degraded", "mock-keychain");
  }
  if (!input.encryptionAvailable) {
    return buildState(
      input,
      "degraded",
      input.platform === "darwin"
        ? "keychain-denied"
        : "encryption-unavailable",
    );
  }
  if (
    input.platform === "linux" &&
    input.selectedStorageBackend === "basic_text"
  ) {
    return buildState(input, "basic", "linux-basic-text");
  }
  return buildState(input, "real", "os-backed");
}

export function resolveBrowserCookieCryptoStateAtReady(): BrowserCookieCryptoState {
  const state = resolveBrowserCookieCryptoStateFromInputs({
    platform: process.platform,
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
    selectedStorageBackend: readSelectedStorageBackend(),
    mockKeychainEnabled: app.commandLine.hasSwitch("use-mock-keychain"),
  });
  resolvedState = state;
  log.info("[browser-view] cookie crypto mode resolved", {
    mode: state.mode,
    persistence: state.persistence,
    reason: state.reason,
    storageBackend: state.storageBackend,
    encryptionAvailable: state.encryptionAvailable,
    mockKeychainEnabled: state.mockKeychainEnabled,
  });
  if (state.reason === "mock-keychain") {
    log.warn("[browser-view] cookie store downgrade detected", {
      reason: state.reason,
      persistence: state.persistence,
      message:
        "Persistent browser cookies from real encryption mode may be unreadable; using an ephemeral browser partition for this run.",
    });
  } else if (state.mode === "degraded") {
    log.warn("[browser-view] cookie persistence disabled", {
      reason: state.reason,
      persistence: state.persistence,
    });
  }
  return state;
}

export function getBrowserCookieCryptoState(): BrowserCookieCryptoState {
  return (
    resolvedState ?? {
      mode: "degraded",
      persistence: "ephemeral",
      reason: "unresolved",
      storageBackend: null,
      encryptionAvailable: false,
      mockKeychainEnabled: false,
    }
  );
}

export function setBrowserCookieCryptoStateForTests(
  state: BrowserCookieCryptoState,
): void {
  resolvedState = state;
}

function buildState(
  input: BrowserCookieCryptoDetectionInput,
  mode: BrowserCookieCryptoState["mode"],
  reason: BrowserCookieCryptoReason,
): BrowserCookieCryptoState {
  return {
    mode,
    persistence: mode === "degraded" ? "ephemeral" : "persistent",
    reason,
    storageBackend: input.selectedStorageBackend,
    encryptionAvailable: input.encryptionAvailable,
    mockKeychainEnabled: input.mockKeychainEnabled,
  };
}

function readSelectedStorageBackend(): BrowserCookieStorageBackend {
  if (process.platform !== "linux") return null;
  return safeStorage.getSelectedStorageBackend();
}
