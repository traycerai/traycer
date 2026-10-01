import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatWindowsProcessStartIdentity } from "@traycer/protocol/host/lifecycle";
import { lockHolderLivenessGivenPublisher } from "@traycer-clients/shared/host-lock/cross-process-lock";
import {
  verifyProcessIdentityAsync,
  type ProcessIdentityToken,
  type ProcessIdentityVerdict,
} from "@traycer-clients/shared/host-lock/process-identity";
import { DOCTOR_ISSUE_CODES } from "../issues";
import { probeUpdateAttemptLock } from "../update-attempt-lock";

// The probe against real lock files at a temp path, exercising the REAL
// `lockHolderLivenessGivenPublisher` rule against an injected fake publisher
// verdict - so these pin the probe's own gating (publisher dead/alive-
// different, the rule's indeterminate answer, the re-read/token check)
// without ever reaching a real OS process. No `~/.traycer` is touched - the
// path is the probe's only input.

let workDir: string;
let lockPath: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "traycer-doctor-attempt-lock-"));
  lockPath = join(workDir, "update-attempt.lock");
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

interface AttemptLockFields {
  readonly pid: number;
  readonly token: string;
  readonly processStartedAtMs: number | null;
  readonly processStartIdentity: string | null;
  readonly supervisedProcessGroupId?: number;
  readonly retainOnPublisherDeath?: boolean;
}

function writeAttemptLock(path: string, fields: AttemptLockFields): void {
  writeFileSync(
    path,
    JSON.stringify({
      pid: fields.pid,
      reason: "host-maintenance-lease",
      startedAt: "2026-09-06T22:00:00.000Z",
      hostname: null,
      token: fields.token,
      processStartedAtMs: fields.processStartedAtMs,
      processStartIdentity: fields.processStartIdentity,
      ...(fields.supervisedProcessGroupId === undefined
        ? {}
        : { supervisedProcessGroupId: fields.supervisedProcessGroupId }),
      ...(fields.retainOnPublisherDeath === true
        ? { retainOnPublisherDeath: true }
        : {}),
    }),
  );
}

// `process.platform` has an own, configurable descriptor in every Node
// runtime this suite targets; captured once so the win32 simulation below
// restores the exact original rather than guessing a value. Re-typed into a
// fresh, non-optional `const` (rather than relying on narrowing the
// `PropertyDescriptor | undefined` read above to survive into the separate
// `withWin32Platform` closure below, which it does not) so every reader sees
// a genuinely non-optional `PropertyDescriptor`.
const platformDescriptorRead = Object.getOwnPropertyDescriptor(
  process,
  "platform",
);
if (platformDescriptorRead === undefined) {
  throw new Error("process.platform has no own property descriptor");
}
const ORIGINAL_PLATFORM_DESCRIPTOR: PropertyDescriptor = platformDescriptorRead;

async function withWin32Platform<T>(run: () => Promise<T>): Promise<T> {
  Object.defineProperty(process, "platform", {
    value: "win32",
    configurable: true,
  });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, "platform", ORIGINAL_PLATFORM_DESCRIPTOR);
  }
}

async function alwaysReturns(
  verdict: ProcessIdentityVerdict,
): Promise<(token: ProcessIdentityToken) => Promise<ProcessIdentityVerdict>> {
  return Promise.resolve(async () => verdict);
}

// ---- The real verifyProcessIdentityAsync, through a faked win32 spawn -----
//
// Every case above hands `probeUpdateAttemptLock` a hand-written
// `verifyPublisher` fake, so none of them ever reach a real spawn. The case
// below is different on purpose: it passes the REAL `verifyProcessIdentityAsync`
// as `verifyPublisher`, to prove the doctor row picks up the Windows
// denied-read fallback with no changes of its own - `probeUpdateAttemptLock`
// and `lockHolderLivenessGivenPublisher` are untouched by that fix; only what
// `verifyPublisher` returns changes. Only `execFile` needs faking - the
// async verifier's spawn path - since nothing here touches the sync one.

