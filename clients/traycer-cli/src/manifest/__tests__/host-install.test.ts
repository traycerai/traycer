import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Pin every environment-aware path helper at a sandbox under tmpdir so the
// writer can mkdir + rename without touching the real user home. We
// register the mock up-front via vi.mock and let each test rebind the
// sandbox root through `__setSandbox` exposed on the mock module.
let sandboxRoot = "";

vi.mock("../../store/paths", async () => {
  const actual =
    await vi.importActual<typeof import("../../store/paths")>(
      "../../store/paths",
    );
  type Environment = "dev" | "production";
  const hostHomeFor = (environment: Environment | undefined): string => {
    const base = join(sandboxRoot, "host");
    if (environment === "dev") return join(base, "dev");
    return base;
  };
  const installDirFor = (environment: Environment): string =>
    join(hostHomeFor(environment), "install");
  const recordPathFor = (environment: Environment): string =>
    join(installDirFor(environment), "install.json");
  return {
    ...actual,
    hostHomeDir: (environment: Environment | undefined) =>
      hostHomeFor(environment),
    hostInstallDir: (environment: Environment) => installDirFor(environment),
    hostInstallRecordPath: (environment: Environment) =>
      recordPathFor(environment),
    ensureHostInstallDir: async (environment: Environment) => {
      mkdirSync(installDirFor(environment), { recursive: true });
    },
  };
});

// Imports must come AFTER the vi.mock call so the mocked module is in
// place when host-install resolves `../store/paths`.
import * as paths from "../../store/paths";
import {
  deleteHostInstallRecord,
  readHostInstallRecord,
  writeHostInstallRecord,
  type HostInstallRecord,
} from "../host-install";

function sampleRecord(version: string): HostInstallRecord {
  return {
    version,
    platform: "darwin",
    arch: "arm64",
    installedAt: "2026-05-15T00:00:00.000Z",
    source: { kind: "registry", value: version },
    archiveSha256: "a".repeat(64),
    signatureVerifiedAt: "2026-05-15T00:00:00.000Z",
    signatureKeyId: "test-key",
    sizeBytes: 1234,
    executablePath: "/tmp/traycer-host",
  };
}

describe("manifest/host-install - install record I/O", () => {
  beforeEach(() => {
    sandboxRoot = mkdtempSync(join(tmpdir(), "traycer-cli-paths-"));
  });

  afterEach(() => {
    rmSync(sandboxRoot, { recursive: true, force: true });
  });

  it("writes the prod record at <hostInstallDir>/install.json", async () => {
    await writeHostInstallRecord("production", sampleRecord("1.0.0"));
    const expectedPath = paths.hostInstallRecordPath("production");
    expect(expectedPath).toBe(
      join(sandboxRoot, "host", "install", "install.json"),
    );
    const onDisk = JSON.parse(readFileSync(expectedPath, "utf8"));
    expect(onDisk).toMatchObject({ version: "1.0.0", arch: "arm64" });
  });

  it("writes the dev record under the dev install dir, disjoint from prod", async () => {
    await writeHostInstallRecord("dev", sampleRecord("2.0.0-dev"));
    const expectedPath = paths.hostInstallRecordPath("dev");
    expect(expectedPath).toBe(
      join(sandboxRoot, "host", "dev", "install", "install.json"),
    );
    const onDisk = JSON.parse(readFileSync(expectedPath, "utf8"));
    expect(onDisk.version).toBe("2.0.0-dev");
    // Prod side must not have been touched.
    expect(() =>
      readFileSync(paths.hostInstallRecordPath("production"), "utf8"),
    ).toThrow();
  });

  it("round-trips a record through write+read", async () => {
    const record = sampleRecord("1.2.3");
    await writeHostInstallRecord("production", record);
    const read = await readHostInstallRecord("production");
    expect(read).toEqual(record);
  });

  it("returns null when no record exists for the environment", async () => {
    expect(await readHostInstallRecord("production")).toBeNull();
    expect(await readHostInstallRecord("dev")).toBeNull();
  });

  it("delete removes the record from disk", async () => {
    await writeHostInstallRecord("production", sampleRecord("3.0.0"));
    expect(await readHostInstallRecord("production")).not.toBeNull();
    expect(await deleteHostInstallRecord("production")).toBe(true);
    expect(await readHostInstallRecord("production")).toBeNull();
  });

  it("refuses to silently overwrite a corrupt record", async () => {
    mkdirSync(paths.hostInstallDir("production"), { recursive: true });
    writeFileSync(
      paths.hostInstallRecordPath("production"),
      "not-json-{",
      "utf8",
    );
    await expect(readHostInstallRecord("production")).rejects.toThrow(
      /not valid JSON/,
    );
  });
});
