import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CliError } from "../../runner/errors";
import { verifyMinisignArchive } from "../minisign";
import type { ParsedMinisignPublicKey } from "../trusted-keys";

// We generate an Ed25519 key pair on the fly and produce a minisign-
// compatible signature for an in-memory archive, then feed both into
// the verifier. This proves the byte-for-byte compatibility of our
// parser/verifier with what `minisign -S -H` produces, without
// depending on the `minisign` CLI being installed.

interface GeneratedKey {
  readonly trustedPublicKey: ParsedMinisignPublicKey;
  readonly keyIdBuf: Buffer;
  readonly cryptoPrivateKey: KeyObject;
}

function makeKey(): GeneratedKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  // SPKI for Ed25519 is `30 2a 30 05 06 03 2b 65 70 03 21 00 || raw32`.
  // Strip the fixed 12-byte prefix to get the 32-byte raw key.
  const publicKeyRaw = spki.subarray(12);
  const keyIdBuf = randomBytes(8);
  const keyId = keyIdBuf.toString("hex");
  return {
    trustedPublicKey: {
      raw: "test-fixture",
      keyId,
      publicKey: new Uint8Array(publicKeyRaw),
    },
    keyIdBuf,
    cryptoPrivateKey: privateKey,
  };
}

function makeSignatureFile(opts: {
  readonly archivePath: string;
  readonly key: GeneratedKey;
  readonly trustedComment: string;
  readonly prehashed: boolean;
}): string {
  const archiveBytes = readFileSync(opts.archivePath);
  const message = opts.prehashed
    ? createHash("blake2b512").update(archiveBytes).digest()
    : archiveBytes;
  const sigBytes = sign(null, message, opts.key.cryptoPrivateKey);
  const algoTag = Buffer.from(opts.prehashed ? "ED" : "Ed", "ascii");
  const sigPayload = Buffer.concat([algoTag, opts.key.keyIdBuf, sigBytes]);

  const trustedCommentBuf = Buffer.from(opts.trustedComment, "utf8");
  const globalMessage = Buffer.concat([sigBytes, trustedCommentBuf]);
  const globalSig = sign(null, globalMessage, opts.key.cryptoPrivateKey);

  return [
    "untrusted comment: signature from minisign fixture",
    sigPayload.toString("base64"),
    `trusted comment: ${opts.trustedComment}`,
    globalSig.toString("base64"),
    "",
  ].join("\n");
}

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "traycer-minisign-test-"));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("verifyMinisignArchive", () => {
  it("accepts a valid pre-hashed signature", async () => {
    const key = makeKey();
    const archivePath = join(tmpRoot, "ok-archive.tar.gz");
    writeFileSync(archivePath, Buffer.from("hello world\n".repeat(100)));
    const signatureText = makeSignatureFile({
      archivePath,
      key,
      trustedComment: "traycer-host 1.0.0 darwin-arm64",
      prehashed: true,
    });
    const result = await verifyMinisignArchive({
      archivePath,
      signatureText,
      signatureSourceLabel: "test://ok",
      trustedKeys: [key.trustedPublicKey],
    });
    expect(result.algorithm).toBe("prehashed");
    expect(result.keyId).toBe(key.trustedPublicKey.keyId);
    expect(result.trustedComment).toBe("traycer-host 1.0.0 darwin-arm64");
  });

  it("accepts a valid pure (non-prehashed) signature", async () => {
    const key = makeKey();
    const archivePath = join(tmpRoot, "ok-pure.bin");
    writeFileSync(archivePath, Buffer.from("short payload"));
    const signatureText = makeSignatureFile({
      archivePath,
      key,
      trustedComment: "pure mode",
      prehashed: false,
    });
    const result = await verifyMinisignArchive({
      archivePath,
      signatureText,
      signatureSourceLabel: "test://ok-pure",
      trustedKeys: [key.trustedPublicKey],
    });
    expect(result.algorithm).toBe("pure");
  });

  it("rejects a signature whose key id is not in the trusted set", async () => {
    const key = makeKey();
    const otherKey = makeKey();
    const archivePath = join(tmpRoot, "untrusted.tar.gz");
    writeFileSync(archivePath, Buffer.from("payload"));
    const signatureText = makeSignatureFile({
      archivePath,
      key,
      trustedComment: "untrusted",
      prehashed: true,
    });
    await expect(
      verifyMinisignArchive({
        archivePath,
        signatureText,
        signatureSourceLabel: "test://untrusted",
        trustedKeys: [otherKey.trustedPublicKey],
      }),
    ).rejects.toThrow(CliError);
  });

  it("rejects a tampered archive", async () => {
    const key = makeKey();
    const archivePath = join(tmpRoot, "tampered.tar.gz");
    writeFileSync(archivePath, Buffer.from("original payload"));
    const signatureText = makeSignatureFile({
      archivePath,
      key,
      trustedComment: "tampered",
      prehashed: true,
    });
    // Mutate the file after signing.
    writeFileSync(archivePath, Buffer.from("tampered payload"));
    await expect(
      verifyMinisignArchive({
        archivePath,
        signatureText,
        signatureSourceLabel: "test://tampered",
        trustedKeys: [key.trustedPublicKey],
      }),
    ).rejects.toThrow(/did not verify/);
  });

  it("rejects a tampered trusted comment", async () => {
    const key = makeKey();
    const archivePath = join(tmpRoot, "trusted-comment.bin");
    writeFileSync(archivePath, Buffer.from("payload"));
    const signatureText = makeSignatureFile({
      archivePath,
      key,
      trustedComment: "original comment",
      prehashed: true,
    });
    const tampered = signatureText.replace(
      "trusted comment: original comment",
      "trusted comment: rewritten comment",
    );
    await expect(
      verifyMinisignArchive({
        archivePath,
        signatureText: tampered,
        signatureSourceLabel: "test://tampered-comment",
        trustedKeys: [key.trustedPublicKey],
      }),
    ).rejects.toThrow(/global signature/);
  });

  it("fails closed when no trusted keys are configured", async () => {
    const key = makeKey();
    const archivePath = join(tmpRoot, "empty-trust.bin");
    writeFileSync(archivePath, Buffer.from("payload"));
    const signatureText = makeSignatureFile({
      archivePath,
      key,
      trustedComment: "empty-trust",
      prehashed: true,
    });
    await expect(
      verifyMinisignArchive({
        archivePath,
        signatureText,
        signatureSourceLabel: "test://empty",
        trustedKeys: [],
      }),
    ).rejects.toThrow(/no trusted public keys/);
  });
});