interface Win32VerifierScenario {
  readonly pid: number;
  readonly livenessAlive: boolean;
  readonly fallback: { readonly deniedDmtf: string };
}

let win32VerifierScenario: Win32VerifierScenario | null = null;

function scriptTextFromArgs(args: readonly string[]): string {
  const index = args.indexOf("-Command");
  const script = index >= 0 ? args[index + 1] : undefined;
  return script === undefined ? "" : script;
}

function isFallbackScript(script: string): boolean {
  return script.includes("get_StartTime()") || script.includes("Get-WmiObject");
}

function dispatchWin32VerifierCommand(
  command: string,
  args: readonly string[],
): string {
  if (win32VerifierScenario === null) {
    throw new Error("win32 verifier scenario not configured for this test");
  }
  if (command === "tasklist") {
    return win32VerifierScenario.livenessAlive
      ? `"tasklist.exe","${String(win32VerifierScenario.pid)}","Services","0","10,000 K"\r\n`
      : "";
  }
  if (command !== "powershell") {
    throw new Error(
      `unexpected command in win32 verifier scenario: ${command}`,
    );
  }
  const script = scriptTextFromArgs(args);
  if (isFallbackScript(script)) {
    return `denied ${win32VerifierScenario.fallback.deniedDmtf}\r\n`;
  }
  // The exact-read script: always denied in this scenario, which is the
  // whole point of a session-0 service holding the pid.
  throw new Error("You cannot call a method on a null-valued expression.");
}

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: (
      command: string,
      args: readonly string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ): void => {
      try {
        callback(null, dispatchWin32VerifierCommand(command, args), "");
      } catch (error) {
        callback(
          error instanceof Error ? error : new Error(String(error)),
          "",
          "",
        );
      }
    },
  };
});

