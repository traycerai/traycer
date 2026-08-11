import { concatBytes } from "./bytes";
import { HASH_LEN, KEY_LEN, NOISE_PROTOCOL_NAME } from "./constants";
import { CipherState } from "./cipher-state";
import { hkdf, sha256 } from "./primitives";

/**
 * Noise SymmetricState (spec §5.2): the running chaining key `ck`, the running
 * transcript hash `h`, and a CipherState that becomes keyed as DH results are
 * mixed in. It is a faithful, un-optimised transcription of the spec so it can
 * be reviewed against it directly.
 */
export class SymmetricState {
  private ck: Uint8Array;
  private h: Uint8Array;
  readonly cipher: CipherState;

  private constructor(ck: Uint8Array, h: Uint8Array, cipher: CipherState) {
    this.ck = ck;
    this.h = h;
    this.cipher = cipher;
  }

  /**
   * InitializeSymmetric for this suite. The protocol name is 28 bytes, which is
   * <= HASHLEN (32), so `h` is the name right-padded with zeros (not hashed);
   * `ck` starts equal to `h`; the CipherState starts un-keyed.
   */
  static initialize(): SymmetricState {
    const nameBytes = new TextEncoder().encode(NOISE_PROTOCOL_NAME);
    const h = new Uint8Array(HASH_LEN);
    h.set(nameBytes);
    return new SymmetricState(h.slice(), h.slice(), new CipherState(null));
  }

  /** MixKey: (ck, tempK) = HKDF(ck, ikm, 2); re-key the CipherState with tempK. */
  async mixKey(inputKeyMaterial: Uint8Array): Promise<void> {
    const [nextCk, tempK] = await hkdf(this.ck, inputKeyMaterial, 2);
    this.ck = nextCk;
    this.cipher.initializeKey(tempK.slice(0, KEY_LEN));
  }

  /** MixHash: h = SHA-256(h || data). */
  async mixHash(data: Uint8Array): Promise<void> {
    this.h = await sha256(concatBytes([this.h, data]));
  }

  /** The current transcript hash (the Noise handshake hash once complete). */
  getHandshakeHash(): Uint8Array {
    return this.h.slice();
  }

  /** EncryptAndHash: seal `plaintext` with AD = h, then fold the ciphertext into h. */
  async encryptAndHash(plaintext: Uint8Array): Promise<Uint8Array> {
    const ciphertext = await this.cipher.encryptWithAd(this.h, plaintext);
    await this.mixHash(ciphertext);
    return ciphertext;
  }

  /** DecryptAndHash: open `ciphertext` with AD = h, then fold the ciphertext into h. */
  async decryptAndHash(ciphertext: Uint8Array): Promise<Uint8Array> {
    const plaintext = await this.cipher.decryptWithAd(this.h, ciphertext);
    await this.mixHash(ciphertext);
    return plaintext;
  }

  /**
   * Split: derive the two transport keys. (tempK1, tempK2) = HKDF(ck, empty, 2).
   * The caller maps them to send/receive per role.
   */
  async split(): Promise<[CipherState, CipherState]> {
    const [tempK1, tempK2] = await hkdf(this.ck, new Uint8Array(0), 2);
    return [
      new CipherState(tempK1.slice(0, KEY_LEN)),
      new CipherState(tempK2.slice(0, KEY_LEN)),
    ];
  }
}
