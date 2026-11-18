import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isPrefixOfVerifiedFile,
  isTempNonce,
  newTempNonce,
  ownedTempNonces,
  recordOwnedTempNonce,
  removeOwnedTempRecords,
} from "../byte-evidence";

function sha(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("byte evidence", () => {
  let root = "";

  beforeEach(async () => {
    root = await realpath(
      await mkdtemp(join(tmpdir(), "traycer-byte-evidence-")),
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe("newTempNonce", () => {
    it("is 32 lowercase hex characters and fresh each call", () => {
      const first = newTempNonce();
      const second = newTempNonce();
      expect(first).toMatch(/^[0-9a-f]{32}$/u);
      expect(isTempNonce(first)).toBe(true);
      expect(second).not.toBe(first);
    });

    it("isTempNonce rejects other shapes", () => {
      expect(isTempNonce("")).toBe(false);
      expect(isTempNonce("a".repeat(31))).toBe(false);
      expect(isTempNonce("A".repeat(32))).toBe(false);
      expect(isTempNonce("g".repeat(32))).toBe(false);
    });
  });

  describe("owned nonce records", () => {
    it("an absent folder holds no nonces", async () => {
      expect([...(await ownedTempNonces(join(root, "missing")))]).toEqual([]);
    });

    it("records a nonce durably and reads it back", async () => {
      const evidenceDir = join(root, "evidence");
      const nonce = newTempNonce();
      await recordOwnedTempNonce({
        evidenceDir,
        nonce,
        purpose: "copy",
        createdAt: "2026-01-01T00:00:00.000Z",
        platform: process.platform,
      });
      expect([...(await ownedTempNonces(evidenceDir))]).toEqual([nonce]);
    });

    it("a second record of the same nonce throws EEXIST", async () => {
      const evidenceDir = join(root, "evidence");
      const nonce = newTempNonce();
      const input = {
        evidenceDir,
        nonce,
        purpose: "inventory" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
        platform: process.platform,
      };
      await recordOwnedTempNonce(input);
      await expect(recordOwnedTempNonce(input)).rejects.toMatchObject({
        code: "EEXIST",
      });
    });

    it("ignores names in the folder that are not nonces", async () => {
      const evidenceDir = join(root, "evidence");
      const nonce = newTempNonce();
      await recordOwnedTempNonce({
        evidenceDir,
        nonce,
        purpose: "copy",
        createdAt: "2026-01-01T00:00:00.000Z",
        platform: process.platform,
      });
      await writeFile(join(evidenceDir, "owned-temps", "not-a-nonce"), "x");
      await writeFile(join(evidenceDir, "owned-temps", "ABCDEF"), "x");
      expect([...(await ownedTempNonces(evidenceDir))]).toEqual([nonce]);
    });

    it("removeOwnedTempRecords removes the records and then the empty folder", async () => {
      const evidenceDir = join(root, "evidence");
      const first = newTempNonce();
      const second = newTempNonce();
      for (const nonce of [first, second]) {
        await recordOwnedTempNonce({
          evidenceDir,
          nonce,
          purpose: "copy",
          createdAt: "2026-01-01T00:00:00.000Z",
          platform: process.platform,
        });
      }
      await removeOwnedTempRecords(evidenceDir, new Set([first, second]));
      expect(await readdir(evidenceDir)).toEqual([]);
      // Idempotent on an already-clean folder.
      await removeOwnedTempRecords(evidenceDir, new Set([first, second]));
    });

    it("removeOwnedTempRecords keeps the folder while a foreign entry remains", async () => {
      const evidenceDir = join(root, "evidence");
      const nonce = newTempNonce();
      await recordOwnedTempNonce({
        evidenceDir,
        nonce,
        purpose: "copy",
        createdAt: "2026-01-01T00:00:00.000Z",
        platform: process.platform,
      });
      await writeFile(
        join(evidenceDir, "owned-temps", "someone-elses.txt"),
        "keep",
      );
      await removeOwnedTempRecords(evidenceDir, new Set([nonce]));
      expect(await readdir(join(evidenceDir, "owned-temps"))).toEqual([
        "someone-elses.txt",
      ]);
    });
  });

  describe("isPrefixOfVerifiedFile", () => {
    const REFERENCE = Buffer.from("0123456789abcdef");

    async function setup(
      candidateBytes: Buffer,
    ): Promise<{ candidate: string; reference: string }> {
      const reference = join(root, "reference");
      const candidate = join(root, "candidate");
      await writeFile(reference, REFERENCE);
      await writeFile(candidate, candidateBytes);
      return { candidate, reference };
    }

    it("is true for a proper prefix", async () => {
      const { candidate, reference } = await setup(REFERENCE.subarray(0, 5));
      expect(
        await isPrefixOfVerifiedFile({
          candidate,
          reference,
          referenceSha256: sha(REFERENCE),
          platform: process.platform,
        }),
      ).toBe(true);
    });

    it("is true for an equal candidate", async () => {
      const { candidate, reference } = await setup(REFERENCE);
      expect(
        await isPrefixOfVerifiedFile({
          candidate,
          reference,
          referenceSha256: sha(REFERENCE),
          platform: process.platform,
        }),
      ).toBe(true);
    });

    it("is true for an empty candidate against a good reference", async () => {
      const { candidate, reference } = await setup(Buffer.alloc(0));
      expect(
        await isPrefixOfVerifiedFile({
          candidate,
          reference,
          referenceSha256: sha(REFERENCE),
          platform: process.platform,
        }),
      ).toBe(true);
    });

    it("is false for a longer candidate", async () => {
      const { candidate, reference } = await setup(
        Buffer.concat([REFERENCE, Buffer.from("!")]),
      );
      expect(
        await isPrefixOfVerifiedFile({
          candidate,
          reference,
          referenceSha256: sha(REFERENCE),
          platform: process.platform,
        }),
      ).toBe(false);
    });

    it("is false for mismatched bytes of the same length or shorter", async () => {
      const { candidate, reference } = await setup(Buffer.from("0123X"));
      expect(
        await isPrefixOfVerifiedFile({
          candidate,
          reference,
          referenceSha256: sha(REFERENCE),
          platform: process.platform,
        }),
      ).toBe(false);
    });

    it("is false when the reference no longer hashes to the digest", async () => {
      const { candidate, reference } = await setup(REFERENCE.subarray(0, 5));
      expect(
        await isPrefixOfVerifiedFile({
          candidate,
          reference,
          referenceSha256: sha(Buffer.from("other")),
          platform: process.platform,
        }),
      ).toBe(false);
    });

    it("is false when a file is missing", async () => {
      const { reference } = await setup(Buffer.alloc(0));
      expect(
        await isPrefixOfVerifiedFile({
          candidate: join(root, "absent"),
          reference,
          referenceSha256: sha(REFERENCE),
          platform: process.platform,
        }),
      ).toBe(false);
      expect(
        await isPrefixOfVerifiedFile({
          candidate: reference,
          reference: join(root, "absent"),
          referenceSha256: sha(REFERENCE),
          platform: process.platform,
        }),
      ).toBe(false);
    });

    it.skipIf(process.platform === "win32")(
      "is false for a symlink candidate or reference",
      async () => {
        const { candidate, reference } = await setup(REFERENCE.subarray(0, 5));
        const linkedCandidate = join(root, "linked-candidate");
        const linkedReference = join(root, "linked-reference");
        await symlink(candidate, linkedCandidate);
        await symlink(reference, linkedReference);
        const referenceSha256 = sha(REFERENCE);
        expect(
          await isPrefixOfVerifiedFile({
            candidate: linkedCandidate,
            reference,
            referenceSha256,
            platform: "linux",
          }),
        ).toBe(false);
        expect(
          await isPrefixOfVerifiedFile({
            candidate,
            reference: linkedReference,
            referenceSha256,
            platform: "linux",
          }),
        ).toBe(false);
      },
    );

    it.skipIf(process.platform === "win32")(
      "is false for a directory",
      async () => {
        const { reference } = await setup(Buffer.alloc(0));
        const directory = join(root, "dir");
        await mkdir(directory);
        expect(
          await isPrefixOfVerifiedFile({
            candidate: directory,
            reference,
            referenceSha256: sha(REFERENCE),
            platform: "linux",
          }),
        ).toBe(false);
        expect(
          await isPrefixOfVerifiedFile({
            candidate: reference,
            reference: directory,
            referenceSha256: sha(REFERENCE),
            platform: "linux",
          }),
        ).toBe(false);
      },
    );

    it("compares across chunk boundaries for a multi-megabyte file", async () => {
      const big = Buffer.alloc(2 * 1024 * 1024 + 123, 7);
      const reference = join(root, "big-reference");
      const candidate = join(root, "big-candidate");
      await writeFile(reference, big);
      await writeFile(candidate, big.subarray(0, 1024 * 1024 + 5));
      expect(
        await isPrefixOfVerifiedFile({
          candidate,
          reference,
          referenceSha256: sha(big),
          platform: process.platform,
        }),
      ).toBe(true);
      const damaged = Buffer.from(big.subarray(0, 1024 * 1024 + 5));
      damaged[1024 * 1024 + 4] = 9;
      await writeFile(candidate, damaged);
      expect(
        await isPrefixOfVerifiedFile({
          candidate,
          reference,
          referenceSha256: sha(big),
          platform: process.platform,
        }),
      ).toBe(false);
    });
  });
});
