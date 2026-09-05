import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CHROMIUM_PBKDF2_ITERATIONS,
  chromiumCbcKeyMaterial,
  decryptChromiumValue,
  deriveChromiumCbcKey,
  type ChromiumDecryptOptions,
  type ChromiumKeyMaterial,
} from "../chromium-crypto";

/**
 * Known-answer vectors built with the exact construction the decryptor
 * expects: `v10`/`v11` CBC (AES-128-CBC, PKCS#7, 16-space IV, PBKDF2-SHA1 over
 * "saltysalt") and the Windows `v10` GCM shell (AES-256-GCM, 12-byte nonce at
 * bytes 3..15, 16-byte tag at the end). The 3-byte version prefix
 * (`decryptChromiumValue` always strips it) is included in every fixture so
 * the vectors read the same way a real `encrypted_value` column would.
 */

const CBC_IV = Buffer.alloc(16, 0x20);
const VERSION_PREFIX = Buffer.from("v10", "ascii");

function encryptCbc(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-cbc", key, CBC_IV);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([VERSION_PREFIX, body]);
}

function encryptGcm(plaintext: Buffer, key: Buffer): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([VERSION_PREFIX, nonce, ciphertext, tag]);
}

function hostKeyPrefixed(hostKey: string, value: string): Buffer {
  return Buffer.concat([
    createHash("sha256").update(hostKey).digest(),
    Buffer.from(value, "utf8"),
  ]);
}

const HOST_KEY = "accounts.example.com";
const OTHER_HOST_KEY = "not-the-right-host.example.com";
const PASSPHRASE = "keychain-passphrase";

function optionsFor(
  hashPrefix: boolean,
  hostKey: string,
): ChromiumDecryptOptions {
  return { hashPrefix, hostKey };
}

describe("decryptChromiumValue - v10 CBC on macOS (1003 iterations)", () => {
  const iterations = CHROMIUM_PBKDF2_ITERATIONS.darwin;

  it("recovers the plaintext at hashPrefix=false (meta.version 23)", () => {
    const key = deriveChromiumCbcKey(PASSPHRASE, iterations);
    const encrypted = encryptCbc(
      Buffer.from("s3cret-cookie-value", "utf8"),
      key,
    );
    const material = chromiumCbcKeyMaterial(PASSPHRASE, iterations);

    const result = decryptChromiumValue(
      encrypted,
      material,
      optionsFor(false, HOST_KEY),
    );

    expect(result).toBe("s3cret-cookie-value");
  });

  it("recovers the plaintext at hashPrefix=true with the correct host_key prefix", () => {
    const key = deriveChromiumCbcKey(PASSPHRASE, iterations);
    const encrypted = encryptCbc(hostKeyPrefixed(HOST_KEY, "hunter2"), key);
    const material = chromiumCbcKeyMaterial(PASSPHRASE, iterations);

    const result = decryptChromiumValue(
      encrypted,
      material,
      optionsFor(true, HOST_KEY),
    );

    expect(result).toBe("hunter2");
  });

  it("returns null, not throws, when the host_key prefix does not match", () => {
    const key = deriveChromiumCbcKey(PASSPHRASE, iterations);
    const encrypted = encryptCbc(hostKeyPrefixed(HOST_KEY, "hunter2"), key);
    const material = chromiumCbcKeyMaterial(PASSPHRASE, iterations);

    let result: string | null = "sentinel";
    expect(() => {
      result = decryptChromiumValue(
        encrypted,
        material,
        optionsFor(true, OTHER_HOST_KEY),
      );
    }).not.toThrow();
    expect(result).toBeNull();
  });
});

describe("decryptChromiumValue - v10 CBC on Linux (1 iteration)", () => {
  const iterations = CHROMIUM_PBKDF2_ITERATIONS.linux;

  it("recovers the plaintext at hashPrefix=false", () => {
    const key = deriveChromiumCbcKey(PASSPHRASE, iterations);
    const encrypted = encryptCbc(Buffer.from("linux-value", "utf8"), key);
    const material = chromiumCbcKeyMaterial(PASSPHRASE, iterations);

    const result = decryptChromiumValue(
      encrypted,
      material,
      optionsFor(false, HOST_KEY),
    );

    expect(result).toBe("linux-value");
  });

  it("recovers the plaintext at hashPrefix=true with the correct host_key prefix", () => {
    const key = deriveChromiumCbcKey(PASSPHRASE, iterations);
    const encrypted = encryptCbc(
      hostKeyPrefixed(HOST_KEY, "linux-secret"),
      key,
    );
    const material = chromiumCbcKeyMaterial(PASSPHRASE, iterations);

    const result = decryptChromiumValue(
      encrypted,
      material,
      optionsFor(true, HOST_KEY),
    );

    expect(result).toBe("linux-secret");
  });

  it("returns null when the host_key prefix does not match", () => {
    const key = deriveChromiumCbcKey(PASSPHRASE, iterations);
    const encrypted = encryptCbc(
      hostKeyPrefixed(HOST_KEY, "linux-secret"),
      key,
    );
    const material = chromiumCbcKeyMaterial(PASSPHRASE, iterations);

    const result = decryptChromiumValue(
      encrypted,
      material,
      optionsFor(true, OTHER_HOST_KEY),
    );

    expect(result).toBeNull();
  });
});

