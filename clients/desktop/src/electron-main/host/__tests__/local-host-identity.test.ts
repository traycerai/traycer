import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => "/tmp"),
    isPackaged: false,
    getAppPath: vi.fn(() => "/tmp"),
  },
}));

vi.mock("electron-log", () => ({
  default: {
    transports: { file: { level: "info" }, console: { level: "info" } },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  classifyLocalHostIdentity,
  readLastKnownLocalHostId,
} from "../local-host-identity";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "traycer-local-host-identity-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function files(): {
  readonly identityEnrollmentFile: string;
  readonly pidMetadataFile: string;
} {
  return {
    identityEnrollmentFile: join(workDir, "enrollment.json"),
    pidMetadataFile: join(workDir, "pid.json"),
  };
}

function writeEnrollment(hostId: string): void {
  writeFileSync(files().identityEnrollmentFile, JSON.stringify({ hostId }));
}

function writePid(hostId: string): void {
  writeFileSync(
    files().pidMetadataFile,
    JSON.stringify({
      hostId,
      websocketUrl: "ws://127.0.0.1:1/rpc",
      version: "1.1.11",
      pid: 42,
    }),
  );
}

describe("classifyLocalHostIdentity", () => {
  it("returns named from a valid enrollment record", async () => {
    writeEnrollment("host-enrolled");
    writePid("host-from-pid");
    await expect(classifyLocalHostIdentity(files())).resolves.toEqual({
      kind: "named",
      hostId: "host-enrolled",
    });
    await expect(readLastKnownLocalHostId(files())).resolves.toBe(
      "host-enrolled",
    );
  });

  it("returns unverifiable when the enrollment record exists but cannot answer, without consulting pid", async () => {
    // Discriminator: collapsing this to null (the old fence) would allow
    // the write; consulting pid would name host-from-pid. The record
    // existing proves enrollment machinery, so an unreadable one is the
    // re-enrollment window.
    mkdirSync(workDir, { recursive: true });
    writeFileSync(files().identityEnrollmentFile, "{not-json");
    writePid("host-from-pid");
    await expect(classifyLocalHostIdentity(files())).resolves.toEqual({
      kind: "unverifiable",
    });
    await expect(readLastKnownLocalHostId(files())).resolves.toBeNull();
  });

  it("returns unverifiable when enrollment is present but missing hostId, without consulting pid", async () => {
    writeFileSync(files().identityEnrollmentFile, JSON.stringify({}));
    writePid("host-from-pid");
    await expect(classifyLocalHostIdentity(files())).resolves.toEqual({
      kind: "unverifiable",
    });
  });

  it("falls back to pid when enrollment is absent", async () => {
    writePid("host-from-pid");
    await expect(classifyLocalHostIdentity(files())).resolves.toEqual({
      kind: "named",
      hostId: "host-from-pid",
    });
    await expect(readLastKnownLocalHostId(files())).resolves.toBe(
      "host-from-pid",
    );
  });

  it("returns unenrolled when nothing on disk names a host", async () => {
    await expect(classifyLocalHostIdentity(files())).resolves.toEqual({
      kind: "unenrolled",
    });
    await expect(readLastKnownLocalHostId(files())).resolves.toBeNull();
  });
});
