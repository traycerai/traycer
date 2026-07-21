import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteCredentialsFile,
  readCredentialsFile,
  writeCredentialsFile,
  type StoredCredentials,
} from "../credentials";

const CREDS: StoredCredentials = {
  token: "access-token",
  refreshToken: "refresh-token",
  authnBaseUrl: "http://localhost:21001",
  savedAt: "2026-01-01T00:00:00.000Z",
  user: { id: "u1", email: "ada@traycer.ai", name: "Ada" },
};

const isWindows = process.platform === "win32";

describe("credentials primitives (real filesystem)", () => {
  let workDir: string;
  let credPath: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "traycer-credentials-test-"));
    // A not-yet-created subdir so the write primitive owns the mkdir.
    credPath = join(workDir, "cli", "dev", "credentials");
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  describe("readCredentialsFile", () => {
    it("returns null when the file is absent (ENOENT)", async () => {
      expect(await readCredentialsFile(credPath)).toBeNull();
    });

    it("returns null on malformed JSON", async () => {
      mkdirSync(join(workDir, "cli", "dev"), { recursive: true });
      writeFileSync(credPath, "{ not valid json");
      expect(await readCredentialsFile(credPath)).toBeNull();
    });

    it("returns null on a structurally-invalid payload", async () => {
      mkdirSync(join(workDir, "cli", "dev"), { recursive: true });
      writeFileSync(
        credPath,
        JSON.stringify({ token: "t", user: { id: "u1" } }),
      );
      expect(await readCredentialsFile(credPath)).toBeNull();
    });

    it("round-trips a valid payload", async () => {
      await writeCredentialsFile(credPath, CREDS, 0);
      expect(await readCredentialsFile(credPath)).toEqual(CREDS);
    });

    it("throws on a non-ENOENT I/O error (path is a directory)", async () => {
      mkdirSync(credPath, { recursive: true });
      await expect(readCredentialsFile(credPath)).rejects.toThrow();
    });
  });

  describe("writeCredentialsFile", () => {
    it("creates the parent dir at 0700 and the file at 0600", async () => {
      await writeCredentialsFile(credPath, CREDS, 0);
      expect(JSON.parse(readFileSync(credPath, "utf8"))).toEqual(CREDS);
      if (!isWindows) {
        expect(statSync(credPath).mode & 0o777).toBe(0o600);
        expect(statSync(join(workDir, "cli", "dev")).mode & 0o777).toBe(0o700);
      }
    });

    it("lands an mtime strictly above the file's prior mtime on every write", async () => {
      const first = await writeCredentialsFile(credPath, CREDS, 0);
      const second = await writeCredentialsFile(
        credPath,
        { ...CREDS, token: "rotated" },
        0,
      );
      expect(second.mtimeMs).toBeGreaterThan(first.mtimeMs);
      // The returned value matches what actually landed on disk.
      expect(statSync(credPath).mtimeMs).toBe(second.mtimeMs);
    });

    it("stamps a wall-clock 'now' mtime for a plain write, not epoch+1ms", async () => {
      const before = Date.now();
      const result = await writeCredentialsFile(credPath, CREDS, 0);
      // Regression: a floor of 0 must not drag the mtime back to ~1970.
      expect(result.mtimeMs).toBeGreaterThan(before - 2000);
      expect(result.mtimeMs).toBeLessThan(Date.now() + 2000);
    });

    it("honors an explicit future floor", async () => {
      const floorMs = Date.now() + 60_000;
      const result = await writeCredentialsFile(credPath, CREDS, floorMs);
      expect(result.mtimeMs).toBeGreaterThan(floorMs);
    });

    it("keeps the mtime increasing across a delete then recreate (carried floor)", async () => {
      const first = await writeCredentialsFile(credPath, CREDS, 0);
      await deleteCredentialsFile(credPath);
      // A fresh file's natural mtime would be ~now, which on a coarse-grained
      // clock can equal `first`. Carrying the prior mtime as the floor forces
      // the recreated file strictly newer, so the host owner-gate cache can
      // never serve a stale owner after a sign-out/sign-in.
      const recreated = await writeCredentialsFile(
        credPath,
        CREDS,
        first.mtimeMs,
      );
      expect(recreated.mtimeMs).toBeGreaterThan(first.mtimeMs);
    });
  });

  describe("deleteCredentialsFile", () => {
    it("returns true when it removed a present file", async () => {
      await writeCredentialsFile(credPath, CREDS, 0);
      expect(await deleteCredentialsFile(credPath)).toBe(true);
      expect(await readCredentialsFile(credPath)).toBeNull();
    });

    it("returns false when the file was already absent", async () => {
      expect(await deleteCredentialsFile(credPath)).toBe(false);
    });

    it("throws on a non-ENOENT failure (path is a directory)", async () => {
      mkdirSync(credPath, { recursive: true });
      await expect(deleteCredentialsFile(credPath)).rejects.toThrow();
    });
  });
});
