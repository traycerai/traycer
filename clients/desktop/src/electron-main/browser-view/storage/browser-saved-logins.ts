import { app, safeStorage } from "electron";
import { join } from "node:path";
import { z } from "zod";
import { describeLogError, log } from "../../app/logger";
import {
  createJsonFileStore,
  type StrictJsonFileStore,
} from "../../app/json-file-store";
import {
  browserStoreKeyLedgerPathBeside,
  initBrowserStoreKeyLedger,
  isWrappedStoreKeyOurs,
  recordWrappedStoreKey,
} from "./browser-store-key-ledger";

/**
 * Whether this machine keeps browser logins across restarts - Chrome's model,
 * silently on by default. There is no consent state here and no keystore probe:
 * a `persist:` partition reaches the OS keystore through Chromium's own cookie
 * store the moment it opens, which the `enableCookieEncryption` fuse already
 * settles at boot, so a probe could only ask a question nobody answers.
 *
 * The pref is a statement about the machine, not the Traycer account, so it
 * lives in desktop userData and never travels to the host. A missing or
 * unparseable file reads back as "on", so a corrupt pref degrades to the
 * default rather than silently signing the user out of everything.
 *
 * This is a new file name, so the four-state decision file it replaces is never
 * read: a machine that had declined saved logins gets them, which is what
 * "always on, Chrome-style" means.
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
  await initBrowserStoreKeyLedger(browserStoreKeyLedgerPathBeside(filePath));
  saveLogins = (await store.load()).saveLogins;
  log.info("[browser-view] saved browser logins resolved", { saveLogins });
}

export function isBrowserSavedLoginsEnabled(): boolean {
  return saveLogins;
}

/**
 * Settings' toggle. The caller moves the live tiles onto the new jar.
 *
 * The durable write goes first and is allowed to throw: flipping the in-memory
 * flag on a write that did not land would move every tile onto the other jar
 * and report the new state, then silently revert at the next launch. The
 * rejection reaches the renderer, whose toggle reverts on it.
 */
export async function setBrowserSavedLoginsEnabled(
  enabled: boolean,
): Promise<boolean> {
  if (store === null) throw new Error("saved-logins store is not initialised");
  await store.saveStrict({ saveLogins: enabled });
  saveLogins = enabled;
  log.info("[browser-view] saved browser logins changed", { saveLogins });
  return saveLogins;
}

/**
 * Does this machine's keystore actually ENCRYPT what it is handed?
 *
 * On Linux `safeStorage` falls back to a `basic_text` backend that obfuscates
 * rather than encrypts, and a machine like that must not be handed anything
 * that is supposed to be at rest under an OS keystore. One predicate, so the
 * store-key wrap and the desktop identity refuse for one cause rather than
 * two. `getSelectedStorageBackend` is Linux-only, so it is asked only there.
 */
export function isKeystoreEncrypting(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  if (process.platform !== "linux") return true;
  return safeStorage.getSelectedStorageBackend() !== "basic_text";
}

/**
 * `safeStorage.encryptString(rawKey)`, base64 for the wire: the desktop half of
 * the host's store-key handshake.
 *
 * Refused outright when the keystore does not actually encrypt: a `basic_text`
 * Linux keyring round-trips, so a wrap would SUCCEED and hand the host a blob
 * anyone holding the file can open, with the custody model silently degraded
 * to obfuscation. `null` is a defined answer - the host stays sealed, which is
 * the honest state for such a machine.
 *
 * Every blob that leaves here is recorded in the wrap ledger under the account
 * it was wrapped for, because that record is what later lets
 * {@link unwrapStoreKey} tell this desktop's own blobs - for this account -
 * from anything else a host names.
 */
export function wrapStoreKey(
  rawKeyBase64: string,
  userId: string,
): string | null {
  if (!isKeystoreEncrypting()) {
    log.warn(
      "[browser-view] refusing to wrap the store key: this machine's keystore does not encrypt",
    );
    return null;
  }
  try {
    const wrapped = safeStorage.encryptString(rawKeyBase64).toString("base64");
    recordWrappedStoreKey(wrapped, userId);
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
 *
 * A blob this desktop did not wrap is refused BEFORE the keystore sees it.
 * Decrypting on demand made this process an oracle for the caller: OSCrypt is
 * AES-CBC with a fixed IV and no MAC, so the ok/null answer over a chosen
 * ciphertext is a padding oracle against this machine's own cookie database,
 * and a forged blob that did decrypt would install a host-chosen store key.
 * A foreign blob answers null, which is what the host's heal path already
 * expects from a machine that cannot open another machine's blob. A blob this
 * machine wrapped for a DIFFERENT account is foreign by the same rule: a store
 * key is per user, and opening one account's blob for another would hand a
 * host custody it was never given.
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
