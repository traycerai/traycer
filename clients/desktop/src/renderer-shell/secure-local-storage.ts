import { EncryptStorage } from "encrypt-storage";

/**
 * Renderer-side replacement for the keychain-backed `safeStorage` token
 * store. Mirrors how the Traycer web UI persists credentials: AES on
 * top of `window.localStorage`, with the encryption key bundled into the
 * shipped renderer JS at build time via Vite's `import.meta.env`.
 *
 * Threat model (be honest about what this is and isn't):
 *   - Stops a curious user with DevTools from reading bearer tokens straight
 *     out of `localStorage` as plaintext.
 *   - Frustrates trivial copy-paste exfiltration (e.g. screen-share leaks).
 *   - DOES NOT defend against malware running as the same OS user - that
 *     attacker can read both the ciphertext (from Chromium's local storage
 *     on disk) and the bundled key (`grep`-able inside the asar). The
 *     macOS Keychain we replaced was the only mechanism that gave us
 *     offline-disk-theft protection, and it cost us a scary password
 *     prompt on every unsigned-build first-launch.
 *
 * In exchange we get:
 *   - No keychain prompts, on any OS.
 *   - No Electron `safeStorage` / IPC dance for credential I/O - the
 *     renderer reads/writes its own `localStorage` directly.
 *   - Parity with how the Traycer web UI persists its credentials.
 */
const FALLBACK_KEY = "traycer-desktop-default-secret";

function resolveEncryptionKey(): string {
  const configured =
    typeof import.meta !== "undefined" &&
    import.meta.env !== undefined &&
    typeof import.meta.env.VITE_DESKTOP_LOCAL_STORAGE_KEY === "string" &&
    import.meta.env.VITE_DESKTOP_LOCAL_STORAGE_KEY.length > 0
      ? import.meta.env.VITE_DESKTOP_LOCAL_STORAGE_KEY
      : null;
  if (configured !== null) {
    return configured;
  }
  // Packaged builds must never fall back to the well-known public string
  // - anyone with the bundled asar would otherwise be able to decrypt
  // tokens at rest. `import.meta.env.PROD` is wired by Vite at build
  // time and is `true` for production-mode bundles; dev shells (`make
  // dev-desktop`) get a warning + the fallback so local iteration isn't
  // blocked on setting the env var.
  const isProdBuild =
    typeof import.meta !== "undefined" &&
    import.meta.env !== undefined &&
    import.meta.env.PROD === true;
  if (isProdBuild) {
    throw new Error(
      "[secure-local-storage] VITE_DESKTOP_LOCAL_STORAGE_KEY must be set at build time for packaged Desktop builds - refusing to fall back to a public default secret.",
    );
  }
  // eslint-disable-next-line no-console
  console.warn(
    "[secure-local-storage] VITE_DESKTOP_LOCAL_STORAGE_KEY is unset; falling back to a public default secret. Acceptable for `make dev-desktop` only.",
  );
  return FALLBACK_KEY;
}

const ENCRYPTION_KEY = resolveEncryptionKey();

let encryptStorage: EncryptStorage | null = null;

function getEncryptStorage(): EncryptStorage {
  if (encryptStorage === null) {
    encryptStorage = new EncryptStorage(ENCRYPTION_KEY, {
      storageType: "localStorage",
      encAlgorithm: "AES",
    });
  }
  return encryptStorage;
}

/**
 * Read a previously-encrypted string value. Returns `null` when the slot
 * is empty or the ciphertext fails to decrypt (we treat decrypt failure as
 * "no value" so a corrupted local store doesn't crash sign-in - the user
 * just gets re-prompted to authenticate).
 */
export function readEncryptedItem(key: string): string | null {
  try {
    const value = getEncryptStorage().getItem<string>(key);
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch (error) {
    console.warn("[secure-local-storage] encrypted item read failed", {
      key,
      error: describeStorageError(error),
    });
    return null;
  }
}

export function writeEncryptedItem(key: string, value: string): void {
  getEncryptStorage().setItem(key, value);
}

export function removeEncryptedItem(key: string): void {
  getEncryptStorage().removeItem(key);
}

function describeStorageError(error: unknown): {
  readonly name: string;
} {
  if (error instanceof Error) {
    return { name: error.name };
  }
  return { name: typeof error };
}
