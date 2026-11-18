import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../update-mutation", () => ({
  DesktopAttemptCapabilityError: class DesktopAttemptCapabilityError extends Error {
    readonly verdict: string;
    constructor(verdict: string) {
      super("desktop update attempt capability is not live");
      this.verdict = verdict;
    }
  },
}));
import {
  acquireUpdateAttemptLock,
  isUpdateAttemptLockHeldInProcess,
  updateAttemptLockPath,
  updateAttemptRecordPath,
  type HostUpdateAttemptRecord,
} from "@traycer-clients/shared/host-update";
import {
  acquireDesktopCliLock,
  type DesktopCliLockHandle,
} from "../desktop-cli-lock";
import { withDesktopUpdateContender } from "../update-contender";

const roots: string[] = [];
const heldLocks: DesktopCliLockHandle[] = [];

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "desktop-update-contender-test-"));
  roots.push(root);
  return root;
}

function record(
  overrides: Partial<HostUpdateAttemptRecord>,
): HostUpdateAttemptRecord {
  return {
    schemaVersion: 2,
    attemptId: "desktop-attempt-1",
    generation: 1,
    sequence: 1,
    trigger: "manual",
    targetVersion: "2.0.0",
    phase: "downloading",
    execution: "active",
    continuation: null,
    progress: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    error: null,
    ...overrides,
  };
}

async function writeAttemptRecord(
  hostHomeDir: string,
  bytes: HostUpdateAttemptRecord | string,
): Promise<void> {
  await mkdir(hostHomeDir, { recursive: true });
  await writeFile(
    updateAttemptRecordPath(hostHomeDir),
    typeof bytes === "string" ? bytes : `${JSON.stringify(bytes)}\n`,
  );
}

