import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  hostInstallRecordSchema,
  readHostStagedRecordAt,
  readStoredCliInstallManifestAtPath,
} from "../installation";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true })));
});

async function fixtureDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "traycer-installation-test-"));
  dirs.push(dir);
  return dir;
}

function stagedRecord(overrides: Record<string, unknown>) {
  return {
    schemaVersion: 1,
    stageId: "stage-1",
    version: "1.5.0",
    runtimeVersion: "runtime-1.5.0",
    archiveSha256: null,
    sizeBytes: 12,
    source: { kind: "registry", value: "1.5.0" },
    signatureKeyId: "test-key",
    signatureVerifiedAt: "2026-01-01T00:00:00.000Z",
    executablePath: "traycer-host",
    platform: "darwin",
    arch: "arm64",
    ...overrides,
  };
}

describe("shared installation readers", () => {
  it("preserves historical tolerant install-record normalization", () => {
    const parsed = hostInstallRecordSchema.parse({
      installId: 99,
      version: "1.5.0",
      runtimeVersion: { malformed: true },
      platform: "darwin",
      arch: "arm64",
      installedAt: "2026-01-01T00:00:00.000Z",
      source: { kind: "registry", value: "1.5.0" },
      archiveSha256: null,
      signatureVerifiedAt: "2026-01-01T00:00:00.000Z",
      signatureKeyId: "test-key",
      sizeBytes: 12,
      executablePath: "/tmp/traycer-host",
    });
    expect(parsed.installId).toBeNull();
    expect(parsed.runtimeVersion).toBeNull();
  });

  it("uses the CLI-compatible staged semantics at the explicit-path boundary", async () => {
    const dir = await fixtureDir();
    const { stageId: _stageId, ...legacy } = stagedRecord({});
    await writeFile(join(dir, "staged.json"), JSON.stringify(legacy));
    await expect(readHostStagedRecordAt(dir)).resolves.toMatchObject({
      stageId: null,
      version: "1.5.0",
    });

    await writeFile(
      join(dir, "staged.json"),
      JSON.stringify(stagedRecord({ stageId: null })),
    );
    await expect(readHostStagedRecordAt(dir)).resolves.toBeNull();

    await writeFile(
      join(dir, "staged.json"),
      JSON.stringify(stagedRecord({ version: "not-semver" })),
    );
    await expect(readHostStagedRecordAt(dir)).resolves.toBeNull();
  });

  it("makes the stored-manifest parser authoritative at an explicit path", async () => {
    const dir = await fixtureDir();
    const path = join(dir, "manifest.json");
    await writeFile(
      path,
      JSON.stringify({
        version: "1.5.0",
        installedAt: "2026-01-01T00:00:00.000Z",
        binaryPath: "/tmp/traycer",
        source: "manual",
        pendingUpgrade: null,
      }),
    );
    await expect(readStoredCliInstallManifestAtPath(path)).resolves.toEqual({
      version: "1.5.0",
      installedAt: "2026-01-01T00:00:00.000Z",
      binaryPath: "/tmp/traycer",
      source: "manual",
      pendingUpgrade: null,
    });
  });
});
