import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A platform without O_NOFOLLOW (Windows) has `open()` follow a trailing
// symlink instead of rejecting it, so a dangling symlink at the executable
// path reports ENOENT from `open` itself rather than from a pre-open
// `lstat`. That ENOENT must still classify as `unreadable` (a link exists,
// even though it resolves to nothing), never as the `absent` reading a
// missing path earns.
//
// This lives in its own file, beside update-recovery-evidence.test.ts,
// rather than adding a `node:fs/promises` mock to that file: this module's
// own fixture writers, and `placedFileFingerprint` itself, all go through
// that module, so a broad or mis-scoped mock there risks silently breaking
// every other fixture. A pass-through partial mock, isolated to this file,
// keeps the blast radius to exactly the one call it overrides.
//
// Kept separate from the sandboxing convention above for the same reason:
// this file only needs the `store/paths` and `node:os` seams to sandbox the
// install directory, plus the `node:fs/promises` pass-through. The running
// and staged legs are left genuinely absent (no pid.json, no staged.json
// ever written), which the production code already reads as `absent`
// without touching any mock.
let sandboxRoot = "";

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
    return environment === "dev" ? join(base, "dev") : base;
  };
  const installDirFor = (environment: Environment): string =>
    join(hostHomeFor(environment), "install");
  return {
    ...actual,
    hostHomeDir: (environment: Environment | undefined) =>
      hostHomeFor(environment),
    hostInstallDir: (environment: Environment) => installDirFor(environment),
    hostInstallRecordPath: (environment: Environment) =>
      join(installDirFor(environment), "install.json"),
    hostStagedDir: (environment: Environment) =>
      join(hostHomeFor(environment), "staged"),
    hostStagedRecordPath: (environment: Environment) =>
      join(hostHomeFor(environment), "staged", "staged.json"),
    hostPidMetadataPath: (environment: Environment | undefined) =>
      join(hostHomeFor(environment), "pid.json"),
  };
});

// `open` then delegates to the real function by default, so every genuine
// filesystem read `placedFileFingerprint` performs elsewhere in this file
// keeps working; the test below swaps in exactly one synthetic rejection.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

// Imports must come AFTER the vi.mock calls so the mocked modules are in
// place when `update-recovery-evidence` resolves them.
import { open } from "node:fs/promises";
import * as paths from "../../store/paths";
import { writeHostInstallRecord } from "../../manifest/host-install";
import { readAttemptRecoveryEvidence } from "../update-recovery-evidence";

function installRecord(version: string, executablePath: string) {
  return {
    installId: "install-1",
    version,
    runtimeVersion: null,
    platform: "linux" as const,
    arch: "x64" as const,
    installedAt: "2026-01-01T00:00:00.000Z",
    source: { kind: "registry" as const, value: version },
    archiveSha256: "a".repeat(64),
    // Irrelevant here: the ENOENT is raised before any digest comparison.
    executableSha256: null,
    signatureVerifiedAt: "2026-01-01T00:00:00.000Z",
    signatureKeyId: "test-key",
    sizeBytes: 1234,
    executablePath,
  };
}

beforeEach(() => {
  sandboxRoot = mkdtempSync(
    join(tmpdir(), "update-recovery-evidence-enoent-symlink-open-test-"),
  );
  osHome.current = sandboxRoot;
});

afterEach(() => {
  rmSync(sandboxRoot, { recursive: true, force: true });
  vi.mocked(open).mockClear();
});

describe("placedFileFingerprint - an open() ENOENT for a followed symlink (Windows semantics)", () => {
  it("classifies a dangling symlink as unreadable, not absent, when open() itself reports ENOENT", async () => {
    // `symlinkSync` needs elevated privileges for a real Windows run; the
    // case this test pins is about the ENOENT-handling branch, which is
    // exercised through the mock below regardless of host platform.
    if (process.platform === "win32") return;
    const installDir = paths.hostInstallDir("production");
    mkdirSync(installDir, { recursive: true });
    const executablePath = join(installDir, "traycer-host");
    symlinkSync(join(installDir, "does-not-exist"), executablePath);
    await writeHostInstallRecord(
      "production",
      installRecord("1.2.3", executablePath),
    );

    // Simulates a platform without O_NOFOLLOW: `open()` follows the link and
    // reports ENOENT for the executable path itself, exactly once.
    vi.mocked(open).mockImplementationOnce(async (calledPath) => {
      expect(calledPath).toBe(executablePath);
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    const evidence = await readAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
    );
    expect(evidence.installed).toEqual({ kind: "unreadable" });
  });
});
