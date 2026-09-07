import {
  createDecipheriv,
  createHash,
  pbkdf2Sync,
  timingSafeEqual,
} from "node:crypto";

/**
 * Pure decryptors for Chromium's `encrypted_value` column. Nothing here reads
 * a keystore or a file: the key material is handed in, so the vectors in the
 * test suite are the whole specification and no OS prompt is ever part of a
 * unit test.
 *
 * Two constructions exist in the wild and this shell meets both:
 *
 * - **`v10` CBC** (macOS, Linux): AES-128-CBC with PKCS#7, IV of sixteen
 *   spaces, key = PBKDF2-SHA1(passphrase, "saltysalt", iterations, 16). The
 *   passphrase is the browser's Keychain item on macOS (1003 iterations), and
 *   `peanuts` on Linux (1 iteration) when no keyring backs the profile;
 *   **`v11`** is the same construction with the passphrase read from the
 *   Secret Service keyring.
 * - **`v10` GCM** (Windows): AES-256-GCM with the 12-byte nonce at bytes
 *   3..15 and the 16-byte tag at the end; the key is `Local State`'s
 *   `os_crypt.encrypted_key`, DPAPI-unprotected.
 *
 * On both, a jar whose `meta.version` is 24 or later prefixes the plaintext
 * with SHA-256 of the row's `host_key`. That gate is the schema number, not a
 * browser release: it applies on every platform, and stripping it from an
 * older jar would truncate every value by 32 bytes.
 */

const CHROMIUM_SALT = "saltysalt";
const CHROMIUM_CBC_KEY_LENGTH = 16;
const CHROMIUM_CBC_IV = Buffer.alloc(16, 0x20);
const CHROMIUM_VERSION_PREFIX_LENGTH = 3;
const CHROMIUM_GCM_NONCE_LENGTH = 12;
const CHROMIUM_GCM_TAG_LENGTH = 16;
const CHROMIUM_HOST_KEY_HASH_LENGTH = 32;

/** Chromium's `kCurrentVersionNumber` at which the host-key hash prefix arrived. */
export const CHROMIUM_HASH_PREFIX_META_VERSION = 24;

export const CHROMIUM_PBKDF2_ITERATIONS = {
  darwin: 1003,
  linux: 1,
} as const;

/** The Linux passphrase Chromium uses when no keyring backs the profile. */
export const CHROMIUM_LINUX_BASIC_PASSPHRASE = "peanuts";

export type ChromiumKeyMaterial =
  | {
      readonly kind: "cbc";
      /**
       * Tried in order. The second entry is the empty-passphrase key: some
       * builds encrypt with it despite advertising a keyring, and the
       * mainstream readers (yt-dlp, rookie) fall back to it the same way.
       */
      readonly keys: readonly Buffer[];
    }
  | { readonly kind: "gcm"; readonly key: Buffer };

export interface ChromiumDecryptOptions {
  /** `meta.version >= CHROMIUM_HASH_PREFIX_META_VERSION`. */
  readonly hashPrefix: boolean;
  /** The row's `host_key`, verbatim - the hash is over that string. */
  readonly hostKey: string;
}

export function deriveChromiumCbcKey(
  passphrase: string,
  iterations: number,
): Buffer {
  return pbkdf2Sync(
    passphrase,
    CHROMIUM_SALT,
    iterations,
    CHROMIUM_CBC_KEY_LENGTH,
    "sha1",
  );
}

/** Both keys a CBC jar may have been written with: the real one, then empty. */
export function chromiumCbcKeyMaterial(
  passphrase: string,
  iterations: number,
): ChromiumKeyMaterial {
  return {
    kind: "cbc",
    keys: [
      deriveChromiumCbcKey(passphrase, iterations),
      deriveChromiumCbcKey("", iterations),
    ],
  };
}

/**
 * The plaintext value, or `null` when nothing produced one: a wrong key, a
 * truncated row, or a host-key hash that does not match. Never throws - one
 * undecryptable row costs that row, not the import.
 */
export function decryptChromiumValue(
  encrypted: Uint8Array,
  material: ChromiumKeyMaterial,
  options: ChromiumDecryptOptions,
): string | null {
  if (encrypted.length <= CHROMIUM_VERSION_PREFIX_LENGTH) return null;
  const body = Buffer.from(encrypted.subarray(CHROMIUM_VERSION_PREFIX_LENGTH));
  if (material.kind === "gcm") {
    const plain = decryptGcm(body, material.key);
    return plain === null ? null : finishPlaintext(plain, options);
  }
  for (const key of material.keys) {
    const plain = decryptCbc(body, key);
    if (plain === null) continue;
    const value = finishPlaintext(plain, options);
    // A wrong CBC key yields valid padding about one time in 256. With the
    // hash prefix that guess is caught; without it the next key is tried
    // only when this one failed outright, which is the same trade every
    // reader of these jars makes.
    if (value !== null) return value;
  }
  return null;
}

function decryptCbc(body: Buffer, key: Buffer): Buffer | null {
  if (body.length === 0 || body.length % 16 !== 0) return null;
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, CHROMIUM_CBC_IV);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    return null;
  }
}

function decryptGcm(body: Buffer, key: Buffer): Buffer | null {
  if (body.length < CHROMIUM_GCM_NONCE_LENGTH + CHROMIUM_GCM_TAG_LENGTH) {
    return null;
  }
  const nonce = body.subarray(0, CHROMIUM_GCM_NONCE_LENGTH);
  const tag = body.subarray(body.length - CHROMIUM_GCM_TAG_LENGTH);
  const ciphertext = body.subarray(
    CHROMIUM_GCM_NONCE_LENGTH,
    body.length - CHROMIUM_GCM_TAG_LENGTH,
  );
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    return null;
  }
}

function finishPlaintext(
  plain: Buffer,
  options: ChromiumDecryptOptions,
): string | null {
  if (!options.hashPrefix) return plain.toString("utf8");
  if (plain.length < CHROMIUM_HOST_KEY_HASH_LENGTH) return null;
  const expected = createHash("sha256").update(options.hostKey).digest();
  const actual = plain.subarray(0, CHROMIUM_HOST_KEY_HASH_LENGTH);
  if (!timingSafeEqual(expected, actual)) return null;
  return plain.subarray(CHROMIUM_HOST_KEY_HASH_LENGTH).toString("utf8");
}
