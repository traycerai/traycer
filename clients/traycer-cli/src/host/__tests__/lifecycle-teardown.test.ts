import { describe, expect, it, vi, type Mock } from "vitest";
import {
  SHUTDOWN_FORCE_EXIT_MS,
  STOP_EXIT_GRACE_MARGIN_MS,
} from "@traycer/protocol/host/lifecycle-constants";
import type { ShutdownClaimIntent } from "@traycer/protocol/host/lifecycle/schemas";
import type { ILogger, LogFields } from "../../logger";
import { CLI_ERROR_CODES, CliError } from "../../runner/errors";
import { ServiceMutationAuthorityError } from "../../service/mutation-authority";
import type {
  CooperativeShutdownOutcome,
  ForcedShutdownOutcome,
} from "../../service/platforms/desktop-agent-shutdown";
import type { PublishedProcessIdentityVerdict } from "../../store/process-identity";
import type { HostPidMetadata } from "../pid-metadata";
import {
  classifyTeardownFailure,
  createLifecycleTeardown,
  type LifecycleTeardown,
  type LifecycleTeardownPlatform,
  type OwnedHostChild,
  type TeardownAttemptResult,
} from "../lifecycle-teardown";

const TERM_GRACE = SHUTDOWN_FORCE_EXIT_MS + STOP_EXIT_GRACE_MARGIN_MS;

const silentLogger: ILogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function cliError(code: CliError["code"]): CliError {
  return new CliError({ code, message: "x", details: null, exitCode: 1 });
}

function record(pid: number): HostPidMetadata {
  return {
    pid,
    hostId: "h",
    version: "1.0.0",
    websocketUrl: "ws://127.0.0.1:1",
    startedAt: "2026-01-01T00:00:00.000Z",
    processStartIdentity: "ident",
    processStartIdentityRead: "present",
    layer0: null,
    layer0Slot: null,
  };
}

interface FakeChild extends OwnedHostChild {
  end: () => void;
  signals: string[];
}

function fakeChild(
  pid: number,
  seq: string[],
  behaviour: { endsOnSignal: "SIGTERM" | "SIGKILL" | null },
): FakeChild {
  let ended = false;
  const waiters: Array<(value: boolean) => void> = [];
  const end = (): void => {
    ended = true;
    for (const w of waiters.splice(0)) w(true);
  };
  const signals: string[] = [];
  return {
    pid,
    ended: () => ended,
    waitForEnd: (timeoutMs) => {
      seq.push(`waitForEnd:${timeoutMs}`);
      if (ended) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        waiters.push(resolve);
        setTimeout(() => resolve(ended), timeoutMs);
      });
    },
    signal: (signal) => {
      seq.push(`signal:${signal}`);
      signals.push(signal);
      if (behaviour.endsOnSignal === signal) end();
    },
    end,
    signals,
  };
}

interface InfoLine {
  readonly message: string;
  readonly fields: LogFields;
}

interface Harness {
  readonly infos: InfoLine[];
  readonly seq: string[];
  readonly platform: LifecycleTeardownPlatform;
  readonly commit: Mock<() => void>;
  readonly removeCalls: Array<{ pid: number }>;
  readonly state: {
    record: HostPidMetadata | null;
    cooperative: CooperativeShutdownOutcome;
    force: ForcedShutdownOutcome;
    verdict: PublishedProcessIdentityVerdict;
    lockError: Error | null;
    killError: Error | null;
    removeResult: boolean;
    child: FakeChild | null;
    onCooperative: () => void;
    onKill: () => void;
    onForce: () => void;
  };
  readonly teardown: LifecycleTeardown;
}

