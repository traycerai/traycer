import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from "node:crypto";
import { readFileSync } from "node:fs";
import type { ParsedMinisignPublicKey } from "../trusted-keys";

export interface GeneratedKey {
  readonly trustedPublicKey: ParsedMinisignPublicKey;
  readonly keyIdBuf: Buffer;
  readonly cryptoPrivateKey: KeyObject;
}

export interface MinisignSignatureOptions {
  readonly message: Uint8Array;
  readonly key: GeneratedKey;
  readonly trustedComment: string;
  readonly prehashed: boolean;
}

export interface MinisignArchiveSignatureOptions {
  readonly archivePath: string;
  readonly key: GeneratedKey;
  readonly trustedComment: string;
  readonly prehashed: boolean;
}

export function makeKey(): GeneratedKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  const publicKeyRaw = spki.subarray(12);
  const keyIdBuf = randomBytes(8);
  const raw = Buffer.concat([
    Buffer.from("Ed", "ascii"),
    keyIdBuf,
    publicKeyRaw,
  ]).toString("base64");
  return {
    trustedPublicKey: {
      raw,
      keyId: keyIdBuf.toString("hex"),
      publicKey: new Uint8Array(publicKeyRaw),
    },
    keyIdBuf,
    cryptoPrivateKey: privateKey,
  };
}

export function makeSignatureFile(opts: MinisignSignatureOptions): string {
  const message = opts.prehashed
    ? createHash("blake2b512").update(opts.message).digest()
    : Buffer.from(opts.message);
  const signatureBytes = sign(null, message, opts.key.cryptoPrivateKey);
  const algoTag = Buffer.from(opts.prehashed ? "ED" : "Ed", "ascii");
  const signaturePayload = Buffer.concat([
    algoTag,
    opts.key.keyIdBuf,
    signatureBytes,
  ]);
  const trustedCommentBytes = Buffer.from(opts.trustedComment, "utf8");
  const globalMessage = Buffer.concat([signatureBytes, trustedCommentBytes]);
  const globalSignature = sign(null, globalMessage, opts.key.cryptoPrivateKey);

  return [
    "untrusted comment: signature from minisign fixture",
    signaturePayload.toString("base64"),
    `trusted comment: ${opts.trustedComment}`,
    globalSignature.toString("base64"),
    "",
  ].join("\n");
}

export function makeArchiveSignatureFile(
  opts: MinisignArchiveSignatureOptions,
): string {
  return makeSignatureFile({
    message: readFileSync(opts.archivePath),
    key: opts.key,
    trustedComment: opts.trustedComment,
    prehashed: opts.prehashed,
  });
}
