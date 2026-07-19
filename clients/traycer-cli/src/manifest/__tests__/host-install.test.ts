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

// `store/paths` computes `TRAYCER_HOME` from `os.homedir()` once at module
// load - any export this mock leaves un-overridden would otherwise resolve
// against the REAL production `~/.traycer`, not this sandbox. Redirect the
// `os` boundary itself so `vi.importActual`'s fresh module evaluation picks
// up the sandbox (falling back to the real tmpdir, never the real home,
// before the first `beforeEach` has set `sandboxRoot`).
// `vi.mock` factories are hoisted above this file's own top-level `let
// sandboxRoot` - a direct reference hits a TDZ `ReferenceError`, so the
// live value has to live in `vi.hoisted` instead.
const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => osHome.current || actual.tmpdir() };
});

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
    installId: null,
    version,
    runtimeVersion: null,
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
    osHome.current = sandboxRoot;
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

  it("round-trips a populated runtimeVersion", async () => {
    const record = {
      ...sampleRecord("1.2.3"),
      runtimeVersion: "staging.1783550586518.bb8c937d9",
    };
    await writeHostInstallRecord("production", record);
    expect((await readHostInstallRecord("production"))?.runtimeVersion).toBe(
      "staging.1783550586518.bb8c937d9",
    );
  });

  it("reads legacy records without runtimeVersion as null (tolerant read)", async () => {
    const legacy: Record<string, unknown> = { ...sampleRecord("1.2.3") };
    delete legacy.runtimeVersion;
    mkdirSync(paths.hostInstallDir("production"), { recursive: true });
    writeFileSync(
      paths.hostInstallRecordPath("production"),
      JSON.stringify(legacy),
      "utf8",
    );
    const read = await readHostInstallRecord("production");
    expect(read?.version).toBe("1.2.3");
    expect(read?.runtimeVersion).toBeNull();
  });

  it("round-trips a populated installId", async () => {
    const record = {
      ...sampleRecord("1.2.3"),
      installId: "3f5b6c1a-1111-4c9a-9999-abcdefabcdef",
    };
    await writeHostInstallRecord("production", record);
    expect((await readHostInstallRecord("production"))?.installId).toBe(
      "3f5b6c1a-1111-4c9a-9999-abcdefabcdef",
    );
  });

  it("reads legacy records without installId as null (tolerant read)", async () => {
    const legacy: Record<string, unknown> = { ...sampleRecord("1.2.3") };
    delete legacy.installId;
    mkdirSync(paths.hostInstallDir("production"), { recursive: true });
    writeFileSync(
      paths.hostInstallRecordPath("production"),
      JSON.stringify(legacy),
      "utf8",
    );
    const read = await readHostInstallRecord("production");
    expect(read?.version).toBe("1.2.3");
    expect(read?.installId).toBeNull();
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
