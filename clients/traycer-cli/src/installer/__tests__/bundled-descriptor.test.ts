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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ParsedMinisignPublicKey } from "../../registry/trusted-keys";

const trusted = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("../../registry/trusted-keys", () => ({
  loadTrustedKeys: trusted.load,
}));

import { config } from "../../config";
import { currentHostPlatformKey } from "../../registry/platform-key";
import {
  readBundledHostDescriptor,
  verifyBundledHostArchive,
} from "../bundled-descriptor";

interface SigningKey {
  readonly trusted: ParsedMinisignPublicKey;
  readonly keyId: Buffer;
  readonly privateKey: KeyObject;
}

function makeKey(): SigningKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const keyId = randomBytes(8);
  return {
    trusted: {
      raw: "test signing key",
      keyId: keyId.toString("hex"),
      publicKey: new Uint8Array(spki.subarray(12)),
    },
    keyId,
    privateKey,
  };
}

function signBytes(path: string, key: SigningKey): string {
  const bytes = readFileSync(path);
  const digest = createHash("blake2b512").update(bytes).digest();
  const archiveSignature = sign(null, digest, key.privateKey);
  const trustedComment = "traycer-host descriptor fixture";
  const globalSignature = sign(
    null,
    Buffer.concat([archiveSignature, Buffer.from(trustedComment)]),
    key.privateKey,
  );
  const payload = Buffer.concat([
    Buffer.from("ED", "ascii"),
    key.keyId,
    archiveSignature,
  ]);
  return [
    "untrusted comment: signature from test fixture",
    payload.toString("base64"),
    `trusted comment: ${trustedComment}`,
    globalSignature.toString("base64"),
    "",
  ].join("\n");
}

let root: string;
let archivePath: string;
let descriptorPath: string;
let signingKey: SigningKey;
let originalPin: string | null;

function writeDescriptor(overrides: Record<string, unknown>): void {
  const archive = readFileSync(archivePath);
  const descriptor = {
    version: "1.5.3",
    platformKey: currentHostPlatformKey(),
    sha256: createHash("sha256").update(archive).digest("hex"),
    sizeBytes: archive.byteLength,
    publicKeyId: signingKey.trusted.keyId,
    requiredCliVersion: null,
    minimumEpoch: 2,
    storeFormats: { chatDb: 22 },
    canonicalUrl: "https://releases.example.invalid/host/1.5.3/runtime.tar.gz",
    ...overrides,
  };
  writeFileSync(descriptorPath, JSON.stringify(descriptor));
  writeFileSync(
    `${descriptorPath}.minisig`,
    signBytes(descriptorPath, signingKey),
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "traycer-bundled-descriptor-"));
  archivePath = join(root, "host-runtime.tar.gz");
  descriptorPath = join(
    root,
    `host-runtime-${currentHostPlatformKey()}.descriptor.json`,
  );
  writeFileSync(archivePath, Buffer.from("throwaway signed host archive"));
  signingKey = makeKey();
  originalPin = config.supportedHostVersion;
  config.supportedHostVersion = null;
  trusted.load.mockResolvedValue({
    keys: [signingKey.trusted],
    sources: ["test"],
  });
});