function harness(platformName: NodeJS.Platform): Harness {
  const seq: string[] = [];
  const commit = vi.fn(() => {
    seq.push("commit");
  });
  const removeCalls: Array<{ pid: number }> = [];
  const state: Harness["state"] = {
    record: null,
    cooperative: { kind: "stopped" },
    force: { kind: "stopped" },
    verdict: "dead",
    lockError: null,
    killError: null,
    removeResult: true,
    child: null,
    onCooperative: () => undefined,
    onKill: () => undefined,
    onForce: () => undefined,
  };
  const platform: LifecycleTeardownPlatform = {
    platform: platformName,
    withLock: async (_env, run) => {
      seq.push("lock");
      if (state.lockError !== null) throw state.lockError;
      return run(async () => {
        seq.push("verify");
      });
    },
    readPidMetadata: async () => {
      seq.push("readPid");
      return state.record;
    },
    requestCooperativeShutdown: async (
      _env: string,
      operation: string,
      intent: ShutdownClaimIntent,
    ) => {
      seq.push(`cooperative:${operation}:${intent}`);
      state.onCooperative();
      return state.cooperative;
    },
    forceStopPublishedHost: async () => {
      seq.push("force");
      state.onForce();
      return state.force;
    },
    killHostTree: async (_env, rootPid) => {
      seq.push(`killTree:${rootPid}`);
      state.onKill();
      if (state.killError !== null) throw state.killError;
    },
    verifyPublishedInstance: async () => {
      seq.push("verifyInstance");
      return state.verdict;
    },
    removePidMetadataIfUnchanged: async (_env, instance) => {
      seq.push("purge");
      removeCalls.push({ pid: instance.pid });
      return state.removeResult;
    },
  };
  const infos: InfoLine[] = [];
  const teardown = createLifecycleTeardown({
    environment: "dev",
    logger: {
      ...silentLogger,
      info: (message, fields) => {
        infos.push({ message, fields });
      },
    },
    platform,
    ownChild: () => state.child,
    commit,
  });
  return { infos, seq, platform, commit, removeCalls, state, teardown };
}

const yes = async (): Promise<boolean> => true;
const no = (): boolean => false;

async function attemptOnce(h: Harness): Promise<TeardownAttemptResult> {
  return h.teardown.attempt(yes, no);
}

describe("classifyTeardownFailure", () => {
  it("maps each failure to its bounded reason", () => {
    expect(
      classifyTeardownFailure(cliError(CLI_ERROR_CODES.CLI_LOCK_BUSY)),
    ).toBe("cli-lock-busy");
    expect(
      classifyTeardownFailure(
        cliError(CLI_ERROR_CODES.HOST_UPDATE_ATTEMPT_ACTIVE),
      ),
    ).toBe("update-attempt-active");
    expect(
      classifyTeardownFailure(
        cliError(CLI_ERROR_CODES.HOST_INSTALL_RECORD_INVALID),
      ),
    ).toBe("update-record-unverifiable");
    expect(
      classifyTeardownFailure(cliError(CLI_ERROR_CODES.SERVICE_CONTROL_FAILED)),
    ).toBe("tree-kill-refused");
    expect(
      classifyTeardownFailure(new ServiceMutationAuthorityError("gone")),
    ).toBe("lock-lost");
    expect(classifyTeardownFailure(new Error("boom"))).toBe("step-threw");
  });
});

describe("createLifecycleTeardown: gates before commit", () => {
  it("a busy lock retries without committing or touching anything", async () => {
    const h = harness("linux");
    h.state.lockError = cliError(CLI_ERROR_CODES.CLI_LOCK_BUSY);
    h.state.child = fakeChild(5, h.seq, { endsOnSignal: null });
    expect(await attemptOnce(h)).toEqual({
      kind: "retry",
      reason: "cli-lock-busy",
    });
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.seq).toEqual(["lock"]);
    expect(h.teardown.committed()).toBe(false);
  });

  it("classifies a thrown non-CliError as step-threw", async () => {
    const h = harness("linux");
    h.state.lockError = new Error("x");
    expect(await attemptOnce(h)).toEqual({
      kind: "retry",
      reason: "step-threw",
    });
  });

  it("classifies an authority loss as lock-lost", async () => {
    const h = harness("linux");
    h.state.lockError = new ServiceMutationAuthorityError("gone");
    expect(await attemptOnce(h)).toEqual({
      kind: "retry",
      reason: "lock-lost",
    });
  });

  it("reconfirm false cancels without committing", async () => {
    const h = harness("linux");
    const result = await h.teardown.attempt(async () => false, no);
    expect(result).toEqual({ kind: "cancelled", reason: "not-reconfirmed" });
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.teardown.committed()).toBe(false);
  });

  it("aborted cancels without committing", async () => {
    const h = harness("linux");
    const result = await h.teardown.attempt(yes, () => true);
    expect(result).toEqual({ kind: "cancelled", reason: "supervisor-exiting" });
    expect(h.commit).not.toHaveBeenCalled();
  });

  it("a committed teardown never reconfirms again", async () => {
    const h = harness("linux");
    const child = fakeChild(5, h.seq, { endsOnSignal: null });
    child.end();
    h.state.child = child;
    const reconfirm = vi.fn(async () => true);
    await h.teardown.attempt(reconfirm, no);
    await h.teardown.attempt(reconfirm, no);
    expect(reconfirm).toHaveBeenCalledTimes(1);
    expect(h.commit).toHaveBeenCalledTimes(1);
    expect(h.teardown.committed()).toBe(true);
  });
});

