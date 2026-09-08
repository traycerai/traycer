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
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
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
      "identity-required",
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
      "identity-required",
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
      "identity-required",
    );

    writePidMetadata({
      version: "1.2.3",
      processStartIdentity: "linux:boot-b 4242",
    });
    const second = await observeAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
      "identity-required",
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
      "identity-required",
    );

    callHostRpcMock.mockResolvedValue(
      hostStatusResponse({ ready: false, hostVersion: "1.2.3" }),
    );
    const second = await observeAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
      "identity-required",
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

describe("observeAttemptRecoveryEvidence - the running leg is typed AGAINST the install record (D9)", () => {
  /**
   * A genuine, attested install fixture with a caller-chosen `runtimeVersion`
   * - the field every case in this block classifies against - through the
   * same real fs read `readInstalledObservation` performs.
   */
  async function writeInstalledExecutableWithRuntime(
    version: string,
    runtimeVersion: string | null,
    installId: string,
  ): Promise<void> {
    const installDir = paths.hostInstallDir("production");
    mkdirSync(installDir, { recursive: true });
    const executablePath = join(installDir, "traycer-host");
    writeFileSync(executablePath, "binary-bytes");
    await writeHostInstallRecord("production", {
      installId,
      version,
      runtimeVersion,
      platform: "linux",
      arch: "x64",
      installedAt: "2026-01-01T00:00:00.000Z",
      source: { kind: "registry", value: version },
      archiveSha256: "a".repeat(64),
      executableSha256: GENUINE_EXECUTABLE_SHA256,
      signatureVerifiedAt: "2026-01-01T00:00:00.000Z",
      signatureKeyId: "test-key",
      sizeBytes: 1234,
      executablePath,
    });
  }

  function healthyRunning(reportedVersion: string): void {
    writePidMetadata({
      version: reportedVersion,
      processStartIdentity: "linux:boot-a 4242",
    });
    identityVerdictMock.mockResolvedValue("current");
    callHostRpcMock.mockResolvedValue(
      hostStatusResponse({ ready: true, hostVersion: reportedVersion }),
    );
  }

  it("C1: a staging build - the process reports the record's OWN runtimeVersion stamp, and the running leg reads the CATALOG version", async () => {
    await writeInstalledExecutableWithRuntime(
      "1.2.3",
      "staging.1700000000.abc123",
      "install-1",
    );
    healthyRunning("staging.1700000000.abc123");

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

  it("C2: the C/R collision - the record's catalog version reported while the record names a DIFFERENT runtimeVersion - is `foreign`, never `verified`", async () => {
    await writeInstalledExecutableWithRuntime(
      "1.2.3",
      "staging.1700000000.abc123",
      "install-1",
    );
    healthyRunning("1.2.3");

    const evidence = await readAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
    );
    expect(evidence.running).toEqual({
      kind: "foreign",
      runtimeIdentity: "1.2.3",
    });
    // The "completes falsely" ablation, stated explicitly: dropping the C/R
    // check reads this collision as the target being genuinely verified.
    expect(evidence.running).not.toEqual({
      kind: "verified",
      version: "1.2.3",
      owner: "host-home-bound",
    });
  });

  it("C3: a different released build running - verified at THAT version, not the record's", async () => {
    await writeInstalledExecutableWithRuntime("1.2.3", null, "install-1");
    healthyRunning("2.0.0");

    const evidence = await readAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
    );
    expect(evidence.running).toEqual({
      kind: "verified",
      version: "2.0.0",
      owner: "host-home-bound",
    });
  });

  it("C4: a non-catalog identity with no record vouching for it is `foreign`", async () => {
    await writeInstalledExecutableWithRuntime("1.2.3", null, "install-1");
    healthyRunning("staging.1700000000.abc123");

    const evidence = await readAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
    );
    expect(evidence.running).toEqual({
      kind: "foreign",
      runtimeIdentity: "staging.1700000000.abc123",
    });
  });

  it("C5: the fingerprint changes when `runtimeVersion` changes, even when the classification's OUTCOME does not", async () => {
    // The process reports a DIFFERENT released build ("2.0.0") than the
    // record's catalog version ("1.2.3") on both reads, so the classification
    // takes the "plain catalog version other than the record's" branch
    // regardless of `runtimeVersion` - the only axis this test moves.
    await writeInstalledExecutableWithRuntime("1.2.3", null, "install-1");
    healthyRunning("2.0.0");
    const first = await observeAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
      "identity-required",
    );

    // Same executable bytes, same installedAt, same installId, same digests -
    // ONLY `runtimeVersion` differs.
    await writeInstalledExecutableWithRuntime(
      "1.2.3",
      "runtime-1.2.3-updated",
      "install-1",
    );
    const second = await observeAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
      "identity-required",
    );

    expect(first.evidence.running).toEqual({
      kind: "verified",
      version: "2.0.0",
      owner: "host-home-bound",
    });
    expect(second.evidence.running).toEqual(first.evidence.running);
    expect(sameAttemptRecoveryEvidenceObservation(first, second)).toBe(false);
  });

  it("C6: the observation exposes the identity a park refreshes from - present with records, null with neither", async () => {
    await writeInstalledExecutableWithRuntime("1.2.3", null, "install-1");
    await writeStagedExecutable(
      "2.0.0",
      true,
      "test-stage-id",
      GENUINE_EXECUTABLE_SHA256,
    );
    identityVerdictMock.mockResolvedValue("dead");

    const withRecords = await observeAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
      "identity-required",
    );
    expect(withRecords.installIdentity).toEqual({
      installId: "install-1",
      installedAt: "2026-01-01T00:00:00.000Z",
      archiveSha256: "a".repeat(64),
      version: "1.2.3",
    });
    expect(withRecords.stageFingerprint).toBe("test-stage-id");

    rmSync(paths.hostInstallDir("production"), {
      recursive: true,
      force: true,
    });
    rmSync(paths.hostStagedDir("production"), { recursive: true, force: true });
    const withoutRecords = await observeAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
      "identity-required",
    );
    expect(withoutRecords.installIdentity).toBeNull();
    expect(withoutRecords.stageFingerprint).toBeNull();
  });
});

