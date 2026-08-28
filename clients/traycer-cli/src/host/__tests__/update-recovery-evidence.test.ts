import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostRpcRegistry } from "@traycer/protocol/host/registry";
import type { ResponseOfMethod } from "../../../../shared/host-transport/host-messenger";

// Same sandboxing convention as manifest/__tests__/host-install.test.ts and
// manifest/__tests__/host-staged.test.ts: pin every environment-aware path
// helper at a tmpdir sandbox so the reader can never touch the real user
// home, and redirect `node:os`'s `homedir()` too (`store/paths` computes its
// root from it once at module load; overriding only the module export would
// leave that frozen constant pointed at the real home).
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
  const stagedDirFor = (environment: Environment): string =>
    join(hostHomeFor(environment), "staged");
  return {
    ...actual,
    hostHomeDir: (environment: Environment | undefined) =>
      hostHomeFor(environment),
    hostInstallDir: (environment: Environment) => installDirFor(environment),
    hostInstallRecordPath: (environment: Environment) =>
      join(installDirFor(environment), "install.json"),
    hostStagedDir: (environment: Environment) => stagedDirFor(environment),
    hostStagedRecordPath: (environment: Environment) =>
      join(stagedDirFor(environment), "staged.json"),
    hostPidMetadataPath: (environment: Environment | undefined) =>
      join(hostHomeFor(environment), "pid.json"),
  };
});

// Mirrors `host/__tests__/incumbent-check.test.ts`'s existing convention:
// the process-liveness probe itself is mocked at its module boundary rather
// than driven with real OS processes, since "dead"/"mismatch"/"indeterminate"
// are not reliably reproducible from a real pid in CI. `vi.mock` factories
// are hoisted above this file's own top-level bindings, so the mock
// functions themselves have to live in `vi.hoisted` to avoid a TDZ
// `ReferenceError` (same reason `osHome` above does).
const mocks = vi.hoisted(() => ({
  identityVerdictMock: vi.fn(),
  readHostPidMetadataMock: vi.fn(),
  callHostRpcMock: vi.fn(),
}));
const identityVerdictMock = mocks.identityVerdictMock;
const callHostRpcMock = mocks.callHostRpcMock;

vi.mock("../../store/process-identity", () => ({
  getPublishedProcessIdentityVerdict: mocks.identityVerdictMock,
}));

// `readHostPidMetadata` defaults to the REAL reader (against the sandboxed
// `pid.json` path) so every ordinary test exercises the genuine file read.
// Only the flap test below overrides it with `mockResolvedValueOnce` twice,
// to observe two distinct pid.json snapshots from the two reads
// `observeAttemptRecoveryEvidence` performs inside one call - there is no
// awaited gap in production a test could otherwise rewrite the real file
// into between them.
vi.mock("../pid-metadata", async () => {
  const actual =
    await vi.importActual<typeof import("../pid-metadata")>("../pid-metadata");
  mocks.readHostPidMetadataMock.mockImplementation(actual.readHostPidMetadata);
  return { ...actual, readHostPidMetadata: mocks.readHostPidMetadataMock };
});

// The running leg's healthy-host proof is a real WebSocket RPC call in
// production (`callHostRpcAtEndpoint("host.status", ...)`). Its own
// transport/auth machinery is out of scope here - this test-only module
// boundary mock is the same convention as the process-identity mock above,
// not a new production hook.
vi.mock("../../internal/host-rpc", () => ({
  callHostRpcAtEndpoint: mocks.callHostRpcMock,
}));

// Imports must come AFTER the vi.mock calls so the mocked modules are in
// place when `update-recovery-evidence` resolves them.
import * as paths from "../../store/paths";
import { writeHostInstallRecord } from "../../manifest/host-install";
import { writeHostStagedRecordAt } from "../../manifest/host-staged";
import {
  observeAttemptRecoveryEvidence,
  readAttemptRecoveryEvidence,
  sameAttemptRecoveryEvidenceObservation,
} from "../update-recovery-evidence";

