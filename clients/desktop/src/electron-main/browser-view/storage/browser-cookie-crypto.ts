import { safeStorage } from "electron";
import type {
  BrowserCookieCryptoReason,
  BrowserCookieCryptoState,
  BrowserCookieStorageBackend,
} from "@traycer-clients/shared/platform/browser-view";
import { log } from "../../app/logger";

export interface BrowserCookieCryptoDetectionInput {
  readonly platform: NodeJS.Platform | string;
  readonly encryptionAvailable: boolean;
  readonly selectedStorageBackend: BrowserCookieStorageBackend;
}

let resolvedState: BrowserCookieCryptoState | null = null;

export function resolveBrowserCookieCryptoStateFromInputs(
  input: BrowserCookieCryptoDetectionInput,
): BrowserCookieCryptoState {
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
  });
  resolvedState = state;
  log.info("[browser-view] cookie crypto mode resolved", {
    mode: state.mode,
    persistence: state.persistence,
    reason: state.reason,
    storageBackend: state.storageBackend,
    encryptionAvailable: state.encryptionAvailable,
  });
  if (state.mode === "degraded") {
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
    }
  );
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
  };
}

function readSelectedStorageBackend(): BrowserCookieStorageBackend {
  if (process.platform !== "linux") return null;
  return safeStorage.getSelectedStorageBackend();
}
