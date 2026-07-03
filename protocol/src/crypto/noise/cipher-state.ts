import { KEY_LEN, MAX_NONCE } from "./constants";
import { NoiseDecryptError, NoiseNonceError } from "./errors";
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  encodeAesGcmNonce,
  importAesGcmKey,
} from "./primitives";

/**
 * Noise CipherState: an AEAD key paired with a 64-bit nonce counter.
 *
 * There are two ways to drive it, and the split is deliberate:
 *
 *  - **Stateful** (`encryptWithAd` / `decryptWithAd`): the private `nonce`
 *    counter is the source of truth. Used by the handshake, which is strictly
 *    sequential (each message fully awaits before the next), so there is no
 *    concurrency on these methods.
 *  - **Stateless** (`sealWithNonce` / `openWithNonce`): the caller supplies the
 *    nonce and the internal counter is never read or written. This is what the
 *    transport session uses, because a session multiplexes N mux streams and
 *    therefore issues concurrent seals/opens; routing those through the shared
 *    `nonce` field would race and reuse a (key, nonce) pair (T8-F1). The session
 *    reserves each counter synchronously and passes it in here.
 *
 * Nonce discipline (security-gate bar #3): every seal uses a distinct nonce
 * (the stateful path advances by one per message; the stateless path trusts the
 * caller's monotonic reservation); the reserved `MAX_NONCE` is refused rather
 * than wrapped, so a (key, nonce) pair is never reused; and a failed open never
 * advances the stateful counter.
 *
 * The AES-GCM CryptoKey is imported once and cached as a promise (so concurrent
 * stateless callers share a single import); the raw key bytes are retained only
 * for `rekey()` and are dropped by `wipe()`.
 */
export class CipherState {
  private key: Uint8Array | null;
  private keyPromise: Promise<CryptoKey> | null = null;
  private nonce = 0n;

  constructor(key: Uint8Array | null) {
    this.key = key;
  }

  /** (Re)initialise with a key and reset the nonce to zero (Noise InitializeKey). */
  initializeKey(key: Uint8Array): void {
    this.key = key;
    this.keyPromise = null;
    this.nonce = 0n;
  }

  hasKey(): boolean {
    return this.key !== null;
  }

  /** The nonce that the next stateful encrypt/decrypt will consume (for tests). */
  currentNonce(): bigint {
    return this.nonce;
  }

  /**
   * Force the stateful counter to `nonce` (the spec's SetNonce). Not used on the
   * concurrent transport path — that path is stateless. The `MAX_NONCE` ceiling
   * is still enforced at use time.
   */
  setNonce(nonce: bigint): void {
    if (nonce < 0n) {
      throw new NoiseNonceError("nonce must be non-negative");
    }
    this.nonce = nonce;
  }

  private cryptoKeyFor(): Promise<CryptoKey> {
    if (this.key === null) {
      throw new NoiseNonceError("cipher has no key");
    }
    if (this.keyPromise === null) {
      this.keyPromise = importAesGcmKey(this.key);
    }
    return this.keyPromise;
  }

  // --- Stateless AEAD (caller owns the nonce; safe under concurrency) --------

  /**
   * Seal `plaintext` under an explicit, caller-reserved `nonce`. Does not touch
   * the internal counter, so concurrent callers with distinct reserved nonces
   * never collide.
   */
  async sealWithNonce(
    nonce: bigint,
    associatedData: Uint8Array,
    plaintext: Uint8Array,
  ): Promise<Uint8Array> {
    assertNonceInRange(nonce);
    const cryptoKey = await this.cryptoKeyFor();
    return aesGcmEncrypt(
      cryptoKey,
      encodeAesGcmNonce(nonce),
      associatedData,
      plaintext,
    );
  }

  /**
   * Open `ciphertext` under an explicit `nonce`. Does not touch the internal
   * counter. WebCrypto's generic DOMException on a bad tag is converted to a
   * typed NoiseDecryptError.
   */
  async openWithNonce(
    nonce: bigint,
    associatedData: Uint8Array,
    ciphertext: Uint8Array,
  ): Promise<Uint8Array> {
    assertNonceInRange(nonce);
    const cryptoKey = await this.cryptoKeyFor();
    return aesGcmDecrypt(
      cryptoKey,
      encodeAesGcmNonce(nonce),
      associatedData,
      ciphertext,
    ).catch(() => {
      throw new NoiseDecryptError("AEAD authentication failed");
    });
  }

  // --- Stateful AEAD (internal counter; sequential handshake use) ------------

  /**
   * Encrypt-with-associated-data using the internal counter. With no key set
   * (pre-`es` handshake stage) this is the identity function. The counter is
   * reserved synchronously *before* the await, so it is never observed twice.
   */
  async encryptWithAd(
    associatedData: Uint8Array,
    plaintext: Uint8Array,
  ): Promise<Uint8Array> {
    if (this.key === null) {
      return plaintext;
    }
    const nonce = this.reserveNonce();
    return this.sealWithNonce(nonce, associatedData, plaintext);
  }

  /**
   * Decrypt-with-associated-data using the internal counter. On authentication
   * failure the counter is left untouched (the spec's "n is not incremented"
   * rule). With no key set this is the identity function.
   */
  async decryptWithAd(
    associatedData: Uint8Array,
    ciphertext: Uint8Array,
  ): Promise<Uint8Array> {
    if (this.key === null) {
      return ciphertext;
    }
    if (this.nonce >= MAX_NONCE) {
      throw new NoiseNonceError("nonce exhausted; rekey required");
    }
    const nonce = this.nonce;
    const plaintext = await this.openWithNonce(nonce, associatedData, ciphertext);
    this.nonce = nonce + 1n;
    return plaintext;
  }

  /** Reserve and advance the internal counter synchronously (no await inside). */
  private reserveNonce(): bigint {
    if (this.nonce >= MAX_NONCE) {
      throw new NoiseNonceError("nonce exhausted; rekey required");
    }
    const nonce = this.nonce;
    this.nonce = nonce + 1n;
    return nonce;
  }

  /**
   * Noise Rekey: k = REKEY(k), where for AES-GCM REKEY(k) is the first 32 bytes
   * of ENCRYPT(k, 2^64-1, empty-ad, 32 zero bytes). The nonce is intentionally
   * NOT reset — Rekey ratchets the key without rewinding the counter.
   */
  async rekey(): Promise<void> {
    if (this.key === null) {
      throw new NoiseNonceError("cannot rekey a cipher without a key");
    }
    const cryptoKey = await this.cryptoKeyFor();
    const sealed = await aesGcmEncrypt(
      cryptoKey,
      encodeAesGcmNonce(MAX_NONCE),
      new Uint8Array(0),
      new Uint8Array(KEY_LEN),
    );
    this.key = sealed.slice(0, KEY_LEN);
    this.keyPromise = null;
  }

  /** Zero the retained key material. The cached CryptoKey is also dropped. */
  wipe(): void {
    if (this.key !== null) {
      this.key.fill(0);
    }
    this.key = null;
    this.keyPromise = null;
  }
}

/** Reject a nonce that is negative or has reached the reserved ceiling. */
function assertNonceInRange(nonce: bigint): void {
  if (nonce < 0n) {
    throw new NoiseNonceError("nonce must be non-negative");
  }
  if (nonce >= MAX_NONCE) {
    throw new NoiseNonceError("nonce exhausted; rekey required");
  }
}