afterEach(() => {
  config.supportedHostVersion = originalPin;
  rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("bundled host descriptor verification", () => {
  it("accepts a signed descriptor and verifies the matching archive with the same trusted key", async () => {
    writeDescriptor({});
    writeFileSync(`${archivePath}.minisig`, signBytes(archivePath, signingKey));

    const descriptor = await readBundledHostDescriptor(archivePath);
    const verified = await verifyBundledHostArchive(archivePath, descriptor);

    expect(descriptor.version).toBe("1.5.3");
    expect(descriptor.minimumEpoch).toBe(2);
    expect(descriptor.storeFormats.chatDb).toBe(22);
    expect(verified.signatureKeyId).toBe(signingKey.trusted.keyId);
    expect(verified.archiveSha256).toBe(descriptor.sha256);
  });

  it("accepts a descriptor key id with uppercase hex digits", async () => {
    writeDescriptor({ publicKeyId: signingKey.trusted.keyId.toUpperCase() });
    writeFileSync(`${archivePath}.minisig`, signBytes(archivePath, signingKey));

    const descriptor = await readBundledHostDescriptor(archivePath);
    const verified = await verifyBundledHostArchive(archivePath, descriptor);

    expect(verified.signatureKeyId).toBe(signingKey.trusted.keyId);
  });

  it("rejects a descriptor whose signed bytes were changed", async () => {
    writeDescriptor({});
    writeFileSync(descriptorPath, `${readFileSync(descriptorPath, "utf8")} `);

    await expect(readBundledHostDescriptor(archivePath)).rejects.toThrow(
      /descriptor/i,
    );
  });

  it("rejects a descriptor signed by a key outside the trusted set", async () => {
    const otherKey = makeKey();
    writeDescriptor({ publicKeyId: otherKey.trusted.keyId });
    writeFileSync(
      `${descriptorPath}.minisig`,
      signBytes(descriptorPath, otherKey),
    );

    await expect(readBundledHostDescriptor(archivePath)).rejects.toThrow(
      /trusted|key/i,
    );
  });

  it("rejects archive bytes whose size changed after the descriptor was signed", async () => {
    writeDescriptor({});
    const descriptor = await readBundledHostDescriptor(archivePath);
    writeFileSync(`${archivePath}.minisig`, signBytes(archivePath, signingKey));
    writeFileSync(archivePath, "archive grew after signing");

    await expect(
      verifyBundledHostArchive(archivePath, descriptor),
    ).rejects.toThrow(/size or sha256/i);
  });

  it("rejects same-size archive corruption through the digest check", async () => {
    writeDescriptor({});
    const descriptor = await readBundledHostDescriptor(archivePath);
    writeFileSync(`${archivePath}.minisig`, signBytes(archivePath, signingKey));
    const changedBytes = Buffer.from("Xhrowaway signed host archive");
    expect(changedBytes.byteLength).toBe(descriptor.sizeBytes);
    writeFileSync(archivePath, changedBytes);

    await expect(
      verifyBundledHostArchive(archivePath, descriptor),
    ).rejects.toThrow(/size or sha256/i);
  });

  it("requires the archive signature to use the descriptor's signing key", async () => {
    const archiveKey = makeKey();
    writeDescriptor({});
    trusted.load.mockResolvedValue({
      keys: [signingKey.trusted, archiveKey.trusted],
      sources: ["test"],
    });
    writeFileSync(`${archivePath}.minisig`, signBytes(archivePath, archiveKey));
    const descriptor = await readBundledHostDescriptor(archivePath);

    await expect(
      verifyBundledHostArchive(archivePath, descriptor),
    ).rejects.toThrow(/signature key id does not match publicKeyId/i);
  });

  it("rejects a signed descriptor whose publicKeyId disagrees with its signer", async () => {
    writeDescriptor({ publicKeyId: "fedcba9876543210" });

    await expect(readBundledHostDescriptor(archivePath)).rejects.toThrow(
      /publicKeyId does not match descriptor signature/i,
    );
  });

  it("rejects a correctly signed descriptor for another platform", async () => {
    writeDescriptor({
      platformKey:
        currentHostPlatformKey() === "linux-x64" ? "linux-arm64" : "linux-x64",
    });

    await expect(readBundledHostDescriptor(archivePath)).rejects.toThrow(
      /platform/i,
    );
  });

  it("rejects a descriptor version that differs from a pinned CLI build", async () => {
    config.supportedHostVersion = "1.5.4";
    writeDescriptor({});

    await expect(readBundledHostDescriptor(archivePath)).rejects.toThrow(
      /pin/i,
    );
  });

  it("reports a missing descriptor at the descriptor-reader boundary", async () => {
    await expect(readBundledHostDescriptor(archivePath)).rejects.toThrow(
      /descriptor/i,
    );
  });
});
