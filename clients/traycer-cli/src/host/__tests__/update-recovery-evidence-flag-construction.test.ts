import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `fs.constants.O_NOFOLLOW` / `O_NONBLOCK` / `O_NOCTTY` may be `undefined`
// on some platforms; `placedFileFingerprint` maps each to `0` in that case
// via `typeof constants.O_X === "number" ? constants.O_X : 0`. This pins
// the construction itself, on whichever platform runs it: with all three
// deleted from `fs.constants`, the flags handed to `open()` must equal
// exactly `constants.O_RDONLY` - a real number, never `NaN` from an
// `undefined` operand slipping into the `|` expression.
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

// Strip the three platform-conditional flags from `fs.constants` so
// `update-recovery-evidence.ts`'s own `typeof constants.O_X === "number"`
// reads see them as absent, exactly like a platform that never defines
// them. Every other constant - including `O_RDONLY`, read back below for
// the comparison - passes through untouched.
//
// Wrapped in `vi.hoisted` because `vi.mock` factories are hoisted above
// this file's own top-level bindings - a plain top-level `const` here would
// throw a TDZ `ReferenceError` the moment the factory below ran.
const removedFlagNames = vi.hoisted(
  () => new Set(["O_NOFOLLOW", "O_NONBLOCK", "O_NOCTTY"]),
);
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const constants = Object.fromEntries(
    Object.entries(actual.constants).filter(
      ([name]) => !removedFlagNames.has(name),
    ),
  );
  return { ...actual, constants };
});

// `open` delegates to the real function, so the genuine read this test
// performs still happens for real; the mock only lets the call be recorded.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

// Imports must come AFTER the vi.mock calls so the mocked modules are in
// place when `update-recovery-evidence` resolves them.
import { constants } from "node:fs";
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
    // Irrelevant here: only the flags passed to `open()` are under test.
    executableSha256: null,
    signatureVerifiedAt: "2026-01-01T00:00:00.000Z",
    signatureKeyId: "test-key",
    sizeBytes: 1234,
    executablePath,
  };
}

beforeEach(() => {
  sandboxRoot = mkdtempSync(
    join(tmpdir(), "update-recovery-evidence-flag-construction-test-"),
  );
  osHome.current = sandboxRoot;
});

afterEach(() => {
  rmSync(sandboxRoot, { recursive: true, force: true });
  vi.mocked(open).mockClear();
});

describe("placedFileFingerprint - open() flag construction when the platform constants are missing", () => {
  it("passes exactly O_RDONLY to open() when O_NOFOLLOW/O_NONBLOCK/O_NOCTTY are all absent from fs.constants", async () => {
    expect(constants.O_NOFOLLOW).toBeUndefined();
    expect(constants.O_NONBLOCK).toBeUndefined();
    expect(constants.O_NOCTTY).toBeUndefined();
    expect(typeof constants.O_RDONLY).toBe("number");
    expect(Number.isNaN(constants.O_RDONLY)).toBe(false);

    const installDir = paths.hostInstallDir("production");
    mkdirSync(installDir, { recursive: true });
    const executablePath = join(installDir, "traycer-host");
    writeFileSync(executablePath, "binary-bytes");
    await writeHostInstallRecord(
      "production",
      installRecord("1.2.3", executablePath),
    );

    await readAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
    );

    expect(open).toHaveBeenCalledTimes(1);
    // Exact equality to the real O_RDONLY - not just "a number" - so a
    // regression that ORs in `undefined` (producing `NaN`) or otherwise
    // drifts the construction is caught.
    expect(open).toHaveBeenCalledWith(executablePath, constants.O_RDONLY);
  });
});