describe("createLifecycleTeardown: cooperative stop", () => {
  it("runs lock, reconfirm, commit, cooperative, confirm, purge in order", async () => {
    const h = harness("linux");
    const child = fakeChild(5, h.seq, { endsOnSignal: null });
    h.state.child = child;
    h.state.record = record(5);
    h.state.onCooperative = () => child.end();
    const reconfirm = vi.fn(async () => {
      h.seq.push("reconfirm");
      return true;
    });
    expect(await h.teardown.attempt(reconfirm, no)).toEqual({
      kind: "complete",
    });
    expect(
      h.seq.filter((s) => !s.startsWith("waitForEnd") && s !== "verify"),
    ).toEqual([
      "lock",
      "reconfirm",
      "commit",
      "readPid",
      "cooperative:lifecycle-presence-stop:shutdown",
      "readPid",
      "verifyInstance",
      "purge",
    ]);
    expect(h.removeCalls).toEqual([{ pid: 5 }]);
    expect(h.seq).not.toContain("force");
  });

  it.each(["busy", "unreachable", "hung"] as const)(
    "POSIX cooperative %s escalates to the published force stop",
    async (kind) => {
      const h = harness("linux");
      const child = fakeChild(5, h.seq, { endsOnSignal: null });
      h.state.child = child;
      h.state.record = record(5);
      h.state.cooperative =
        kind === "busy"
          ? { kind: "busy" }
          : kind === "unreachable"
            ? { kind: "unreachable", cause: "x" }
            : { kind: "hung", pid: 5 };
      h.state.onForce = () => child.end();
      expect(await attemptOnce(h)).toEqual({ kind: "complete" });
      const cooperativeIdx = h.seq.findIndex((s) =>
        s.startsWith("cooperative"),
      );
      const forceIdx = h.seq.indexOf("force");
      expect(cooperativeIdx).toBeGreaterThan(-1);
      expect(forceIdx).toBeGreaterThan(cooperativeIdx);
      expect(h.seq.indexOf("purge")).toBeGreaterThan(forceIdx);
    },
  );

  it.each([
    [{ kind: "identity-unverified", pid: 5 } as const, "identity-unverified"],
    [{ kind: "hung", pid: 5 } as const, "host-hung"],
  ])("force %j retries as %s with no purge", async (force, reason) => {
    const h = harness("linux");
    h.state.child = fakeChild(5, h.seq, { endsOnSignal: null });
    h.state.record = record(5);
    h.state.cooperative = { kind: "hung", pid: 5 };
    h.state.force = force;
    expect(await attemptOnce(h)).toEqual({ kind: "retry", reason });
    expect(h.removeCalls).toHaveLength(0);
  });

  it("reports host-survived when the child does not end after the stop", async () => {
    vi.useFakeTimers();
    try {
      const h = harness("linux");
      h.state.child = fakeChild(5, h.seq, { endsOnSignal: null });
      h.state.record = record(5);
      const pending = attemptOnce(h);
      await vi.advanceTimersByTimeAsync(STOP_EXIT_GRACE_MARGIN_MS + 1);
      expect(await pending).toEqual({ kind: "retry", reason: "host-survived" });
      expect(h.removeCalls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createLifecycleTeardown: Windows", () => {
  it("cooperative busy tree-kills rooted at the child, never force-stops", async () => {
    const h = harness("win32");
    const child = fakeChild(42, h.seq, { endsOnSignal: null });
    h.state.child = child;
    h.state.record = record(42);
    h.state.cooperative = { kind: "busy" };
    h.state.onKill = () => child.end();
    expect(await attemptOnce(h)).toEqual({ kind: "complete" });
    expect(h.seq).toContain("killTree:42");
    expect(h.seq).not.toContain("force");
    expect(child.signals).toEqual([]);
  });

  it("a refused tree kill retries as tree-kill-refused", async () => {
    const h = harness("win32");
    h.state.child = fakeChild(42, h.seq, { endsOnSignal: null });
    h.state.record = record(42);
    h.state.cooperative = { kind: "busy" };
    h.state.killError = cliError(CLI_ERROR_CODES.SERVICE_CONTROL_FAILED);
    expect(await attemptOnce(h)).toEqual({
      kind: "retry",
      reason: "tree-kill-refused",
    });
  });

  it("an absent pid.json tree-kills the child without a cooperative call", async () => {
    const h = harness("win32");
    const child = fakeChild(42, h.seq, { endsOnSignal: null });
    h.state.child = child;
    h.state.record = null;
    h.state.onKill = () => child.end();
    expect(await attemptOnce(h)).toEqual({ kind: "complete" });
    expect(h.seq.some((s) => s.startsWith("cooperative"))).toBe(false);
    expect(h.seq).toContain("killTree:42");
  });
});

describe("createLifecycleTeardown: pid.json not naming the child", () => {
  it.each([
    ["absent", null],
    ["a different pid", record(999)],
  ])(
    "%s: never cooperative; SIGTERM ends the child on POSIX",
    async (_n, rec) => {
      const h = harness("linux");
      const child = fakeChild(5, h.seq, { endsOnSignal: "SIGTERM" });
      h.state.child = child;
      h.state.record = rec;
      h.state.verdict = "current";
      const result = await attemptOnce(h);
      expect(h.seq.some((s) => s.startsWith("cooperative"))).toBe(false);
      expect(h.seq).not.toContain("force");
      expect(child.signals).toEqual(["SIGTERM"]);
      // A foreign live record is left alone; an absent one completes.
      expect(result).toEqual({ kind: "complete" });
      expect(h.removeCalls).toHaveLength(0);
    },
  );

  it("escalates to SIGKILL only after the grace", async () => {
    vi.useFakeTimers();
    try {
      const h = harness("linux");
      const child = fakeChild(5, h.seq, { endsOnSignal: "SIGKILL" });
      h.state.child = child;
      h.state.record = null;
      const pending = attemptOnce(h);
      await vi.advanceTimersByTimeAsync(TERM_GRACE - 1);
      expect(child.signals).toEqual(["SIGTERM"]);
      await vi.advanceTimersByTimeAsync(2);
      expect(await pending).toEqual({ kind: "complete" });
      expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Windows with a foreign record tree-kills at the child", async () => {
    const h = harness("win32");
    const child = fakeChild(42, h.seq, { endsOnSignal: null });
    h.state.child = child;
    h.state.record = record(7);
    h.state.verdict = "current";
    h.state.onKill = () => child.end();
    await attemptOnce(h);
    expect(h.seq).toContain("killTree:42");
    expect(h.seq.some((s) => s.startsWith("cooperative"))).toBe(false);
  });
});

describe("createLifecycleTeardown: confirm and purge", () => {
  it("leaves a live foreign record alone", async () => {
    const h = harness("linux");
    h.state.child = null;
    h.state.record = record(900);
    h.state.verdict = "current";
    expect(await attemptOnce(h)).toEqual({ kind: "complete" });
    expect(h.removeCalls).toHaveLength(0);
  });

  it("never purges a foreign record on an indeterminate verdict", async () => {
    const h = harness("linux");
    h.state.child = null;
    h.state.record = record(900);
    h.state.verdict = "indeterminate";
    expect(await attemptOnce(h)).toEqual({ kind: "complete" });
    expect(h.removeCalls).toHaveLength(0);
  });

  it("purges the record of our own ended child even when indeterminate", async () => {
    const h = harness("linux");
    const child = fakeChild(5, h.seq, { endsOnSignal: null });
    child.end();
    h.state.child = child;
    h.state.record = record(5);
    h.state.verdict = "indeterminate";
    expect(await attemptOnce(h)).toEqual({ kind: "complete" });
    expect(h.removeCalls).toEqual([{ pid: 5 }]);
  });

  it("purges on dead and mismatch verdicts", async () => {
    for (const verdict of ["dead", "mismatch"] as const) {
      const h = harness("linux");
      h.state.record = record(900);
      h.state.verdict = verdict;
      expect(await attemptOnce(h)).toEqual({ kind: "complete" });
      expect(h.removeCalls).toEqual([{ pid: 900 }]);
    }
  });

  it("retries when our own ended child's pid still reads as live", async () => {
    const h = harness("linux");
    const child = fakeChild(5, h.seq, { endsOnSignal: null });
    child.end();
    h.state.child = child;
    h.state.record = record(5);
    h.state.verdict = "current";
    expect(await attemptOnce(h)).toEqual({
      kind: "retry",
      reason: "host-survived",
    });
    expect(h.removeCalls).toHaveLength(0);
  });

  it("still completes when the record changed underneath the purge", async () => {
    const h = harness("linux");
    h.state.record = record(900);
    h.state.verdict = "dead";
    h.state.removeResult = false;
    expect(await attemptOnce(h)).toEqual({ kind: "complete" });
    expect(h.removeCalls).toEqual([{ pid: 900 }]);
  });

  it("completes with no record at all", async () => {
    const h = harness("linux");
    h.state.child = null;
    h.state.record = null;
    expect(await attemptOnce(h)).toEqual({ kind: "complete" });
    expect(h.seq).not.toContain("purge");
  });

  it("an ended child goes straight to confirm without a stop", async () => {
    const h = harness("linux");
    const child = fakeChild(5, h.seq, { endsOnSignal: null });
    child.end();
    h.state.child = child;
    h.state.record = record(5);
    await attemptOnce(h);
    expect(
      h.seq.some((s) => s.startsWith("cooperative") || s === "force"),
    ).toBe(false);
    expect(h.removeCalls).toEqual([{ pid: 5 }]);
  });
});

describe("createLifecycleTeardown: resuming a committed teardown", () => {
  it("a committed teardown whose child already ended confirms and purges WITHOUT taking the lock", async () => {
    const h = harness("linux");
    const child = fakeChild(5, h.seq, { endsOnSignal: null });
    h.state.child = child;
    h.state.record = record(5);
    h.state.verdict = "dead";
    // First attempt commits and cannot finish: the child survives.
    vi.useFakeTimers();
    try {
      const pending = attemptOnce(h);
      await vi.advanceTimersByTimeAsync(STOP_EXIT_GRACE_MARGIN_MS + 1);
      expect(await pending).toEqual({ kind: "retry", reason: "host-survived" });
    } finally {
      vi.useRealTimers();
    }
    expect(h.teardown.committed()).toBe(true);
    const locksBefore = h.seq.filter((s) => s === "lock").length;
    child.end();
    expect(await attemptOnce(h)).toEqual({ kind: "complete" });
    expect(h.seq.filter((s) => s === "lock").length).toBe(locksBefore);
    expect(h.removeCalls).toEqual([{ pid: 5 }]);
  });

  it("a committed teardown with no child at all also skips the lock", async () => {
    const h = harness("linux");
    h.state.child = null;
    await h.teardown.attempt(yes, no);
    const locks = h.seq.filter((s) => s === "lock").length;
    expect(locks).toBe(1);
    await attemptOnce(h);
    expect(h.seq.filter((s) => s === "lock").length).toBe(1);
  });
});

describe("createLifecycleTeardown: INFO line fields", () => {
  function fieldsOf(h: Harness, fragment: string): LogFields {
    const line = h.infos.find((entry) => entry.message.includes(fragment));
    if (line === undefined)
      throw new Error(`no INFO line containing ${fragment}`);
    return line.fields;
  }

  it("the commit line carries exactly {reason, admission}", async () => {
    const h = harness("linux");
    await attemptOnce(h);
    const fields = fieldsOf(h, "Host supervisor stopping its host");
    expect(Object.keys(fields).sort()).toEqual(["admission", "reason"]);
    expect(fields).toEqual({
      reason: "lifecycle-presence-stop",
      admission: "lifecycle-teardown-maintenance",
    });
  });

  it("no host record: exactly {reason: record-absent}", async () => {
    const h = harness("linux");
    h.state.record = null;
    await attemptOnce(h);
    const fields = fieldsOf(h, "found no host record");
    expect(Object.keys(fields).sort()).toEqual(["reason"]);
    expect(fields).toEqual({ reason: "record-absent" });
  });

  it("a live foreign record: exactly {reason, verdict: current}", async () => {
    const h = harness("linux");
    h.state.record = record(900);
    h.state.verdict = "current";
    await attemptOnce(h);
    const fields = fieldsOf(h, "foreign host record alone");
    expect(Object.keys(fields).sort()).toEqual(["reason", "verdict"]);
    expect(fields).toEqual({ reason: "foreign-host-live", verdict: "current" });
  });

  it("an unverifiable foreign record: exactly {reason, verdict: indeterminate}", async () => {
    const h = harness("linux");
    h.state.record = record(900);
    h.state.verdict = "indeterminate";
    await attemptOnce(h);
    const fields = fieldsOf(h, "foreign host record alone");
    expect(Object.keys(fields).sort()).toEqual(["reason", "verdict"]);
    expect(fields).toEqual({
      reason: "foreign-host-unverifiable",
      verdict: "indeterminate",
    });
  });

  it.each([
    [true, "purged"],
    [false, "record-changed"],
  ] as const)(
    "a settled record (removed=%s): exactly {reason: %s, verdict}",
    async (removed, reason) => {
      const h = harness("linux");
      h.state.record = record(900);
      h.state.verdict = "dead";
      h.state.removeResult = removed;
      await attemptOnce(h);
      const fields = fieldsOf(h, "settled the host record");
      expect(Object.keys(fields).sort()).toEqual(["reason", "verdict"]);
      expect(fields).toEqual({ reason, verdict: "dead" });
    },
  );
});