describe("probeUpdateAttemptLock", () => {
  it("says nothing for a live publisher (alive-same), even with a supervised group, and passes the holder's identity to verifyPublisher", async () => {
    writeAttemptLock(lockPath, {
      pid: 4242,
      token: "token-1",
      processStartedAtMs: 1000,
      processStartIdentity: null,
      supervisedProcessGroupId: 4999,
    });
    const verifyPublisher = vi.fn(
      async (_token: ProcessIdentityToken): Promise<ProcessIdentityVerdict> =>
        "alive-same",
    );
    const issue = await probeUpdateAttemptLock({
      lockPath,
      verifyPublisher,
      livenessGivenPublisher: lockHolderLivenessGivenPublisher,
    });
    expect(issue).toBeNull();
    expect(verifyPublisher).toHaveBeenCalledWith({
      pid: 4242,
      startedAtMs: 1000,
      startIdentity: null,
    });
  });

  it("says nothing when the publisher's own identity cannot be verified", async () => {
    writeAttemptLock(lockPath, {
      pid: 4243,
      token: "token-2",
      processStartedAtMs: null,
      processStartIdentity: null,
    });
    const verifyPublisher = await alwaysReturns("indeterminate");
    const issue = await probeUpdateAttemptLock({
      lockPath,
      verifyPublisher,
      livenessGivenPublisher: lockHolderLivenessGivenPublisher,
    });
    expect(issue).toBeNull();
  });

  it("says nothing for a dead publisher with no supervised group and no retain flag - the lock self-heals on the next acquisition", async () => {
    writeAttemptLock(lockPath, {
      pid: 4244,
      token: "token-3",
      processStartedAtMs: null,
      processStartIdentity: null,
    });
    const verifyPublisher = await alwaysReturns("dead");
    const issue = await probeUpdateAttemptLock({
      lockPath,
      verifyPublisher,
      livenessGivenPublisher: lockHolderLivenessGivenPublisher,
    });
    expect(issue).toBeNull();
  });

  it.skipIf(process.platform === "win32")(
    "says nothing for a dead publisher whose supervised process group is provably gone on POSIX",
    async () => {
      writeAttemptLock(lockPath, {
        pid: 4245,
        token: "token-4",
        processStartedAtMs: null,
        processStartIdentity: null,
        supervisedProcessGroupId: 5001,
      });
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
        throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      });
      try {
        const verifyPublisher = await alwaysReturns("dead");
        const issue = await probeUpdateAttemptLock({
          lockPath,
          verifyPublisher,
          livenessGivenPublisher: lockHolderLivenessGivenPublisher,
        });
        expect(issue).toBeNull();
        expect(killSpy).toHaveBeenCalledWith(-5001, 0);
      } finally {
        killSpy.mockRestore();
      }
    },
  );

  it("reports an issue for a dead publisher whose supervised group cannot be verified on Windows", async () => {
    writeAttemptLock(lockPath, {
      pid: 4246,
      token: "token-5",
      processStartedAtMs: null,
      processStartIdentity: null,
      supervisedProcessGroupId: 5002,
    });
    const verifyPublisher = await alwaysReturns("dead");
    const issue = await withWin32Platform(() =>
      probeUpdateAttemptLock({
        lockPath,
        verifyPublisher,
        livenessGivenPublisher: lockHolderLivenessGivenPublisher,
      }),
    );
    expect(issue?.code).toBe(
      DOCTOR_ISSUE_CODES.HOST_UPDATE_ATTEMPT_LOCK_UNBREAKABLE,
    );
    expect(issue?.severity).toBe("warning");
    expect(issue?.message).toContain(lockPath);
    expect(issue?.message).toContain("pid 4246");
    expect(issue?.message).toContain("remove the file");
  });

  it("reports an issue for an alive-different publisher whose supervised group cannot be verified on Windows", async () => {
    writeAttemptLock(lockPath, {
      pid: 4247,
      token: "token-6",
      processStartedAtMs: null,
      processStartIdentity: null,
      supervisedProcessGroupId: 5003,
    });
    const verifyPublisher = await alwaysReturns("alive-different");
    const issue = await withWin32Platform(() =>
      probeUpdateAttemptLock({
        lockPath,
        verifyPublisher,
        livenessGivenPublisher: lockHolderLivenessGivenPublisher,
      }),
    );
    expect(issue?.code).toBe(
      DOCTOR_ISSUE_CODES.HOST_UPDATE_ATTEMPT_LOCK_UNBREAKABLE,
    );
    expect(issue?.severity).toBe("warning");
    expect(issue?.message).toContain(lockPath);
    expect(issue?.message).toContain("pid 4247");
    expect(issue?.message).toContain("remove the file");
  });

  it("reports an issue for a dead publisher that asked to be retained, even without a supervised group, on any platform", async () => {
    writeAttemptLock(lockPath, {
      pid: 4248,
      token: "token-7",
      processStartedAtMs: null,
      processStartIdentity: null,
      retainOnPublisherDeath: true,
    });
    const verifyPublisher = await alwaysReturns("dead");
    const issue = await probeUpdateAttemptLock({
      lockPath,
      verifyPublisher,
      livenessGivenPublisher: lockHolderLivenessGivenPublisher,
    });
    expect(issue?.code).toBe(
      DOCTOR_ISSUE_CODES.HOST_UPDATE_ATTEMPT_LOCK_UNBREAKABLE,
    );
    expect(issue?.severity).toBe("warning");
    expect(issue?.message).toContain("remove the file");
  });

  it("says nothing when there is no lock file", async () => {
    const verifyPublisher = vi.fn(
      async (_token: ProcessIdentityToken): Promise<ProcessIdentityVerdict> =>
        "dead",
    );
    const issue = await probeUpdateAttemptLock({
      lockPath,
      verifyPublisher,
      livenessGivenPublisher: lockHolderLivenessGivenPublisher,
    });
    expect(issue).toBeNull();
    expect(verifyPublisher).not.toHaveBeenCalled();
  });

  it("says nothing for a garbage lock file", async () => {
    writeFileSync(lockPath, "{not json");
    const verifyPublisher = vi.fn(
      async (_token: ProcessIdentityToken): Promise<ProcessIdentityVerdict> =>
        "dead",
    );
    const issue = await probeUpdateAttemptLock({
      lockPath,
      verifyPublisher,
      livenessGivenPublisher: lockHolderLivenessGivenPublisher,
    });
    expect(issue).toBeNull();
    expect(verifyPublisher).not.toHaveBeenCalled();
  });

  it("says nothing for an empty lock file", async () => {
    writeFileSync(lockPath, "");
    const verifyPublisher = vi.fn(
      async (_token: ProcessIdentityToken): Promise<ProcessIdentityVerdict> =>
        "dead",
    );
    const issue = await probeUpdateAttemptLock({
      lockPath,
      verifyPublisher,
      livenessGivenPublisher: lockHolderLivenessGivenPublisher,
    });
    expect(issue).toBeNull();
    expect(verifyPublisher).not.toHaveBeenCalled();
  });

  it("says nothing when the lock is re-taken with a different token while the publisher is being judged", async () => {
    writeAttemptLock(lockPath, {
      pid: 4249,
      token: "token-9-original",
      processStartedAtMs: null,
      processStartIdentity: null,
      supervisedProcessGroupId: 5004,
    });
    const verifyPublisher = async (
      _token: ProcessIdentityToken,
    ): Promise<ProcessIdentityVerdict> => {
      // The record is re-taken by a fresh holder while the publisher's
      // verdict is still being judged - a different token, same shape.
      writeAttemptLock(lockPath, {
        pid: 4249,
        token: "token-9-retaken",
        processStartedAtMs: null,
        processStartIdentity: null,
        supervisedProcessGroupId: 5004,
      });
      return "dead";
    };
    const issue = await withWin32Platform(() =>
      probeUpdateAttemptLock({
        lockPath,
        verifyPublisher,
        livenessGivenPublisher: lockHolderLivenessGivenPublisher,
      }),
    );
    expect(issue).toBeNull();
  });
});

