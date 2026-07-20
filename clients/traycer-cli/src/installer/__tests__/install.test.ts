import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Atomic install-dir swap: versioned directories under `hostVersionsDir` +
// an atomic pointer-flip of the `hostInstallDir` symlink/junction. This
// suite is the highest-scrutiny part of T16 - it pins the exact guarantee
// the reviewer will check: "does a crash between the two writes ever leave
// neither old nor new resolvable." It exercises the REAL filesystem
// (sandboxed HOME, like `host-restart-finalize.test.ts`) end-to-end through
// the public `installHost`/`rollbackToVersionedDir`/`readActiveVersionedDir`
// surface, using `local-file` directory sources so no network/registry
// mocking is needed. `lifecycle: null` skips OS service integration
// entirely - this suite only cares about the install-dir swap mechanics.

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
let workHome: string;
let sourceRoot: string;

beforeEach(() => {
  workHome = mkdtempSync(join(tmpdir(), "traycer-install-test-"));
  sourceRoot = mkdtempSync(join(tmpdir(), "traycer-install-src-"));
  process.env.HOME = workHome;
  process.env.USERPROFILE = workHome;
  // `store/paths` captures `homedir()` once at module load - drop the
  // module cache so each test sees its own tmp HOME.
  vi.resetModules();
});

afterEach(() => {
  if (ORIGINAL_HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = ORIGINAL_HOME;
  }
  if (ORIGINAL_USERPROFILE === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = ORIGINAL_USERPROFILE;
  }
  rmSync(workHome, { recursive: true, force: true });
  rmSync(sourceRoot, { recursive: true, force: true });
});

const EXE_NAME =
  process.platform === "win32" ? "traycer-host.exe" : "traycer-host";

function makeHostFixture(version: string, marker: string): string {
  const dir = mkdtempSync(
    join(sourceRoot, `host-${version.replace(/[^A-Za-z0-9.-]/g, "_")}-`),
  );
  writeFileSync(join(dir, EXE_NAME), `#!/bin/sh\necho ${marker}\n`, {
    mode: 0o755,
  });
  writeFileSync(join(dir, "marker.txt"), marker);
  return dir;
}

async function runInstall(
  environment: "production" | "dev",
  version: string,
  marker: string,
) {
  const { installHost } = await import("../install");
  const sourceDir = makeHostFixture(version, marker);
  return installHost({
    environment,
    source: { kind: "local-file", path: sourceDir },
    onProgress: () => undefined,
    lifecycle: null,
    // Pin the recorded version exactly (bypasses the derived
    // basename+timestamp default) so versioned-dir names and assertions
    // are deterministic.
    recordVersionOverride: version,
  });
}

