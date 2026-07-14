import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let sandboxRoot = "";

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
});

describe("readHostStagedRecord (environment-scoped)", () => {
  beforeEach(() => {
    sandboxRoot = mkdtempSync(join(tmpdir(), "traycer-host-staged-env-test-"));
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