function sha256Of(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

// The digest that a genuine materialization would have recorded for the
// bytes this file actually places on disk - "binary-bytes" everywhere below
// unless a test deliberately wants a stable-but-WRONG digest.
const GENUINE_EXECUTABLE_SHA256 = sha256Of("binary-bytes");

function installRecord(
  version: string,
  executablePath: string,
  installId: string | null,
  executableSha256: string | null,
) {
  return {
    installId,
    version,
    runtimeVersion: null,
    platform: "linux" as const,
    arch: "x64" as const,
    installedAt: "2026-01-01T00:00:00.000Z",
    source: { kind: "registry" as const, value: version },
    archiveSha256: "a".repeat(64),
    executableSha256,
    signatureVerifiedAt: "2026-01-01T00:00:00.000Z",
    signatureKeyId: "test-key",
    sizeBytes: 1234,
    executablePath,
  };
}

function stagedRecord(
  version: string,
  executablePath: string,
  stageId: string,
  executableSha256: string | null,
) {
  return {
    schemaVersion: 1 as const,
    stageId,
    version,
    runtimeVersion: "runtime-" + version,
    archiveSha256: "b".repeat(64),
    executableSha256,
    sizeBytes: 5678,
    source: { kind: "registry" as const, value: version },
    signatureKeyId: "test-key",
    signatureVerifiedAt: "2026-01-01T00:00:00.000Z",
    executablePath,
    platform: "linux" as const,
    arch: "x64" as const,
  };
}

function writePidMetadata(overrides: {
  readonly version: string;
  readonly processStartIdentity: string | null;
  readonly pid?: number;
}): void {
  mkdirSync(paths.hostHomeDir("production"), { recursive: true });
  writeFileSync(
    paths.hostPidMetadataPath("production"),
    JSON.stringify({
      pid: overrides.pid ?? 4242,
      hostId: "host-1",
      version: overrides.version,
      websocketUrl: "ws://127.0.0.1:58036/rpc",
      startedAt: "2026-01-01T00:00:00.000Z",
      processStartIdentity: overrides.processStartIdentity,
    }),
    "utf8",
  );
}

type HostStatusResponse = ResponseOfMethod<HostRpcRegistry, "host.status">;

function hostStatusResponse(
  overrides: Partial<HostStatusResponse>,
): HostStatusResponse {
  return {
    ready: true,
    hostVersion: "1.2.3",
    protocolVersion: { major: 1, minor: 2 },
    busy: false,
    busySessionCount: null,
    updateProgress: null,
    busyBreakdown: null,
    // `null` = this fixture's host did not report the durable attempt,
    // which is exactly what host.status@1.2-and-older peers send.
    updateOperation: null,
    updateTransaction: null,
    ...overrides,
  };
}

async function writeInstalledExecutable(
  version: string,
  present: boolean,
  installId: string | null,
  executableSha256: string | null,
): Promise<string> {
  const installDir = paths.hostInstallDir("production");
  mkdirSync(installDir, { recursive: true });
  const executablePath = join(installDir, "traycer-host");
  if (present) writeFileSync(executablePath, "binary-bytes");
  await writeHostInstallRecord(
    "production",
    installRecord(version, executablePath, installId, executableSha256),
  );
  return executablePath;
}

async function writeStagedExecutable(
  version: string,
  present: boolean,
  stageId: string,
  executableSha256: string | null,
): Promise<string> {
  const stagedDir = paths.hostStagedDir("production");
  mkdirSync(stagedDir, { recursive: true });
  const relativeExecutablePath = "traycer-host";
  if (present) {
    writeFileSync(join(stagedDir, relativeExecutablePath), "binary-bytes");
  }
  await writeHostStagedRecordAt(
    stagedDir,
    stagedRecord(version, relativeExecutablePath, stageId, executableSha256),
  );
  return join(stagedDir, relativeExecutablePath);
}

beforeEach(() => {
  sandboxRoot = mkdtempSync(join(tmpdir(), "update-recovery-evidence-test-"));
  osHome.current = sandboxRoot;
  identityVerdictMock.mockReset();
  callHostRpcMock.mockReset();
  // `mockClear()`, not `mockReset()`: clear call history only, so the
  // real-reader default implementation set in the `vi.mock` factory above
  // survives into every test. Individual tests that need the flap scenario
  // layer `mockResolvedValueOnce` on top of it.
  mocks.readHostPidMetadataMock.mockClear();
});

afterEach(() => {
  rmSync(sandboxRoot, { recursive: true, force: true });
});

describe("observeAttemptRecoveryEvidence - foreign-home guard", () => {
  it("returns fully unreadable evidence when the passed hostHomeDir does not match the environment's canonical home", async () => {
    const evidence = await readAttemptRecoveryEvidence(
      "production",
      join(sandboxRoot, "not-the-real-host-home"),
    );
    expect(evidence).toEqual({
      installed: { kind: "unreadable" },
      staged: { kind: "unreadable" },
      running: { kind: "unreadable" },
    });
  });
});

describe("observeAttemptRecoveryEvidence - installed/staged artifacts: absent, verified, missing, corrupt-present", () => {
  it("reports absent for every leg when nothing has ever been written", async () => {
    identityVerdictMock.mockResolvedValue("dead");
    const evidence = await readAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
    );
    expect(evidence.installed).toEqual({ kind: "absent" });
    expect(evidence.staged).toEqual({ kind: "absent" });
    expect(evidence.running).toEqual({ kind: "absent" });
  });

  it("verifies an installed executable that exists on disk at the recorded path", async () => {
    await writeInstalledExecutable(
      "1.2.3",
      true,
      "install-1",
      GENUINE_EXECUTABLE_SHA256,
    );
    identityVerdictMock.mockResolvedValue("dead");
    const evidence = await readAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
    );
    expect(evidence.installed).toEqual({ kind: "verified", version: "1.2.3" });
  });

  it("never verifies an installed executable whose placed bytes are STABLE but do not match the recorded digest - proves double observation cannot upgrade untrusted bytes into attested bytes", async () => {
    // The bytes are wrong BEFORE the first observation and never change
    // across it - exactly the "stable but wrong" gap the cold review found:
    // a fingerprint that only proves the same (wrong) bytes were seen twice.
    await writeInstalledExecutable(
      "1.2.3",
      true,
      "install-1",
      "f".repeat(64), // does not match sha256("binary-bytes")
    );
    identityVerdictMock.mockResolvedValue("dead");
    const evidence = await readAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
    );
    expect(evidence.installed).toEqual({ kind: "unreadable" });
  });

  it("never verifies a staged executable whose placed bytes are STABLE but do not match the recorded digest", async () => {
    await writeStagedExecutable(
      "2.0.0",
      true,
      "test-stage-id",
      "f".repeat(64), // does not match sha256("binary-bytes")
    );
    identityVerdictMock.mockResolvedValue("dead");
    const evidence = await readAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
    );
    expect(evidence.staged).toEqual({ kind: "unreadable" });
  });

  it("never verifies an installed executable when the record carries no executableSha256 at all (legacy/absent attestation is not a weaker verified)", async () => {
    await writeInstalledExecutable("1.2.3", true, "install-1", null);
    identityVerdictMock.mockResolvedValue("dead");
    const evidence = await readAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
    );
    expect(evidence.installed).toEqual({ kind: "unreadable" });
  });

  it("reports missing when the install record exists but its executable does not", async () => {
    await writeInstalledExecutable(
      "1.2.3",
      false,
      "install-1",
      GENUINE_EXECUTABLE_SHA256,
    );
    identityVerdictMock.mockResolvedValue("dead");
    const evidence = await readAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
    );
    expect(evidence.installed).toEqual({ kind: "missing", version: "1.2.3" });
  });

  it("verifies a staged executable that exists on disk at the recorded path", async () => {
    await writeStagedExecutable(
      "2.0.0",
      true,
      "test-stage-id",
      GENUINE_EXECUTABLE_SHA256,
    );
    identityVerdictMock.mockResolvedValue("dead");
    const evidence = await readAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
    );
    expect(evidence.staged).toEqual({ kind: "verified", version: "2.0.0" });
  });

  it("reports missing when the staged record exists but its executable does not", async () => {
    await writeStagedExecutable(
      "2.0.0",
      false,
      "test-stage-id",
      GENUINE_EXECUTABLE_SHA256,
    );
    identityVerdictMock.mockResolvedValue("dead");
    const evidence = await readAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
    );
    expect(evidence.staged).toEqual({ kind: "missing", version: "2.0.0" });
  });

  it("fails closed as unreadable (not absent) for a corrupt-but-present install.json", async () => {
    const installDir = paths.hostInstallDir("production");
    mkdirSync(installDir, { recursive: true });
    writeFileSync(paths.hostInstallRecordPath("production"), "not-json-{");
    identityVerdictMock.mockResolvedValue("dead");

    const evidence = await readAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
    );
    // `readHostInstallRecord` throws on invalid JSON; recovery must not
    // interpret that as "no install ever happened".
    expect(evidence.installed).toEqual({ kind: "unreadable" });
  });

  it("fails closed as unreadable (not absent) for a corrupt-but-present staged.json", async () => {
    const stagedDir = paths.hostStagedDir("production");
    mkdirSync(stagedDir, { recursive: true });
    writeFileSync(paths.hostStagedRecordPath("production"), "not-json-{");
    identityVerdictMock.mockResolvedValue("dead");

    const evidence = await readAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
    );
    // `readHostStagedRecordAt` is deliberately tolerant and returns `null`
    // for malformed JSON (legacy reconciliation) - recovery must still
    // distinguish "present but unusable" from "genuinely absent" by
    // re-probing the path directly.
    expect(evidence.staged).toEqual({ kind: "unreadable" });
  });

  it("fails closed as unreadable when the install record's executablePath escapes the install dir", async () => {
    const installDir = paths.hostInstallDir("production");
    mkdirSync(installDir, { recursive: true });
    const outsidePath = join(sandboxRoot, "outside-install-dir", "host-bin");
    mkdirSync(join(sandboxRoot, "outside-install-dir"), { recursive: true });
    writeFileSync(outsidePath, "binary-bytes");
    await writeHostInstallRecord(
      "production",
      installRecord(
        "1.2.3",
        outsidePath,
        "install-1",
        GENUINE_EXECUTABLE_SHA256,
      ),
    );
    identityVerdictMock.mockResolvedValue("dead");

    const evidence = await readAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
    );
    expect(evidence.installed).toEqual({ kind: "unreadable" });
  });

  it("fails closed as unreadable when the installed executable is a FIFO (or any non-regular file), bounded and never opened for read", async () => {
    if (process.platform === "win32") return;
    const installDir = paths.hostInstallDir("production");
    mkdirSync(installDir, { recursive: true });
    const fifoPath = join(installDir, "traycer-host");
    execFileSync("mkfifo", [fifoPath]);
    await writeHostInstallRecord(
      "production",
      installRecord("1.2.3", fifoPath, "install-1", GENUINE_EXECUTABLE_SHA256),
    );
    identityVerdictMock.mockResolvedValue("dead");

    // Bounded: a FIFO with nothing on the other end would hang a naive open
    // for read. `placedFileFingerprint` must reject on the pre-open `lstat`
    // identity check (not `.isFile()`) before ever calling `open()`, so this
    // resolves promptly rather than hanging until the test timeout.
    const evidence = await Promise.race([
      readAttemptRecoveryEvidence(
        "production",
        paths.hostHomeDir("production"),
      ),
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error("readAttemptRecoveryEvidence hung on a FIFO")),
          2_000,
        ),
      ),
    ]);
    expect(evidence.installed).toEqual({ kind: "unreadable" });
  });

  it("fails closed as unreadable when the install record's installId is null - an incomplete/legacy attestation is not a weaker verified", async () => {
    await writeInstalledExecutable(
      "1.2.3",
      true,
      null,
      GENUINE_EXECUTABLE_SHA256,
    );
    identityVerdictMock.mockResolvedValue("dead");

    const evidence = await readAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
    );
    expect(evidence.installed).toEqual({ kind: "unreadable" });
  });

  it("fails closed as unreadable when the staged record's stageId is empty - an incomplete/legacy attestation is not a weaker verified", async () => {
    // `stageId` on the wire schema defaults to non-empty via `z.string().min(1)`;
    // the reader itself additionally requires it non-null before trusting the
    // placed bytes as a verified stage.
    const stagedDir = paths.hostStagedDir("production");
    mkdirSync(stagedDir, { recursive: true });
    const relativeExecutablePath = "traycer-host";
    writeFileSync(join(stagedDir, relativeExecutablePath), "binary-bytes");
    writeFileSync(
      paths.hostStagedRecordPath("production"),
      JSON.stringify({
        ...stagedRecord(
          "2.0.0",
          relativeExecutablePath,
          "test-stage-id",
          GENUINE_EXECUTABLE_SHA256,
        ),
        stageId: null,
      }),
    );
    identityVerdictMock.mockResolvedValue("dead");

    const evidence = await readAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
    );
    expect(evidence.staged).toEqual({ kind: "unreadable" });
  });
});