describe("atomic install-dir swap", () => {
  it("first-ever install: no prior hostInstallDir, creates the pointer, previousVersionedDir is null", async () => {
    const result = await runInstall("production", "1.0.0", "v1");
    expect(result.previousVersionedDir).toBeNull();
    expect(result.record.version).toBe("1.0.0");

    const { hostInstallDir } = await import("../../store/paths");
    const { readActiveVersionedDir } = await import("../install");
    const active = await readActiveVersionedDir("production");
    expect(active).not.toBeNull();
    expect(active).toContain("1.0.0");
    expect(lstatSync(hostInstallDir("production")).isSymbolicLink()).toBe(true);
  });

  it("second update: previousVersionedDir points at the first version, both generations stay on disk", async () => {
    const first = await runInstall("production", "1.0.0", "v1");
    const second = await runInstall("production", "2.0.0", "v2");

    expect(second.previousVersionedDir).not.toBeNull();
    expect(second.previousVersionedDir).toContain("1.0.0");

    const { hostVersionsDir } = await import("../../store/paths");
    const names = readdirSync(hostVersionsDir("production"));
    expect(names.some((n) => n.includes("1.0.0"))).toBe(true);
    expect(names.some((n) => n.includes("2.0.0"))).toBe(true);
    expect(names).toHaveLength(2);

    const { readActiveVersionedDir } = await import("../install");
    expect(await readActiveVersionedDir("production")).toContain("2.0.0");
    void first;
  });

  it("sweeps anything older than the immediately-previous generation on a third update", async () => {
    await runInstall("production", "1.0.0", "v1");
    await runInstall("production", "2.0.0", "v2");
    await runInstall("production", "3.0.0", "v3");

    const { hostVersionsDir } = await import("../../store/paths");
    const names = readdirSync(hostVersionsDir("production"));
    expect(names.some((n) => n.includes("1.0.0"))).toBe(false);
    expect(names.some((n) => n.includes("2.0.0"))).toBe(true);
    expect(names.some((n) => n.includes("3.0.0"))).toBe(true);
    expect(names).toHaveLength(2);
  });

  it("a crash between step (a) [move staging into versions/] and step (b) [flip the pointer] leaves hostInstallDir resolving to the OLD version, never neither", async () => {
    await runInstall("production", "1.0.0", "v1");
    const {
      readActiveVersionedDir,
      promoteStagingToVersionedDir,
      flipHostInstallPointer,
    } = await import("../install");

    const beforeCrash = await readActiveVersionedDir("production");
    expect(beforeCrash).toContain("1.0.0");

    // Simulate step (a) only - exactly what `atomicSwap` does before the
    // point a crash could land - without ever calling step (b).
    const stagingDir = makeHostFixture("2.0.0", "v2");
    const freshVersionedDir = await promoteStagingToVersionedDir(
      "production",
      stagingDir,
      "2.0.0",
    );

    // "Crash" here: hostInstallDir must still resolve to the OLD version -
    // never missing, never partial, never the new one.
    const midCrash = await readActiveVersionedDir("production");
    expect(midCrash).toBe(beforeCrash);
    expect(midCrash).toContain("1.0.0");
    expect(midCrash).not.toContain("2.0.0");
    // The new bytes are already fully and safely on disk, just unreferenced.
    expect(existsSync(join(freshVersionedDir, EXE_NAME))).toBe(true);

    // Complete step (b) - what a retry / crash-recovery continuation does.
    await flipHostInstallPointer("production", freshVersionedDir);
    const afterFlip = await readActiveVersionedDir("production");
    expect(afterFlip).toBe(freshVersionedDir);
    expect(afterFlip).toContain("2.0.0");
  });

  it("migrates a legacy plain-directory install dir into a versioned dir on first touch, preserving bytes exactly", async () => {
    const { hostInstallDir } = await import("../../store/paths");
    const { writeHostInstallRecord } =
      await import("../../manifest/host-install");

    // Simulate the pre-this-feature layout: hostInstallDir is a plain
    // directory with the host bytes directly inside, plus an install
    // record - no symlink anywhere yet.
    mkdirSync(hostInstallDir("production"), { recursive: true });
    writeFileSync(
      join(hostInstallDir("production"), EXE_NAME),
      "#!/bin/sh\necho legacy\n",
      { mode: 0o755 },
    );
    writeFileSync(
      join(hostInstallDir("production"), "legacy-marker.txt"),
      "legacy-bytes",
    );
    await writeHostInstallRecord("production", {
      version: "0.9.0",
      runtimeVersion: null,
      platform: "darwin",
      arch: "arm64",
      installedAt: "2025-01-01T00:00:00.000Z",
      source: { kind: "registry", value: "0.9.0" },
      archiveSha256: "a".repeat(64),
      signatureVerifiedAt: "2025-01-01T00:00:00.000Z",
      signatureKeyId: "test",
      sizeBytes: 1,
      executablePath: join(hostInstallDir("production"), EXE_NAME),
    });
    expect(lstatSync(hostInstallDir("production")).isSymbolicLink()).toBe(
      false,
    );

    const result = await runInstall("production", "1.0.0", "v1");

    // The migration surfaces as this swap's `previousVersionedDir`.
    expect(result.previousVersionedDir).not.toBeNull();
    expect(result.previousVersionedDir).toContain("0.9.0");
    expect(result.previousVersionedDir).toContain("legacy");

    const migratedMarker = readFileSync(
      join(result.previousVersionedDir as string, "legacy-marker.txt"),
      "utf8",
    );
    expect(migratedMarker).toBe("legacy-bytes");

    expect(lstatSync(hostInstallDir("production")).isSymbolicLink()).toBe(true);
    const { readActiveVersionedDir } = await import("../install");
    expect(await readActiveVersionedDir("production")).toContain("1.0.0");
  });

  it("rollbackToVersionedDir flips the pointer back onto bytes that are still fully on disk", async () => {
    await runInstall("production", "1.0.0", "v1");
    const second = await runInstall("production", "2.0.0", "v2");
    expect(second.previousVersionedDir).not.toBeNull();

    const { rollbackToVersionedDir, readActiveVersionedDir } =
      await import("../install");
    await rollbackToVersionedDir(
      "production",
      second.previousVersionedDir as string,
    );
    const active = await readActiveVersionedDir("production");
    expect(active).toBe(second.previousVersionedDir);
    expect(active).toContain("1.0.0");

    // The bytes at the rolled-back-to path are intact.
    expect(existsSync(join(active as string, EXE_NAME))).toBe(true);
  });

  it("keeps prod and dev versioned installs fully isolated", async () => {
    const prod = await runInstall("production", "1.0.0", "prod-v1");
    const dev = await runInstall("dev", "9.9.9", "dev-v1");
    expect(prod.previousVersionedDir).toBeNull();
    expect(dev.previousVersionedDir).toBeNull();

    const { readActiveVersionedDir } = await import("../install");
    const activeProd = await readActiveVersionedDir("production");
    const activeDev = await readActiveVersionedDir("dev");
    expect(activeProd).toContain("1.0.0");
    expect(activeDev).toContain("9.9.9");
    expect(activeProd).not.toBe(activeDev);
  });
});

describe("hostInstallSymlinkType", () => {
  it("uses a junction on win32 (no admin/Developer Mode required) and a plain dir symlink elsewhere", async () => {
    const { hostInstallSymlinkType } = await import("../install");
    expect(hostInstallSymlinkType("win32")).toBe("junction");
    expect(hostInstallSymlinkType("darwin")).toBe("dir");
    expect(hostInstallSymlinkType("linux")).toBe("dir");
  });
});