describe("observeAttemptRecoveryEvidence - the running leg's DIAGNOSIS (Linux E13)", () => {
  // Several distinct causes are one evidence kind on purpose - no decision may
  // branch on the difference - so the diagnosis is the only place they are
  // told apart. It is what the verify leg renders when it gives up, which is
  // the whole reason a user is no longer told "not healthy" and nothing else.
  it.each([
    ["a dead pid", "dead", "absent", "host-process-dead"],
    ["a RECYCLED pid", "mismatch", "absent", "host-process-recycled"],
    [
      "an indeterminate verdict",
      "indeterminate",
      "unreadable",
      "pid-identity-indeterminate",
    ],
  ] as const)(
    "tells %s apart while the evidence kind stays the same",
    async (_label, verdict, kind, diagnosis) => {
      // Falsification (the ablation): collapse the `dead` and `mismatch` arms
      // of `readRunningObservation` back into one `absentRunning` and the
      // recycled row reddens while the dead row still passes - which is
      // exactly how the distinction was lost before.
      writePidMetadata({
        version: "1.2.3",
        processStartIdentity: "linux:boot-a 4242",
      });
      identityVerdictMock.mockResolvedValue(verdict);

      const observation = await observeAttemptRecoveryEvidence(
        "production",
        paths.hostHomeDir("production"),
        "identity-required",
      );

      expect(observation.evidence.running.kind).toBe(kind);
      expect(observation.runningDiagnosis).toBe(diagnosis);
    },
  );

  it.each([
    [
      "an UNAUTHORIZED frame is a refusal",
      "UNAUTHORIZED",
      "host-refuses-authenticated-rpc",
    ],
    [
      "a FORBIDDEN frame is a refusal",
      "FORBIDDEN",
      "host-refuses-authenticated-rpc",
    ],
    [
      "any OTHER RPC error keeps the budgeted reading",
      "WORKTREE_BUSY",
      "host-rpc-unreachable",
    ],
  ] as const)("Q19: %s", async (_label, code, diagnosis) => {
    // The gate is the RPC error CODE, never the host's wording. `WORKTREE_BUSY`
    // is here as the negative: a host that answered with something that is not
    // about admission has not decided anything the next poll cannot change, so
    // it must NOT shorten the budget.
    // Falsification: widen the code test in `authenticatedRefusalReason` and
    // the third row reddens; narrow it to UNAUTHORIZED alone and the second
    // does.
    writePidMetadata({
      version: "1.2.3",
      processStartIdentity: "linux:boot-a 4242",
    });
    identityVerdictMock.mockResolvedValue("current");
    callHostRpcMock.mockRejectedValue(
      new HostRpcError({
        code,
        message: "no applicable key found in the JSON Web Key Set",
        requestId: "r",
        method: "host.status",
        fatalDetails: null,
      }),
    );

    const observation = await observeAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
      // The STRONG policy, deliberately. These rows are about how a REFUSAL
      // classifies, and Q1's fallback is a separate axis: pinning them at
      // `identity-required` keeps them meaning what they meant before Q1
      // existed, and leaves the fallback's own rows to exercise the other arm.
      "identity-required",
    );

    expect(observation.runningDiagnosis).toBe(diagnosis);
    expect(observation.evidence.running).toEqual({ kind: "unreadable" });
  });

  it("Q19: the host's refusal text is CAPPED where it is minted", async () => {
    // Cold review B: this string is host-authored and unbounded, it is
    // interpolated into the verify failure's message, and that message is what
    // `writer.fail` stores - which `host.status.operation.error` mirrors over
    // the WIRE. So an unbounded value would sit beside a token whose whole
    // contract is that it is a closed set of fixed strings.
    //
    // The wire, not a card: as of Q23 the GUI's `verification-refused` card
    // renders fixed copy and no surface renders this text for this code. The
    // cap holds on the durable record alone, and the mint's docblock carries
    // the full reasoning including what was checked and found ABSENT (no size
    // bound in either decoder).
    //
    // Capped at the MINT rather than at any consumer, because the durable
    // record is the furthest-travelling consumer and capping one caller would
    // leave it uncapped.
    // Falsification: drop the `slice` and this reddens on the length.
    writePidMetadata({
      version: "1.2.3",
      processStartIdentity: "linux:boot-a 4242",
    });
    identityVerdictMock.mockResolvedValue("current");
    callHostRpcMock.mockRejectedValue(
      new HostRpcError({
        code: "UNAUTHORIZED",
        message: "x".repeat(10_000),
        requestId: "r",
        method: "host.status",
        fatalDetails: null,
      }),
    );

    const observation = await observeAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
      // The STRONG policy, deliberately. These rows are about how a REFUSAL
      // classifies, and Q1's fallback is a separate axis: pinning them at
      // `identity-required` keeps them meaning what they meant before Q1
      // existed, and leaves the fallback's own rows to exercise the other arm.
      "identity-required",
    );

    expect(observation.runningRefusal).not.toBeNull();
    // The code, a separator, the capped body and the truncation marker.
    expect(observation.runningRefusal?.length).toBeLessThan(250);
    expect(observation.runningRefusal?.startsWith("UNAUTHORIZED: ")).toBe(true);
    expect(observation.runningRefusal?.endsWith("...")).toBe(true);
  });

  it("names a MISSING start stamp rather than lumping it in with an unreadable record", async () => {
    // #1763's stamp: a record without it is refused rather than failed open,
    // and "there is no stamp" is a different thing to fix than "the file is
    // corrupt".
    writePidMetadata({ version: "1.2.3", processStartIdentity: null });
    identityVerdictMock.mockResolvedValue("current");

    const observation = await observeAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
      "identity-required",
    );

    expect(observation.evidence.running).toEqual({ kind: "unreadable" });
    expect(observation.runningDiagnosis).toBe("pid-start-stamp-missing");
  });

  it("names an absent pid record, and a home that is not this environment's", async () => {
    identityVerdictMock.mockResolvedValue("dead");
    const absent = await observeAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
      "identity-required",
    );
    expect(absent.runningDiagnosis).toBe("pid-metadata-absent");

    const wrongHome = await observeAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("dev"),
      "identity-required",
    );
    expect(wrongHome.runningDiagnosis).toBe("host-home-mismatch");
  });

  it("keeps the diagnosis OUT of the fingerprint, so it can never move an equality", async () => {
    // It explains a reading; it must never participate in one.
    writePidMetadata({
      version: "1.2.3",
      processStartIdentity: "linux:boot-a 4242",
    });
    identityVerdictMock.mockResolvedValue("dead");
    const first = await observeAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
      "identity-required",
    );
    identityVerdictMock.mockResolvedValue("mismatch");
    const second = await observeAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
      "identity-required",
    );

    expect(first.runningDiagnosis).toBe("host-process-dead");
    expect(second.runningDiagnosis).toBe("host-process-recycled");
    expect(sameAttemptRecoveryEvidenceObservation(first, second)).toBe(true);
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