describe("observeAttemptRecoveryEvidence - running evidence: owner-bound vs dead vs indeterminate vs unhealthy RPC", () => {
  it("reports absent when no pid.json exists", async () => {
    const evidence = await readAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
    );
    expect(evidence.running).toEqual({ kind: "absent" });
    expect(identityVerdictMock).not.toHaveBeenCalled();
    expect(callHostRpcMock).not.toHaveBeenCalled();
  });

  it("verifies a host-home-bound owner when process identity is current AND host.status reports ready at the exact recorded version", async () => {
    writePidMetadata({
      version: "1.2.3",
      processStartIdentity: "linux:boot-a 4242",
    });
    identityVerdictMock.mockResolvedValue("current");
    callHostRpcMock.mockResolvedValue(
      hostStatusResponse({ ready: true, hostVersion: "1.2.3" }),
    );

    const evidence = await readAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
    );
    expect(evidence.running).toEqual({
      kind: "verified",
      version: "1.2.3",
      owner: "host-home-bound",
    });
    expect(identityVerdictMock).toHaveBeenCalledWith(4242, "linux:boot-a 4242");
    expect(callHostRpcMock).toHaveBeenCalledWith(
      "host.status",
      {},
      { hostId: "host-1", websocketUrl: "ws://127.0.0.1:58036/rpc" },
    );
  });

  it.each(["dead", "mismatch"] as const)(
    "reports absent (never verified) when the published process is %s - positive proof no live host owns this pid.json",
    async (verdict) => {
      writePidMetadata({
        version: "1.2.3",
        processStartIdentity: "linux:boot-a 4242",
      });
      identityVerdictMock.mockResolvedValue(verdict);

      const evidence = await readAttemptRecoveryEvidence(
        "production",
        paths.hostHomeDir("production"),
      );
      expect(evidence.running).toEqual({ kind: "absent" });
      expect(callHostRpcMock).not.toHaveBeenCalled();
    },
  );

  it("fails closed as unreadable when the process-liveness probe is indeterminate", async () => {
    writePidMetadata({
      version: "1.2.3",
      processStartIdentity: "linux:boot-a 4242",
    });
    identityVerdictMock.mockResolvedValue("indeterminate");

    const evidence = await readAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
    );
    // Indeterminate must never be read as "verified enough to terminalize
    // complete" - it is an explicit refusal, not a positive proof either way.
    expect(evidence.running).toEqual({ kind: "unreadable" });
    expect(callHostRpcMock).not.toHaveBeenCalled();
  });

  it("fails closed as unreadable for a corrupt-but-present pid.json", async () => {
    mkdirSync(paths.hostHomeDir("production"), { recursive: true });
    writeFileSync(paths.hostPidMetadataPath("production"), "not-json-{");

    const evidence = await readAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
    );
    expect(evidence.running).toEqual({ kind: "unreadable" });
    expect(identityVerdictMock).not.toHaveBeenCalled();
  });

  it("fails closed as unreadable when host.status reports not ready, even at the exact recorded version", async () => {
    writePidMetadata({
      version: "1.2.3",
      processStartIdentity: "linux:boot-a 4242",
    });
    identityVerdictMock.mockResolvedValue("current");
    callHostRpcMock.mockResolvedValue(
      hostStatusResponse({ ready: false, hostVersion: "1.2.3" }),
    );

    const evidence = await readAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
    );
    expect(evidence.running).toEqual({ kind: "unreadable" });
  });

  it("fails closed as unreadable when host.status's hostVersion disagrees with the recorded pid.json version", async () => {
    writePidMetadata({
      version: "1.2.3",
      processStartIdentity: "linux:boot-a 4242",
    });
    identityVerdictMock.mockResolvedValue("current");
    callHostRpcMock.mockResolvedValue(
      hostStatusResponse({ ready: true, hostVersion: "9.9.9" }),
    );

    const evidence = await readAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
    );
    expect(evidence.running).toEqual({ kind: "unreadable" });
  });

  it("fails closed as unreadable when the RPC call itself throws (host unreachable/refused)", async () => {
    writePidMetadata({
      version: "1.2.3",
      processStartIdentity: "linux:boot-a 4242",
    });
    identityVerdictMock.mockResolvedValue("current");
    callHostRpcMock.mockRejectedValue(new Error("connection refused"));

    const evidence = await readAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
    );
    expect(evidence.running).toEqual({ kind: "unreadable" });
  });

  it("fails closed as unreadable when pid.json changes between the pre- and post-RPC re-reads (a restart during the health check)", async () => {
    identityVerdictMock.mockResolvedValue("current");
    callHostRpcMock.mockResolvedValue(
      hostStatusResponse({ ready: true, hostVersion: "1.2.3" }),
    );
    const baseMetadata = {
      pid: 4242,
      hostId: "host-1",
      version: "1.2.3",
      websocketUrl: "ws://127.0.0.1:58036/rpc",
      startedAt: "2026-01-01T00:00:00.000Z",
      layer0: null,
      layer0Slot: null,
    };
    mocks.readHostPidMetadataMock
      .mockResolvedValueOnce({
        ...baseMetadata,
        processStartIdentity: "linux:boot-a 4242",
      })
      .mockResolvedValueOnce({
        // Recycled onto a different pid after the RPC returned - the
        // post-RPC re-bind check must catch this even though the RPC itself
        // reported healthy.
        ...baseMetadata,
        pid: 5252,
        processStartIdentity: "linux:boot-c 5252",
      });

    const evidence = await readAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
    );
    expect(evidence.running).toEqual({ kind: "unreadable" });
  });
});

