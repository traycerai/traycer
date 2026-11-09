import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CliError } from "../../runner/errors";
import { verifyMinisignArchive, verifyMinisignPayload } from "../minisign";
import { parseMinisignPublicKey } from "../trusted-keys";
import {
  makeArchiveSignatureFile,
  makeKey,
  type GeneratedKey,
} from "./minisign-test-helpers";

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
    const signatureText = makeArchiveSignatureFile({
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
    const signatureText = makeArchiveSignatureFile({
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
    const signatureText = makeArchiveSignatureFile({
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
    const signatureText = makeArchiveSignatureFile({
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
    const signatureText = makeArchiveSignatureFile({
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
    const signatureText = makeArchiveSignatureFile({
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

  it("accepts a prehashed signature emitted by the minisign CLI", () => {
    interface MinisignGoldenVector {
      readonly payload: string;
      readonly publicKey: string;
      readonly signature: string;
    }
    const vector: MinisignGoldenVector = JSON.parse(
      readFileSync(
        new URL("./fixtures/minisign-feed-golden.json", import.meta.url),
        "utf8",
      ),
    );
    const trustedKey = parseMinisignPublicKey(
      vector.publicKey,
      "minisign golden fixture",
    );

    const result = verifyMinisignPayload(
      vector.payload,
      vector.signature,
      "fixture://minisign-feed-golden",
      [trustedKey],
    );

    expect(result.algorithm).toBe("prehashed");
    expect(result.keyId).toBe(trustedKey.keyId);
  });
});
