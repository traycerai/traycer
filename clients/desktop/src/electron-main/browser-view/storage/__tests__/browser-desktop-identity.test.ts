import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalDesktopIdentityAttestBytes } from "@traycer/protocol/host/browser/contracts";
import {
  attestDesktopIdentity,
  browserDesktopIdentityFilePath,
  resetDesktopIdentityForTests,
} from "../browser-desktop-identity";

/**
 * The desktop half of H09. Nothing here is stubbed below the keystore: the
 * signature is produced by the real `node:crypto` and verified the way the host
 * verifies it, through the contract's own canonical-bytes helper - a stub in
 * between would let the two sides drift and still pass.
 */
const userData = { path: "" };
const keystore = {
  encrypting: true,
  backend: "gnome_libsecret",
  encrypt: vi.fn((value: string) => Buffer.from(value, "utf8")),
  decrypt: vi.fn((blob: Buffer) => blob.toString("utf8")),
};

vi.mock("electron", () => ({
  app: { getPath: () => userData.path },
  safeStorage: {
    isEncryptionAvailable: () => keystore.encrypting,
    getSelectedStorageBackend: () => keystore.backend,
    // The real keystore is opaque; a reversible stand-in is enough, and the
    // test never asserts on its bytes - only that the private half stays here.
    encryptString: (value: string) => keystore.encrypt(value),
    decryptString: (blob: Buffer) => keystore.decrypt(blob),
  },
}));

vi.mock("../../../app/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  describeLogError: (error: unknown) => String(error),
}));

/** R3-7: lets one durable write from the identity store be forced to reject. */
const writeGate = { failNext: false };
vi.mock("../../../app/json-file-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../app/json-file-store")>();
  return {
    ...actual,
    createJsonFileStore: <T>(
      ...args: Parameters<typeof actual.createJsonFileStore<T>>
    ) => {
      const store = actual.createJsonFileStore<T>(...args);
      return {
        ...store,
        saveStrict: async (value: T): Promise<void> => {
          if (writeGate.failNext) {
            writeGate.failNext = false;
            throw new Error("simulated durable-write failure");
          }
          await store.saveStrict(value);
        },
      };
    },
  };
});

const HOST_ID = "host-1";
const NONCE = Buffer.alloc(32, 7).toString("base64");