describe("observeAttemptRecoveryEvidence - running snapshot flap fails closed (fingerprint-level, across the two full observations)", () => {
  it("does not flap when the two internal running observations agree", async () => {
    writePidMetadata({
      version: "1.2.3",
      processStartIdentity: "linux:boot-a 4242",
    });
    identityVerdictMock.mockResolvedValue("current");
    callHostRpcMock.mockResolvedValue(
      hostStatusResponse({ ready: true, hostVersion: "1.2.3" }),
    );

    const evidence = await readAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
    );
    expect(evidence.running).toEqual({
      kind: "verified",
      version: "1.2.3",
      owner: "host-home-bound",
    });
  });

  it("sameAttemptRecoveryEvidenceObservation detects an installed-digest change between two observations", async () => {
    await writeInstalledExecutable(
      "1.2.3",
      true,
      "install-1",
      GENUINE_EXECUTABLE_SHA256,
    );
    identityVerdictMock.mockResolvedValue("dead");
    const first = await observeAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
    );

    // Same recorded version, but the placed bytes changed underneath it -
    // a different sha256 for the "same" install.json.
    writeFileSync(
      join(paths.hostInstallDir("production"), "traycer-host"),
      "different-binary-bytes",
    );
    const second = await observeAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
    );

    expect(sameAttemptRecoveryEvidenceObservation(first, second)).toBe(false);
  });

  it("sameAttemptRecoveryEvidenceObservation detects a process-identity change between two observations", async () => {
    writePidMetadata({
      version: "1.2.3",
      processStartIdentity: "linux:boot-a 4242",
    });
    identityVerdictMock.mockResolvedValue("current");
    callHostRpcMock.mockResolvedValue(
      hostStatusResponse({ ready: true, hostVersion: "1.2.3" }),
    );
    const first = await observeAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
    );

    writePidMetadata({
      version: "1.2.3",
      processStartIdentity: "linux:boot-b 4242",
    });
    const second = await observeAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
    );

    expect(sameAttemptRecoveryEvidenceObservation(first, second)).toBe(false);
  });

  it("sameAttemptRecoveryEvidenceObservation detects a host.status health change between two observations", async () => {
    writePidMetadata({
      version: "1.2.3",
      processStartIdentity: "linux:boot-a 4242",
    });
    identityVerdictMock.mockResolvedValue("current");
    callHostRpcMock.mockResolvedValue(
      hostStatusResponse({ ready: true, hostVersion: "1.2.3" }),
    );
    const first = await observeAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
    );

    callHostRpcMock.mockResolvedValue(
      hostStatusResponse({ ready: false, hostVersion: "1.2.3" }),
    );
    const second = await observeAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
    );

    expect(first.evidence.running.kind).toBe("verified");
    expect(second.evidence.running).toEqual({ kind: "unreadable" });
    expect(sameAttemptRecoveryEvidenceObservation(first, second)).toBe(false);
  });

  it("fails closed as unreadable when the published process identity differs between the two internal reads within ONE observation at the SAME version - a restart mid-read, not a stable process", async () => {
    // `observeAttemptRecoveryEvidence` re-reads pid.json between its two
    // internal running-evidence snapshots. Overriding the top-level,
    // statically hoisted `readHostPidMetadata` mock for exactly these two
    // calls is the only way to observe two DIFFERENT snapshots from within
    // one synchronous call with no awaited gap a test could otherwise
    // rewrite the real file into - reusing the same module-mock seam
    // `incumbent-check.test.ts` already uses for `readHostPidMetadata`, not
    // a new production hook. Every OTHER test in this file relies on this
    // same mock's real-reader default implementation, set once in the
    // `vi.mock("../pid-metadata", ...)` factory above.
    const baseMetadata = {
      pid: 4242,
      hostId: "host-1",
      version: "1.2.3",
      websocketUrl: "ws://127.0.0.1:58036/rpc",
      startedAt: "2026-01-01T00:00:00.000Z",
      layer0: null,
      layer0Slot: null,
    };
    mocks.readHostPidMetadataMock
      .mockResolvedValueOnce({
        ...baseMetadata,
        processStartIdentity: "linux:boot-a 4242",
      })
      .mockResolvedValueOnce({
        // Same version, but the recorded process instance changed - a
        // restart happened between the two reads.
        ...baseMetadata,
        processStartIdentity: "linux:boot-b 4242",
      });
    identityVerdictMock.mockResolvedValue("current");
    callHostRpcMock.mockResolvedValue(
      hostStatusResponse({ ready: true, hostVersion: "1.2.3" }),
    );

    const evidence = await readAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
    );
    // The pre/post-RPC mismatch inside the FIRST internal running read
    // already resolves that read to unreadable; the second internal running
    // read (this call site's own before/after flap check) falls back to the
    // real reader, which finds no pid.json at all and reads absent. Either
    // way the two internal reads' fingerprints disagree, so the outer
    // evidence stays unreadable rather than silently trusting either half.
    expect(evidence.running).toEqual({ kind: "unreadable" });
  });
});

// KNOWN GAP: `sameRegularFileIdentity` also fails closed when either side's
// `dev`/`ino` reads as `0` (the Windows convention for "not a meaningful
// identity"). That branch has no test here: forcing a zero-identity `Stats`
// through `placedFileFingerprint` would require mocking `node:fs/promises`'s
// `lstat`/`open`/`FileHandle.stat` at the module boundary, and this file's
// fixture writers (`writeHostInstallRecord`, `writeHostStagedRecordAt`, and
// `readHostPidMetadata`'s real-reader default) all go through that same
// module - a targeted mock risks silently breaking every other fixture in
// this file rather than proving the one branch. Real coverage needs either a
// genuine Windows CI runner or a narrower seam than exists today.
