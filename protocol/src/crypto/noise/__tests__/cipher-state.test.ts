import { describe, it, expect } from "vitest";
import { CipherState } from "../cipher-state";
import { MAX_NONCE } from "../constants";
import { bytesToHex } from "../bytes";
import { NoiseNonceError } from "../errors";

/**
 * Security-gate bar #3 (counter-discipline half): the nonce is a private,
 * strictly-monotonic counter that is never reused and refuses to wrap.
 */
const KEY = new Uint8Array(32).fill(7);
const AD = new Uint8Array(0);
const PLAINTEXT = new TextEncoder().encode("counter discipline");

function newCipher(): CipherState {
  return new CipherState(KEY.slice());
}

describe("CipherState nonce discipline", () => {
  it("advances the nonce by exactly one per encryption", async () => {
    const cipher = newCipher();
    expect(cipher.currentNonce()).toBe(0n);
    await cipher.encryptWithAd(AD, PLAINTEXT);
    expect(cipher.currentNonce()).toBe(1n);
    await cipher.encryptWithAd(AD, PLAINTEXT);
    expect(cipher.currentNonce()).toBe(2n);
  });

  it("never produces the same ciphertext twice for identical plaintext (no nonce reuse)", async () => {
    const cipher = newCipher();
    const first = await cipher.encryptWithAd(AD, PLAINTEXT);
    const second = await cipher.encryptWithAd(AD, PLAINTEXT);
    expect(bytesToHex(first)).not.toBe(bytesToHex(second));
  });

  it("decrypts in lock-step with the encrypting counter", async () => {
    const enc = newCipher();
    const dec = newCipher();
    for (let i = 0; i < 5; i++) {
      const sealed = await enc.encryptWithAd(AD, PLAINTEXT);
      const opened = await dec.decryptWithAd(AD, sealed);
      expect(bytesToHex(opened)).toBe(bytesToHex(PLAINTEXT));
    }
    expect(enc.currentNonce()).toBe(5n);
    expect(dec.currentNonce()).toBe(5n);
  });

  it("does not advance the counter when authentication fails", async () => {
    const enc = newCipher();
    const dec = newCipher();
    const sealed = await enc.encryptWithAd(AD, PLAINTEXT);
    const tampered = sealed.slice();
    tampered[tampered.length - 1] ^= 0x01;

    await expect(dec.decryptWithAd(AD, tampered)).rejects.toThrow();
    expect(dec.currentNonce()).toBe(0n); // unchanged after the failure

    // the untampered frame still opens at the same nonce.
    const opened = await dec.decryptWithAd(AD, sealed);
    expect(bytesToHex(opened)).toBe(bytesToHex(PLAINTEXT));
    expect(dec.currentNonce()).toBe(1n);
  });

  it("refuses to encrypt once the reserved MAX_NONCE is reached (rollover handled)", async () => {
    const cipher = newCipher();
    cipher.setNonce(MAX_NONCE - 1n);
    // last legal message consumes nonce (2^64 - 2) and lands on MAX_NONCE.
    await cipher.encryptWithAd(AD, PLAINTEXT);
    expect(cipher.currentNonce()).toBe(MAX_NONCE);
    await expect(cipher.encryptWithAd(AD, PLAINTEXT)).rejects.toBeInstanceOf(
      NoiseNonceError,
    );
  });

  it("acts as the identity function when unkeyed (Noise EncryptWithAd rule)", async () => {
    const cipher = new CipherState(null);
    const out = await cipher.encryptWithAd(AD, PLAINTEXT);
    expect(bytesToHex(out)).toBe(bytesToHex(PLAINTEXT));
    const back = await cipher.decryptWithAd(AD, out);
    expect(bytesToHex(back)).toBe(bytesToHex(PLAINTEXT));
  });

  it("rekey changes the key (ratchet) without rewinding the counter", async () => {
    const cipher = newCipher();
    await cipher.encryptWithAd(AD, PLAINTEXT);
    const before = cipher.currentNonce();
    await cipher.rekey();
    expect(cipher.currentNonce()).toBe(before); // Noise Rekey does not reset n
    // still usable with the new key.
    const twin = newCipher();
    await twin.rekey();
    twin.setNonce(before);
    const sealed = await cipher.encryptWithAd(AD, PLAINTEXT);
    const opened = await twin.decryptWithAd(AD, sealed);
    expect(bytesToHex(opened)).toBe(bytesToHex(PLAINTEXT));
  });
});
