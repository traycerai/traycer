import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isRegistrationIdentityApplied,
  markRegistrationIdentityApplied,
  readRegistrationStamp,
  registrationStampMatches,
  resetRegistrationStampLatchForTests,
  writeRegistrationStamp,
} from "../registration-stamp";

vi.mock("../../app/logger", () => ({
  log: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const getHostFsLayout = vi.fn();
vi.mock("../host-paths", () => ({
  getHostFsLayout: (environment: string) => getHostFsLayout(environment),
}));

let dir: string;
function stampPath(): string {
  return join(dir, "registration-stamp.json");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "traycer-registration-stamp-"));
  getHostFsLayout.mockReset().mockReturnValue({
    registrationStampFile: stampPath(),
  });
  resetRegistrationStampLatchForTests();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("registration stamp read/write", () => {
  it("reads null when the stamp is absent (a mismatch → one cycle)", async () => {
    expect(await readRegistrationStamp("production")).toBeNull();
    expect(await registrationStampMatches("production", "x")).toBe(false);
  });

  it("round-trips a written identity", async () => {
    expect(await writeRegistrationStamp("production", "build.1.abc")).toBe(
      true,
    );
    expect(await readRegistrationStamp("production")).toBe("build.1.abc");
    expect(await registrationStampMatches("production", "build.1.abc")).toBe(
      true,
    );
    expect(await registrationStampMatches("production", "build.2.def")).toBe(
      false,
    );
  });

  it("treats a corrupt stamp file as a mismatch, never a throw", async () => {
    writeFileSync(stampPath(), "{ not json");
    expect(await readRegistrationStamp("production")).toBeNull();
    expect(await registrationStampMatches("production", "anything")).toBe(
      false,
    );
  });

  it("treats a well-formed but wrong-shaped stamp as a mismatch", async () => {
    writeFileSync(stampPath(), JSON.stringify({ notIdentity: "build.1" }));
    expect(await readRegistrationStamp("production")).toBeNull();
  });

  it("treats an empty-string identity as a mismatch", async () => {
    writeFileSync(stampPath(), JSON.stringify({ identity: "" }));
    expect(await readRegistrationStamp("production")).toBeNull();
  });

  it("returns false when the write fails (a plain file where the dir must go)", async () => {
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "not a directory");
    getHostFsLayout.mockReturnValue({
      registrationStampFile: join(blocker, "registration-stamp.json"),
    });
    expect(await writeRegistrationStamp("production", "build.1")).toBe(false);
  });
});

describe("in-launch applied latch", () => {
  it("suppresses the stamp-mismatch reason for exactly the applied identity", () => {
    expect(isRegistrationIdentityApplied("build.1")).toBe(false);
    markRegistrationIdentityApplied("build.1");
    expect(isRegistrationIdentityApplied("build.1")).toBe(true);
    // A different identity is not covered by the latch.
    expect(isRegistrationIdentityApplied("build.2")).toBe(false);
  });

  it("resets between launches", () => {
    markRegistrationIdentityApplied("build.1");
    resetRegistrationStampLatchForTests();
    expect(isRegistrationIdentityApplied("build.1")).toBe(false);
  });
});
