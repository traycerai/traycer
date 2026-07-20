import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  const stagedDirFor = (environment: Environment): string =>
    join(sandboxRoot, "host", environment, "staged");
  return {
    ...actual,
    hostStagedDir: (environment: Environment) => stagedDirFor(environment),
  };
});

import {
  HOST_STAGED_RECORD_SCHEMA_VERSION,
  readHostStagedRecord,
  readHostStagedRecordAt,
  writeHostStagedRecordAt,
  type HostStagedRecord,
} from "../host-staged";

function sampleRecord(version: string): HostStagedRecord {
  return {
    schemaVersion: HOST_STAGED_RECORD_SCHEMA_VERSION,
    stageId: "test-stage-id",
    version,
    runtimeVersion: "runtime-" + version,
    archiveSha256: "a".repeat(64),
    sizeBytes: 1234,
    source: { kind: "registry", value: version },
    signatureKeyId: "test-key",
    signatureVerifiedAt: "2026-01-01T00:00:00.000Z",
    executablePath: "traycer-host",
    platform: "darwin",
    arch: "arm64",
  };
}

describe("host-staged sidecar (readHostStagedRecordAt / writeHostStagedRecordAt)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "traycer-host-staged-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a written record", async () => {
    const record = sampleRecord("1.5.0");
    await writeHostStagedRecordAt(dir, record);
    const read = await readHostStagedRecordAt(dir);
    expect(read).toEqual(record);
  });

  it("returns null when staged.json is absent", async () => {
    expect(await readHostStagedRecordAt(dir)).toBeNull();
  });

  it("returns null for malformed JSON instead of throwing", async () => {
    writeFileSync(join(dir, "staged.json"), "{not json");
    expect(await readHostStagedRecordAt(dir)).toBeNull();
  });

  it("returns null for an unknown schemaVersion instead of throwing", async () => {
    writeFileSync(
      join(dir, "staged.json"),
      JSON.stringify({ ...sampleRecord("1.5.0"), schemaVersion: 99 }),
    );
    expect(await readHostStagedRecordAt(dir)).toBeNull();
  });

  it("reads a pre-fingerprint sidecar as an explicitly un-attestable legacy stage", async () => {
    const { stageId: _stageId, ...legacy } = sampleRecord("1.5.0");
    writeFileSync(join(dir, "staged.json"), JSON.stringify(legacy));

    expect(await readHostStagedRecordAt(dir)).toMatchObject({
      version: "1.5.0",
      stageId: null,
    });
  });

  it("returns null for a top-level non-object payload", async () => {
    writeFileSync(join(dir, "staged.json"), JSON.stringify([1, 2, 3]));
    expect(await readHostStagedRecordAt(dir)).toBeNull();
  });

  it("returns null when a required field is the wrong type", async () => {
    const bad = { ...sampleRecord("1.5.0"), sizeBytes: "not-a-number" };
    writeFileSync(join(dir, "staged.json"), JSON.stringify(bad));
    expect(await readHostStagedRecordAt(dir)).toBeNull();
  });

  it("returns null for a malformed source", async () => {
    const bad = { ...sampleRecord("1.5.0"), source: { kind: "bogus" } };
    writeFileSync(join(dir, "staged.json"), JSON.stringify(bad));
    expect(await readHostStagedRecordAt(dir)).toBeNull();
  });

  it("returns null for an invalid platform/arch", async () => {
    const badPlatform = { ...sampleRecord("1.5.0"), platform: "amiga" };
    writeFileSync(join(dir, "staged.json"), JSON.stringify(badPlatform));
    expect(await readHostStagedRecordAt(dir)).toBeNull();
  });

  it("accepts a null runtimeVersion and null archiveSha256", async () => {
    const record: HostStagedRecord = {
      ...sampleRecord("1.5.0"),
      runtimeVersion: null,
      archiveSha256: null,
    };
    await writeHostStagedRecordAt(dir, record);
    expect(await readHostStagedRecordAt(dir)).toEqual(record);
  });

  it("returns null when version is not valid SemVer", async () => {
    const bad = { ...sampleRecord("1.5.0"), version: "v1.5.0" };
    writeFileSync(join(dir, "staged.json"), JSON.stringify(bad));
    expect(await readHostStagedRecordAt(dir)).toBeNull();
  });

  it("returns null when executablePath is absolute", async () => {
    const bad = {
      ...sampleRecord("1.5.0"),
      executablePath: "/etc/passwd",
    };
    writeFileSync(join(dir, "staged.json"), JSON.stringify(bad));
    expect(await readHostStagedRecordAt(dir)).toBeNull();
  });

  it("returns null when executablePath escapes the staged directory", async () => {
    const bad = {
      ...sampleRecord("1.5.0"),
      executablePath: "../../outside/traycer-host",
    };
    writeFileSync(join(dir, "staged.json"), JSON.stringify(bad));
    expect(await readHostStagedRecordAt(dir)).toBeNull();
  });

  it("returns null when executablePath is empty", async () => {
    const bad = { ...sampleRecord("1.5.0"), executablePath: "" };
    writeFileSync(join(dir, "staged.json"), JSON.stringify(bad));
    expect(await readHostStagedRecordAt(dir)).toBeNull();
  });

  it("accepts a nested relative executablePath that stays within the staged directory", async () => {
    const record: HostStagedRecord = {
      ...sampleRecord("1.5.0"),
      executablePath: "bin/traycer-host",
    };
    await writeHostStagedRecordAt(dir, record);
    expect(await readHostStagedRecordAt(dir)).toEqual(record);
  });
});

describe("readHostStagedRecord (environment-scoped)", () => {
  beforeEach(() => {
    sandboxRoot = mkdtempSync(join(tmpdir(), "traycer-host-staged-env-test-"));
    osHome.current = sandboxRoot;
  });

  afterEach(() => {
    rmSync(sandboxRoot, { recursive: true, force: true });
  });

  it("reads from the canonical hostStagedDir for the environment", async () => {
    const record = sampleRecord("2.0.0");
    const stagedDir = join(sandboxRoot, "host", "production", "staged");
    mkdirSync(stagedDir, { recursive: true });
    await writeHostStagedRecordAt(stagedDir, record);
    expect(await readHostStagedRecord("production")).toEqual(record);
  });

  it("returns null when no stage exists for the environment", async () => {
    expect(await readHostStagedRecord("production")).toBeNull();
  });
});
