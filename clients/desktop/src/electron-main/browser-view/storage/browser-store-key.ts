import { safeStorage } from "electron";
import type { BrowserCookieCryptoReason } from "@traycer-clients/shared/platform/browser-view";
import { getBrowserCookieCryptoState } from "./browser-cookie-crypto";

/**
 * The desktop half of the host's store-key handshake (spec §6.2, ticket 05).
 *
 * The host mints the per-user key that encrypts its primary-profile store and
 * asks this machine to hold it: `wrapStoreKey` seals it with the same OS
 * keystore Chromium's own cookie jar uses, `unwrapStoreKey` opens it again on
 * every later connect. Nothing is written here - the wrapped blob lives on the
 * host, which cannot open it.
 *
 * Both calls refuse unless the persistence state machine has already resolved
 * to a real, OS-backed keystore. That is what keeps the invariant ticket 01
 * bought: `safeStorage` is touched only after the user consented on this
 * machine, so neither call can raise the first, uncontextualised OS prompt.
 */

/** The keystore is not (or no longer) usable, so no key may be wrapped. */
export class BrowserStoreKeyUnavailableError extends Error {
  readonly reason: BrowserCookieCryptoReason;

  constructor(reason: BrowserCookieCryptoReason) {
    super(`browser store key is unavailable: ${reason}`);
    this.name = "BrowserStoreKeyUnavailableError";
    this.reason = reason;
  }
}

/**
 * `safeStorage.encryptString(rawKey)`, base64 for the wire. The host sends the
 * raw key as base64 text and gets that exact text back from `unwrapStoreKey`.
 */
export function wrapStoreKey(rawKeyBase64: string): string {
  assertOsBackedKeystore();
  return safeStorage.encryptString(rawKeyBase64).toString("base64");
}

/** `safeStorage.decryptString(blob)`; throws when this machine cannot open it. */
export function unwrapStoreKey(wrappedKeyBase64: string): string {
  assertOsBackedKeystore();
  return safeStorage.decryptString(Buffer.from(wrappedKeyBase64, "base64"));
}

function assertOsBackedKeystore(): void {
  const state = getBrowserCookieCryptoState();
  // `persistent` alone would also admit a state that never probed; the reason
  // is what says the probe ran and the OS answered with a real backend.
  if (state.persistence !== "persistent" || state.reason !== "os-backed") {
    throw new BrowserStoreKeyUnavailableError(state.reason);
  }
}