describe("this installation's browser identity", () => {
  beforeEach(async () => {
    userData.path = await mkdtemp(join(tmpdir(), "desktop-identity-"));
    keystore.encrypting = true;
    keystore.backend = "gnome_libsecret";
    keystore.encrypt.mockClear();
    keystore.decrypt.mockClear();
    writeGate.failNext = false;
    resetDesktopIdentityForTests();
  });

  afterEach(async () => {
    await rm(userData.path, { recursive: true, force: true });
  });

  it("mints one identity, signs the host's canonical bytes with it, and reuses it", async () => {
    const first = await attestDesktopIdentity({
      hostId: HOST_ID,
      nonce: NONCE,
    });
    if (first === null) throw new Error("expected an attestation");

    // Verified exactly as the host verifies it.
    expect(
      cryptoVerify(
        null,
        canonicalDesktopIdentityAttestBytes({
          hostId: HOST_ID,
          nonce: NONCE,
          publicKey: first.publicKey,
        }),
        createPublicKey({
          key: Buffer.from(first.publicKey, "base64"),
          format: "der",
          type: "spki",
        }),
        Buffer.from(first.signature, "base64"),
      ),
    ).toBe(true);

    // A second challenge is answered by the SAME machine: a fresh key each
    // time would be refused by every host that had already enrolled this one.
    resetDesktopIdentityForTests();
    const second = await attestDesktopIdentity({
      hostId: HOST_ID,
      nonce: Buffer.alloc(32, 9).toString("base64"),
    });
    expect(second?.publicKey).toBe(first.publicKey);
    expect(second?.keystoreId).toBe(first.keystoreId);
    expect(second?.signature).not.toBe(first.signature);
  });

  it("mints ONE key when two hosts challenge in the same tick", async () => {
    // A co-located host and a relay host both challenge on attach. Memoising
    // only the settled record would let both find nothing, both mint, and the
    // second write win - leaving the two hosts holding different keys for one
    // machine, and the loser refusing this desktop over the relay for good.
    const [local, relay] = await Promise.all([
      attestDesktopIdentity({ hostId: HOST_ID, nonce: NONCE }),
      attestDesktopIdentity({ hostId: "host-2", nonce: NONCE }),
    ]);
    expect(local?.publicKey).toBeDefined();
    expect(relay?.publicKey).toBe(local?.publicKey);
    expect(relay?.keystoreId).toBe(local?.keystoreId);
    // And that one key is the one on disk.
    const stored: unknown = JSON.parse(
      await readFile(browserDesktopIdentityFilePath(), "utf8"),
    );
    expect((stored as { readonly publicKey: string }).publicKey).toBe(
      local?.publicKey,
    );
  });

  it("signs the challenge it was given, not some other host's", async () => {
    const attestation = await attestDesktopIdentity({
      hostId: HOST_ID,
      nonce: NONCE,
    });
    if (attestation === null) throw new Error("expected an attestation");
    const key = createPublicKey({
      key: Buffer.from(attestation.publicKey, "base64"),
      format: "der",
      type: "spki",
    });
    for (const forged of [
      { hostId: "host-elsewhere", nonce: NONCE },
      { hostId: HOST_ID, nonce: Buffer.alloc(32, 1).toString("base64") },
    ]) {
      expect(
        cryptoVerify(
          null,
          canonicalDesktopIdentityAttestBytes({
            ...forged,
            publicKey: attestation.publicKey,
          }),
          key,
          Buffer.from(attestation.signature, "base64"),
        ),
      ).toBe(false);
    }
  });

  it("V-9: is jarEligible on an encrypting keystore, with the private half wrapped by safeStorage", async () => {
    const attestation = await attestDesktopIdentity({
      hostId: HOST_ID,
      nonce: NONCE,
    });
    if (attestation === null) throw new Error("expected an attestation");

    expect(attestation.jarEligible).toBe(true);
    expect(keystore.encrypt).toHaveBeenCalled();
  });

  it("V-9: still attests on a keystore that does not encrypt, with jarEligible: false and no wrap call", async () => {
    // `basic_text` is a Linux-only backend, and the refusal is asked only
    // there, so the platform has to be the real input. Tying placement to the
    // wrapped key would refuse such a machine a native tab entirely, so it
    // must still mint and attest - just never claim eligibility for the
    // encrypted jar slice.
    const platform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      keystore.backend = "basic_text";
      const attestation = await attestDesktopIdentity({
        hostId: HOST_ID,
        nonce: NONCE,
      });
      if (attestation === null) throw new Error("expected an attestation");

      expect(attestation.jarEligible).toBe(false);
      expect(keystore.encrypt).not.toHaveBeenCalled();
      // Still a valid signature over the same canonical bytes as the
      // encrypting case - the downgrade is only in `jarEligible`.
      expect(
        cryptoVerify(
          null,
          canonicalDesktopIdentityAttestBytes({
            hostId: HOST_ID,
            nonce: NONCE,
            publicKey: attestation.publicKey,
          }),
          createPublicKey({
            key: Buffer.from(attestation.publicKey, "base64"),
            format: "der",
            type: "spki",
          }),
          Buffer.from(attestation.signature, "base64"),
        ),
      ).toBe(true);

      // Durable across a restart: the same key comes back, not a fresh one.
      resetDesktopIdentityForTests();
      const second = await attestDesktopIdentity({
        hostId: HOST_ID,
        nonce: Buffer.alloc(32, 9).toString("base64"),
      });
      expect(second?.publicKey).toBe(attestation.publicKey);
      expect(second?.jarEligible).toBe(false);
    } finally {
      Object.defineProperty(process, "platform", { value: platform });
    }
  });

  it("R3-7: clears the mint memo on a rejected durable write, so recovery is not refused forever", async () => {
    // resetDesktopIdentityForTests() is teardown-only and must not be used
    // here to paper over the rejection - the pin is that the module clears
    // its OWN memo when the mint's write rejects.
    writeGate.failNext = true;

    await expect(
      attestDesktopIdentity({ hostId: HOST_ID, nonce: NONCE }),
    ).rejects.toThrow();

    // The store recovers on the next attempt (writeGate.failNext already
    // consumed itself). A cached rejection would keep refusing forever.
    const attestation = await attestDesktopIdentity({
      hostId: HOST_ID,
      nonce: NONCE,
    });
    expect(attestation).not.toBeNull();
  });

  it("keeps the private half wrapped, and never puts it in the attestation", async () => {
    const attestation = await attestDesktopIdentity({
      hostId: HOST_ID,
      nonce: NONCE,
    });
    if (attestation === null) throw new Error("expected an attestation");
    const record: unknown = JSON.parse(
      await readFile(browserDesktopIdentityFilePath(), "utf8"),
    );
    const stored = record as { readonly wrappedPrivateKey: string };
    expect(stored.wrappedPrivateKey.length).toBeGreaterThan(0);
    // The wire shape carries four fields, and the wrapped key is not one of
    // them - nor is the PKCS8 the wrap opens.
    expect(Object.keys(attestation).sort()).toEqual([
      "jarEligible",
      "keystoreId",
      "publicKey",
      "signature",
    ]);
    expect(JSON.stringify(attestation)).not.toContain(stored.wrappedPrivateKey);
  });
});