describe("decryptChromiumValue - empty-passphrase fallback", () => {
  it("recovers a row that was encrypted with the empty passphrase, via chromiumCbcKeyMaterial's second key", () => {
    const iterations = CHROMIUM_PBKDF2_ITERATIONS.darwin;
    const emptyKey = deriveChromiumCbcKey("", iterations);
    const encrypted = encryptCbc(
      Buffer.from("empty-passphrase-value", "utf8"),
      emptyKey,
    );
    // The material is built from the REAL passphrase - as the caller would
    // hand it in from the keychain - not the empty string. Recovery has to
    // come from chromiumCbcKeyMaterial's own second key, not from the caller
    // knowing to retry.
    const material = chromiumCbcKeyMaterial(PASSPHRASE, iterations);

    const result = decryptChromiumValue(
      encrypted,
      material,
      optionsFor(false, HOST_KEY),
    );

    expect(result).toBe("empty-passphrase-value");
  });

  it("does not accidentally recover under the real key when only the empty key would work, proving the first key really failed", () => {
    const iterations = CHROMIUM_PBKDF2_ITERATIONS.darwin;
    const emptyKey = deriveChromiumCbcKey("", iterations);
    const realKey = deriveChromiumCbcKey(PASSPHRASE, iterations);
    expect(realKey.equals(emptyKey)).toBe(false);
  });
});

describe("decryptChromiumValue - v10 GCM (Windows-style)", () => {
  function gcmMaterial(key: Buffer): ChromiumKeyMaterial {
    return { kind: "gcm", key };
  }

  it("recovers the plaintext at hashPrefix=false", () => {
    const key = randomBytes(32);
    const encrypted = encryptGcm(Buffer.from("gcm-plaintext", "utf8"), key);

    const result = decryptChromiumValue(
      encrypted,
      gcmMaterial(key),
      optionsFor(false, HOST_KEY),
    );

    expect(result).toBe("gcm-plaintext");
  });

  it("recovers the plaintext at hashPrefix=true with the correct host_key prefix", () => {
    const key = randomBytes(32);
    const encrypted = encryptGcm(hostKeyPrefixed(HOST_KEY, "gcm-secret"), key);

    const result = decryptChromiumValue(
      encrypted,
      gcmMaterial(key),
      optionsFor(true, HOST_KEY),
    );

    expect(result).toBe("gcm-secret");
  });

  it("returns null when the host_key prefix does not match at hashPrefix=true", () => {
    const key = randomBytes(32);
    const encrypted = encryptGcm(hostKeyPrefixed(HOST_KEY, "gcm-secret"), key);

    const result = decryptChromiumValue(
      encrypted,
      gcmMaterial(key),
      optionsFor(true, OTHER_HOST_KEY),
    );

    expect(result).toBeNull();
  });

  it("returns null, not throws, when the auth tag does not verify (wrong key)", () => {
    const key = randomBytes(32);
    const wrongKey = randomBytes(32);
    const encrypted = encryptGcm(Buffer.from("gcm-plaintext", "utf8"), key);

    let result: string | null = "sentinel";
    expect(() => {
      result = decryptChromiumValue(
        encrypted,
        gcmMaterial(wrongKey),
        optionsFor(false, HOST_KEY),
      );
    }).not.toThrow();
    expect(result).toBeNull();
  });
});

describe("decryptChromiumValue - malformed input", () => {
  const cbcMaterial = chromiumCbcKeyMaterial(
    PASSPHRASE,
    CHROMIUM_PBKDF2_ITERATIONS.darwin,
  );
  const gcmMaterial: ChromiumKeyMaterial = {
    kind: "gcm",
    key: randomBytes(32),
  };

  it("returns null for input at or below the 3-byte version prefix", () => {
    expect(
      decryptChromiumValue(
        Buffer.from("v1", "ascii"),
        cbcMaterial,
        optionsFor(false, HOST_KEY),
      ),
    ).toBeNull();
    expect(
      decryptChromiumValue(
        Buffer.alloc(0),
        cbcMaterial,
        optionsFor(false, HOST_KEY),
      ),
    ).toBeNull();
  });

  it("returns null for a CBC body whose length is not a multiple of the block size", () => {
    const truncated = Buffer.concat([
      VERSION_PREFIX,
      Buffer.from("not-16-bytes"),
    ]);

    let result: string | null = "sentinel";
    expect(() => {
      result = decryptChromiumValue(
        truncated,
        cbcMaterial,
        optionsFor(false, HOST_KEY),
      );
    }).not.toThrow();
    expect(result).toBeNull();
  });

  it("returns null for a GCM body shorter than nonce+tag", () => {
    const tooShort = Buffer.concat([VERSION_PREFIX, Buffer.alloc(10, 0)]);

    let result: string | null = "sentinel";
    expect(() => {
      result = decryptChromiumValue(
        tooShort,
        gcmMaterial,
        optionsFor(false, HOST_KEY),
      );
    }).not.toThrow();
    expect(result).toBeNull();
  });

  it("returns null for CBC ciphertext that decrypts but is too short for the host_key hash prefix", () => {
    const key = deriveChromiumCbcKey(
      PASSPHRASE,
      CHROMIUM_PBKDF2_ITERATIONS.darwin,
    );
    // Sixteen bytes of plaintext (one AES block) is well under the 32-byte
    // sha256 prefix the hashPrefix path requires.
    const encrypted = encryptCbc(Buffer.alloc(16, 0x41), key);
    const material = chromiumCbcKeyMaterial(
      PASSPHRASE,
      CHROMIUM_PBKDF2_ITERATIONS.darwin,
    );

    const result = decryptChromiumValue(
      encrypted,
      material,
      optionsFor(true, HOST_KEY),
    );

    expect(result).toBeNull();
  });
});