afterEach(async () => {
  await Promise.all(
    heldLocks
      .splice(0)
      .map((handle) => handle.release().catch(() => undefined)),
  );
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("withDesktopUpdateContender", () => {
  it("holds the outer attempt lock before the inner CLI lock and releases both", async () => {
    const root = await freshRoot();
    const hostHomeDir = join(root, "host-home");
    const lockPath = join(root, "cli-lock");
    await mkdir(hostHomeDir, { recursive: true });
    const seen: string[] = [];

    const outcome = await withDesktopUpdateContender(
      {
        hostHomeDir,
        lockPath,
        reason: "desktop-order-test",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "service-maintenance",
      },
      async () => {
        seen.push("attempt-held");
        await expect(
          stat(updateAttemptLockPath(hostHomeDir)),
        ).resolves.toBeDefined();
        await expect(stat(lockPath)).resolves.toBeDefined();
        expect(isUpdateAttemptLockHeldInProcess(hostHomeDir)).toBe(true);
        return "ok";
      },
    );

    expect(outcome).toEqual({ kind: "acquired", result: "ok" });
    expect(seen).toEqual(["attempt-held"]);
    await expect(stat(updateAttemptLockPath(hostHomeDir))).rejects.toThrow();
    await expect(stat(updateAttemptRecordPath(hostHomeDir))).rejects.toThrow();
    await expect(stat(lockPath)).rejects.toThrow();
    expect(isUpdateAttemptLockHeldInProcess(hostHomeDir)).toBe(false);
  });

  it("maps inner CLI-lock contention to the desktop busy outcome and does not run the mutator", async () => {
    const root = await freshRoot();
    const hostHomeDir = join(root, "host-home");
    const lockPath = join(root, "cli-lock");
    await mkdir(hostHomeDir, { recursive: true });
    const acquired = await acquireDesktopCliLock({
      lockPath,
      reason: "existing-cli-holder",
      waitMs: 0,
      pollIntervalMs: 10,
    });
    expect(acquired.kind).toBe("acquired");
    if (acquired.kind !== "acquired") return;
    const held = acquired.handle;
    heldLocks.push(held);
    let callbackCalls = 0;

    const outcome = await withDesktopUpdateContender(
      {
        hostHomeDir,
        lockPath,
        reason: "desktop-busy-test",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "service-maintenance",
      },
      async () => {
        callbackCalls += 1;
        return "must-not-run";
      },
    );

    expect(outcome.kind).toBe("busy");
    if (outcome.kind !== "busy") return;
    expect(outcome.holder?.token).toBe(held.metadata.token);
    expect(callbackCalls).toBe(0);
    expect(isUpdateAttemptLockHeldInProcess(hostHomeDir)).toBe(false);
  });

  it("preserves a real outer-attempt holder as attempt busy", async () => {
    const root = await freshRoot();
    const hostHomeDir = join(root, "host-home");
    const lockPath = join(root, "cli-lock");
    await mkdir(hostHomeDir, { recursive: true });
    const held = await acquireUpdateAttemptLock({
      hostHomeDir,
      reason: "outer-holder",
      waitMs: 0,
      pollIntervalMs: 10,
    });
    expect(held.kind).toBe("acquired");
    if (held.kind !== "acquired") return;
    try {
      const outcome = await withDesktopUpdateContender(
        {
          hostHomeDir,
          lockPath,
          reason: "desktop-outer-busy-test",
          waitMs: 0,
          pollIntervalMs: 10,
          admission: "desktop-activation-maintenance",
        },
        async () => "must-not-run",
      );

      expect(outcome.kind).toBe("busy");
      if (outcome.kind !== "busy") return;
      expect(outcome.source).toBe("attempt");
      expect(outcome.holder?.token).toBe(held.handle.metadata.token);
    } finally {
      await held.handle.release();
    }
  });

  it.each([
    ["nonterminal", record({}), "nonterminal-attempt"],
    ["corrupt", "not-json", "record-fail-closed"],
    [
      "unsupported",
      JSON.stringify({ ...record({}), schemaVersion: 99 }),
      "record-fail-closed",
    ],
  ] as const)(
    "preserves %s admission evidence instead of mapping it to busy",
    async (_label, bytes, expectedKind) => {
      const root = await freshRoot();
      const hostHomeDir = join(root, "host-home");
      await writeAttemptRecord(hostHomeDir, bytes);

      const outcome = await withDesktopUpdateContender(
        {
          hostHomeDir,
          lockPath: join(root, "cli-lock"),
          reason: "desktop-record-test",
          waitMs: 0,
          pollIntervalMs: 10,
          admission: "desktop-activation-maintenance",
        },
        async () => "must-not-run",
      );

      expect(outcome.kind).toBe(expectedKind);
      if (expectedKind === "nonterminal-attempt") {
        if (outcome.kind !== "nonterminal-attempt") return;
        expect(outcome.disposition).toBe("refuse");
        expect(outcome.record.attemptId).toBe("desktop-attempt-1");
      } else {
        expect(outcome).toMatchObject({ kind: "record-fail-closed" });
        if (outcome.kind !== "record-fail-closed") return;
        expect(outcome.record.kind).toBe(
          _label === "corrupt" ? "corrupt" : "unsupported-version",
        );
      }
    },
  );

  it("preserves unreadable and terminal evidence distinctly", async () => {
    const unreadableRoot = await freshRoot();
    const unreadableHome = join(unreadableRoot, "host-home");
    await mkdir(unreadableHome, { recursive: true });
    await mkdir(updateAttemptRecordPath(unreadableHome));
    const unreadable = await withDesktopUpdateContender(
      {
        hostHomeDir: unreadableHome,
        lockPath: join(unreadableRoot, "cli-lock"),
        reason: "desktop-unreadable-test",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "desktop-activation-maintenance",
      },
      async () => "must-not-run",
    );
    expect(unreadable.kind).toBe("record-fail-closed");
    if (unreadable.kind === "record-fail-closed") {
      expect(unreadable.record.kind).toBe("unreadable");
    }

    const terminalRoot = await freshRoot();
    const terminalHome = join(terminalRoot, "host-home");
    await writeAttemptRecord(
      terminalHome,
      record({
        execution: "terminal",
        phase: "complete",
        completedAt: "2026-01-01T00:10:00.000Z",
      }),
    );
    const terminal = await withDesktopUpdateContender(
      {
        hostHomeDir: terminalHome,
        lockPath: join(terminalRoot, "cli-lock"),
        reason: "desktop-terminal-test",
        waitMs: 0,
        pollIntervalMs: 10,
        admission: "desktop-activation-maintenance",
      },
      async () => "terminal-ok",
    );
    expect(terminal).toEqual({ kind: "acquired", result: "terminal-ok" });
  });
});
