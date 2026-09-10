import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ILogger, LogFields } from "../../logger";
import type { HostInstallRecord } from "../../manifest/host-install";

const mocks = vi.hoisted(() => ({
  readHostInstallRecordMock: vi.fn(),
}));

// `readInstalledFloorOperands` reads `install.json` via `readHostInstallRecord`
// - genuine filesystem I/O against the operator's real `~/.traycer` if left
// unmocked, same hazard as `host-store-formats.test.ts`'s mock of the same
// function. `store/paths` needs no sandbox here: this module never resolves
// `hostHomeDir` itself, only the executable-relative `version.json` sidecar,
// which the mocked record's `executablePath` points at a temp dir.
vi.mock("../../manifest/host-install", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../manifest/host-install")>();
  return {
    ...actual,
    readHostInstallRecord: mocks.readHostInstallRecordMock,
  };
});

import { readInstalledFloorOperands } from "../installed-store-formats";

interface RecordedCall {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly message: string;
  readonly fields: LogFields;
}

function fakeLogger(): ILogger & { readonly calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    debug: (message, fields) => {
      calls.push({ level: "debug", message, fields });
    },
    info: (message, fields) => {
      calls.push({ level: "info", message, fields });
    },
    warn: (message, fields) => {
      calls.push({ level: "warn", message, fields });
    },
    error: (message, fields) => {
      calls.push({ level: "error", message, fields });
    },
  };
}

function sampleRecord(
  overrides: Partial<HostInstallRecord>,
): HostInstallRecord {
  return {
    installId: "install-1",
    version: "1.7.2",
    runtimeVersion: null,
    platform: "darwin",
    arch: "arm64",
    installedAt: "2026-01-01T00:00:00.000Z",
    source: { kind: "registry", value: "1.7.2" },
    archiveSha256: "a".repeat(64),
    signatureVerifiedAt: "2026-01-01T00:00:00.000Z",
    signatureKeyId: "test-key",
    sizeBytes: 1,
    executablePath: "/nonexistent/traycer-host",
    executableSha256: null,
    ...overrides,
  };
}

let executableDir: string;

beforeEach(async () => {
  executableDir = await mkdtemp(
    join(tmpdir(), "installed-store-formats-test-"),
  );
});

afterEach(async () => {
  await rm(executableDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("readInstalledFloorOperands", () => {
  it("returns nothing known when there is no install record", async () => {
    mocks.readHostInstallRecordMock.mockResolvedValue(null);
    const logger = fakeLogger();

    await expect(
      readInstalledFloorOperands("production", logger),
    ).resolves.toEqual({ version: null, storeFormats: null });
  });

  it("returns nothing known, with a warn, when the install record read throws", async () => {
    mocks.readHostInstallRecordMock.mockRejectedValue(
      new Error("simulated corrupt install.json"),
    );
    const logger = fakeLogger();

    await expect(
      readInstalledFloorOperands("production", logger),
    ).resolves.toEqual({ version: null, storeFormats: null });

    const warnCall = logger.calls.find((call) => call.level === "warn");
    expect(warnCall).toBeDefined();
    expect(warnCall?.message).toContain("could not read the install record");
  });

  it("returns the version and the tree's declared storeFormats when the sidecar is readable", async () => {
    const executablePath = join(executableDir, "traycer-host");
    await writeFile(
      join(executableDir, "version.json"),
      JSON.stringify({ version: "1.7.2", storeFormats: { chatDb: 9 } }),
      "utf8",
    );
    mocks.readHostInstallRecordMock.mockResolvedValue(
      sampleRecord({ version: "1.7.2", executablePath }),
    );
    const logger = fakeLogger();

    await expect(
      readInstalledFloorOperands("production", logger),
    ).resolves.toEqual({ version: "1.7.2", storeFormats: { chatDb: 9 } });
  });

  it("still returns the version, with storeFormats: null and a warn, when the record's executablePath is missing", async () => {
    // The regression this pins: `dirname(record.executablePath)` throws a
    // TypeError for an `undefined` path - not something `HostInstallRecord`'s
    // type allows, but exactly what a truncated or hand-edited install.json
    // looks like on disk. An unguarded throw here used to escape
    // `readInstalledFloorOperands` entirely and take down `host ensure`, a
    // command whose whole job is converging a broken machine back to a
    // working host.
    const malformedRecord = sampleRecord({ version: "1.7.2" });
    const { executablePath: _drop, ...withoutExecutablePath } = malformedRecord;
    mocks.readHostInstallRecordMock.mockResolvedValue(
      withoutExecutablePath as HostInstallRecord,
    );
    const logger = fakeLogger();

    await expect(
      readInstalledFloorOperands("production", logger),
    ).resolves.toEqual({ version: "1.7.2", storeFormats: null });

    const warnCall = logger.calls.find((call) => call.level === "warn");
    expect(warnCall).toBeDefined();
    expect(warnCall?.message).toContain(
      "could not read the installed tree's declaration",
    );
  });
});