describe("observeAttemptRecoveryEvidence - Q1: the version-only fallback for a pre-stamp host", () => {
  /** A healthy 1.2.0-era host: serving, correct version, and NO start stamp. */
  function seedHealthyPreStampHost(): void {
    writePidMetadata({ version: "1.2.3", processStartIdentity: null });
    callHostRpcMock.mockResolvedValue(
      hostStatusResponse({ ready: true, hostVersion: "1.2.3" }),
    );
  }

  it("THE Q1 BUG: identity-required refuses a healthy pre-stamp host", async () => {
    // The shipped behaviour, kept as the control this whole feature is
    // measured against. The host is up and serving the exact version, and the
    // verify leg polls this condition until its 45s budget is gone, then
    // records a correct install as `failed`.
    seedHealthyPreStampHost();

    const observation = await observeAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
      "identity-required",
    );

    expect(observation.evidence.running).toEqual({ kind: "unreadable" });
    expect(observation.runningDiagnosis).toBe("pid-start-stamp-missing");
    expect(observation.identityCompared).toBe(false);
    // Refused BEFORE the RPC - the host is never even asked.
    expect(callHostRpcMock).not.toHaveBeenCalled();
  });

  it("THE FIX: version-only verifies that same host, and says identity was not compared", async () => {
    seedHealthyPreStampHost();

    const observation = await observeAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
      "version-only",
    );

    expect(observation.evidence.running).toEqual({
      kind: "verified",
      version: "1.2.3",
      owner: "host-home-bound",
    });
    expect(observation.runningDiagnosis).toBe("classified");
    // The half that keeps the record honest: verified, and verified WEAKLY.
    expect(observation.identityCompared).toBe(false);
    // The identity verdict was never consulted - there was no stamp to consult
    // it with. This is what separates "skipped a check it could not make" from
    // "made the check and ignored the answer".
    expect(identityVerdictMock).not.toHaveBeenCalled();
  });

  it("FALLBACK, NOT BLANKET: version-only still compares identity when the host HAS a stamp", async () => {
    // The row that proves `version-only` names what this run may fall back to
    // rather than what it does regardless. Without it, a future edit could
    // turn the policy into an unconditional skip and every other pin here
    // would stay green.
    writePidMetadata({
      version: "1.2.3",
      processStartIdentity: "linux:boot-a 4242",
    });
    identityVerdictMock.mockResolvedValue("current");
    callHostRpcMock.mockResolvedValue(
      hostStatusResponse({ ready: true, hostVersion: "1.2.3" }),
    );

    const observation = await observeAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
      "version-only",
    );

    expect(observation.evidence.running).toEqual({
      kind: "verified",
      version: "1.2.3",
      owner: "host-home-bound",
    });
    expect(observation.identityCompared).toBe(true);
    expect(identityVerdictMock).toHaveBeenCalled();
  });

  it("FALLBACK, NOT BLANKET: a RECYCLED pid still fails under version-only when there IS a stamp", async () => {
    // The consequence of the row above, and the one that would actually hurt
    // if the policy became a blanket skip: a stamped host whose pid now
    // belongs to another process must still be caught, whatever the target's
    // age. `absent`, not `verified`.
    writePidMetadata({
      version: "1.2.3",
      processStartIdentity: "linux:boot-a 4242",
    });
    identityVerdictMock.mockResolvedValue("mismatch");
    callHostRpcMock.mockResolvedValue(
      hostStatusResponse({ ready: true, hostVersion: "1.2.3" }),
    );

    const observation = await observeAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
      "version-only",
    );

    expect(observation.evidence.running).toEqual({ kind: "absent" });
    expect(observation.runningDiagnosis).toBe("host-process-recycled");
    expect(observation.identityCompared).toBe(false);
  });

  it("the fallback keeps every OTHER check: a stamp-less host on the wrong version still fails", async () => {
    // What `version-only` does NOT mean. The endpoint binding, readiness and
    // the version agreement are all still enforced - only the identity
    // comparison is skipped, and only because it cannot be made.
    writePidMetadata({ version: "1.2.3", processStartIdentity: null });
    callHostRpcMock.mockResolvedValue(
      hostStatusResponse({ ready: true, hostVersion: "9.9.9" }),
    );

    const observation = await observeAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
      "version-only",
    );

    expect(observation.evidence.running).toEqual({ kind: "unreadable" });
    expect(observation.runningDiagnosis).toBe("host-version-disagrees-pid");
  });

  it("the fallback keeps every OTHER check: a stamp-less host that is not ready still fails", async () => {
    writePidMetadata({ version: "1.2.3", processStartIdentity: null });
    callHostRpcMock.mockResolvedValue(
      hostStatusResponse({ ready: false, hostVersion: "1.2.3" }),
    );

    const observation = await observeAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
      "version-only",
    );

    expect(observation.evidence.running).toEqual({ kind: "unreadable" });
    expect(observation.runningDiagnosis).toBe("host-not-ready");
  });

  // ---- X1: the fallback's PRECONDITION, which was shipped unpinned --------
  //
  // Reviewer C's finding, and the shape is worth naming because it is now the
  // third instance this round: a fix whose CONSEQUENCES are pinned while its
  // PRECONDITION is not. The two rows above prove what the fallback does once
  // it engages. Nothing proved what makes it engage - so two independent
  // mutations (gate the arm on the policy instead of on the stamp; let an
  // UNRECOGNIZED stamp earn the fallback) left all four suites green.
  //
  // The precondition is `processStartIdentityRead === "absent"`, and it is
  // strictly narrower than `stamp === null`: an unparseable stamp also decodes
  // to `null`. Collapsing the two is exactly the defect Q1 IS, one layer up -
  // a host whose stamp is corrupt would silently buy the weaker check on the
  // grounds that it had no stamp at all.
  //
  // `"not-a-stamp"` is PRESENT and does not parse: `isProcessStartIdentity`
  // requires a `linux|darwin|win32` platform tag before the separator, so this
  // decodes to `unrecognized` rather than to `absent`.
  function seedUnparseableStampHost(): void {
    writePidMetadata({
      version: "1.2.3",
      processStartIdentity: "not-a-stamp",
    });
    callHostRpcMock.mockResolvedValue(
      hostStatusResponse({ ready: true, hostVersion: "1.2.3" }),
    );
  }

  it("X1: an UNPARSEABLE stamp does not buy the fallback, even under version-only", async () => {
    seedUnparseableStampHost();

    const observation = await observeAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
      "version-only",
    );

    // Refused, not verified - and the diagnosis says WHICH of the two `null`
    // stamps this was. A record that cannot be parsed is not evidence that the
    // writer predates the field.
    expect(observation.evidence.running).toEqual({ kind: "unreadable" });
    expect(observation.runningDiagnosis).toBe("pid-start-stamp-unrecognized");
    expect(observation.identityCompared).toBe(false);
    expect(callHostRpcMock).not.toHaveBeenCalled();
  });

  it("X1 CONTROL: the same unparseable stamp under identity-required is unchanged", async () => {
    // What this row establishes: the policy makes NO difference to an
    // unparseable stamp, which is what makes the row above a statement about
    // the STAMP rather than about the policy.
    //
    // It does not redden either of the two mutations that motivated X1 - under
    // both, this row and the one above still refuse. The mutation it DOES hold
    // against was named by reviewer C and measured rather than guessed:
    // collapse the two diagnoses, so an unrecognized stamp reports
    // `pid-start-stamp-missing` under either policy. That reddens both rows
    // (49/51), which is what makes this a pin on the distinction the row above
    // depends on rather than decoration. A control no mutation can redden
    // should be cut; this one has a falsifier, so it stays.
    seedUnparseableStampHost();

    const observation = await observeAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
      "identity-required",
    );

    expect(observation.evidence.running).toEqual({ kind: "unreadable" });
    expect(observation.runningDiagnosis).toBe("pid-start-stamp-unrecognized");
    expect(observation.identityCompared).toBe(false);
  });

  it("the fallback keeps every OTHER check: a dead stamp-less host is caught by the RPC, not by liveness", async () => {
    // Worth its own row because it is the check the fallback appears to lose.
    // Without a stamp there is no identity verdict to report `dead`, but the
    // host still has to ANSWER at its recorded endpoint - so a dead process
    // fails here under a different token rather than passing.
    writePidMetadata({ version: "1.2.3", processStartIdentity: null });
    callHostRpcMock.mockRejectedValue(new Error("ECONNREFUSED"));

    const observation = await observeAttemptRecoveryEvidence(
      "production",
      paths.hostHomeDir("production"),
      "version-only",
    );

    expect(observation.evidence.running).toEqual({ kind: "unreadable" });
    expect(observation.runningDiagnosis).toBe("host-rpc-unreachable");
  });
});