// The verdict's MAPPING changed (a denied exact read now resolves through
// WMI instead of staying unread) while the SET of verdicts this probe
// recognises did not: `dead` / `alive-different` are still the only two that
// can produce an issue, and `lockHolderLivenessGivenPublisher`'s own rule is
// untouched. Pre-fix, a denied read left `verifyProcessIdentityAsync`
// indeterminate and `probeUpdateAttemptLock` said nothing - RED today. Post-
// fix, the same session-0 takeover resolves to `alive-different` and the
// EXISTING supervised-group-on-Windows mapping (already pinned above for a
// hand-written "alive-different" fake) fires unmodified.
describe("probeUpdateAttemptLock: a Windows publisher whose exact read is denied (session-0 takeover)", () => {
  afterEach(() => {
    win32VerifierScenario = null;
  });

  it("reports HOST_UPDATE_ATTEMPT_LOCK_UNBREAKABLE once the denied-read fallback resolves the publisher to alive-different", async () => {
    const pid = process.pid + 888_888;
    const recordedToken = formatWindowsProcessStartIdentity(
      "2026-05-06T07:08:09.1234567Z",
    );
    if (recordedToken === null) {
      throw new Error("fixture Windows token failed to format");
    }
    writeAttemptLock(lockPath, {
      pid,
      token: "token-win32-denied",
      processStartedAtMs: null,
      processStartIdentity: recordedToken,
      supervisedProcessGroupId: 9001,
    });
    win32VerifierScenario = {
      pid,
      livenessAlive: true,
      // 2 microseconds later than the recorded token's truncated micros -
      // past the 1us tolerance, so this is the reused-pid case.
      fallback: { deniedDmtf: "20260506070809.123458+000" },
    };

    const issue = await withWin32Platform(() =>
      probeUpdateAttemptLock({
        lockPath,
        verifyPublisher: verifyProcessIdentityAsync,
        livenessGivenPublisher: lockHolderLivenessGivenPublisher,
      }),
    );

    expect(issue?.code).toBe(
      DOCTOR_ISSUE_CODES.HOST_UPDATE_ATTEMPT_LOCK_UNBREAKABLE,
    );
    expect(issue?.severity).toBe("warning");
    expect(issue?.message).toContain(lockPath);
    expect(issue?.message).toContain(`pid ${String(pid)}`);
  });
});
