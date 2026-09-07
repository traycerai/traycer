import { app, safeStorage } from "electron";
import { join } from "node:path";
import { z } from "zod";
import { describeLogError, log } from "../../app/logger";
import {
  createJsonFileStore,
  type StrictJsonFileStore,
} from "../../app/json-file-store";
import {
  initBrowserStoreKeyLedger,
  isWrappedStoreKeyOurs,
  recordWrappedStoreKey,
} from "./browser-store-key-ledger";

/**
 * The pref is a statement about the machine, not the Traycer account, so it lives in desktop userData and never travels to the host.
 * This is a new file name, so the four-state decision file it replaces is never read: a machine that had declined saved logins gets them, which is what "always on, Chrome-style".
 */
const SAVED_LOGINS_FILE_NAME = "browser-saved-logins.json";

const recordSchema = z.strictObject({ saveLogins: z.boolean() });
type SavedLoginsRecord = z.infer<typeof recordSchema>;

const DEFAULT_RECORD: SavedLoginsRecord = { saveLogins: true };

function createSavedLoginsStore(
  filePath: string,
): StrictJsonFileStore<SavedLoginsRecord> {
  return createJsonFileStore<SavedLoginsRecord>(
    filePath,
    DEFAULT_RECORD,
    (value) => recordSchema.safeParse(value).data ?? DEFAULT_RECORD,
  );
}

let store: StrictJsonFileStore<SavedLoginsRecord> | null = null;
let saveLogins = true;

export function browserSavedLoginsFilePath(): string {
  return join(app.getPath("userData"), SAVED_LOGINS_FILE_NAME);
}

/** `on-ready`: two file reads, no keystore, no prompt, no platform branch. */
export async function initBrowserSavedLogins(filePath: string): Promise<void> {
  store = createSavedLoginsStore(filePath);
  // The wrap ledger loads with the pref because the check it feeds is
  // synchronous and must be ready before the first host asks to unwrap.
  await initBrowserStoreKeyLedger(filePath);
  saveLogins = (await store.load()).saveLogins;
  log.info("[browser-view] saved browser logins resolved", { saveLogins });
}

export function isBrowserSavedLoginsEnabled(): boolean {
  return saveLogins;
}

/** The caller moves the live tiles onto the new jar. */
export async function setBrowserSavedLoginsEnabled(
  enabled: boolean,
): Promise<boolean> {
  if (store === null) throw new Error("saved-logins store is not initialised");
  await store.saveStrict({ saveLogins: enabled });
  saveLogins = enabled;
  log.info("[browser-view] saved browser logins changed", { saveLogins });
  return saveLogins;
}

/** On Linux `safeStorage` falls back to a `basic_text` backend that obfuscates rather than encrypts, and a machine like that must not be handed anything that is supposed to be at. */
export function isKeystoreEncrypting(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  if (process.platform !== "linux") return true;
  return safeStorage.getSelectedStorageBackend() !== "basic_text";
}

export function wrapStoreKey(
  rawKeyBase64: string,
  userId: string,
  hostId: string,
): string | null {
  if (!isKeystoreEncrypting()) {
    log.warn(
      "[browser-view] refusing to wrap the store key: this machine's keystore does not encrypt",
    );
    return null;
  }
  try {
    const wrapped = safeStorage.encryptString(rawKeyBase64).toString("base64");
    recordWrappedStoreKey(wrapped, userId, hostId);
    return wrapped;
  } catch (error) {
    log.warn("[browser-view] store key wrap failed", {
      error: describeLogError(error),
    });
    return null;
  }
}

/**
 * `safeStorage.decryptString(blob)`; null when this machine cannot open it.
 * A blob this desktop did not wrap is refused BEFORE the keystore sees it.
 */
export function unwrapStoreKey(
  wrappedKeyBase64: string,
  userId: string,
): string | null {
  if (!isWrappedStoreKeyOurs(wrappedKeyBase64, userId)) {
    log.warn(
      "[browser-view] refusing to unwrap a store key blob this machine did not wrap",
    );
    return null;
  }
  try {
    return safeStorage.decryptString(Buffer.from(wrappedKeyBase64, "base64"));
  } catch (error) {
    log.warn("[browser-view] store key unwrap failed", {
      error: describeLogError(error),
    });
    return null;
  }
}
