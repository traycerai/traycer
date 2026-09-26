import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// `traycer host service start` (commands/service-start.ts) is one of the
// three callers that pass through `startHostServiceWithAttempt`
// (CRASH-RELAUNCH-ENSURE-RACE). When the host is not positively serving but
// its own supervisor is alive, this command must report the relaunch and
// start nothing - never publish an adoption proof the manager would start
// nothing to consume.

const homeRef = vi.hoisted(() => ({ current: "" }));
vi.mock("../../store/paths", () => ({
  hostHomeDir: () => homeRef.current,
}));

const mocks = vi.hoisted(() => ({
  controllerCalls: [] as string[],
  lockCalls: [] as Array<{ reason: string }>,
}));

vi.mock("../../service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../service")>();
  return {
    ...actual,
    serviceLabelFor: () => ({
      id: "ai.traycer.host",
      displayName: "Traycer Host",
      environment: "production",
      devSlot: null,
    }),
    createServiceController: () => ({
      status: async () => ({
        state: "stopped" as const,
        version: null,
        listenUrl: null,
        pid: null,
      }),
      start: async () => {
        mocks.controllerCalls.push("start");
      },
      hostStartAdoptionLabel: async (label: { id: string }) => label.id,
    }),
  };
});

vi.mock("../../host/incumbent-check", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../host/incumbent-check")>()),
  findLiveIncumbentHost: async () => null,
}));

vi.mock("../../store/cli-lock", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../store/cli-lock")>();
  return {
    ...actual,
    withCliLock: async <T>(
      opts: { reason: string },
      fn: () => Promise<T>,
    ): Promise<T> => {
      mocks.lockCalls.push({ reason: opts.reason });
      return fn();
    },
  };
});

import { buildServiceStartCommand } from "../service-start";
import type { CommandContext } from "../../runner/runner";
import { readProcessStartIdentity } from "../../store/process-identity";
import {
  writeSupervisorRecords,
  type SupervisorRunState,
} from "../../host/lifecycle-files";
import type { ProcessStartIdentity } from "@traycer/protocol/host/lifecycle";
import type { SupervisorRecord } from "@traycer/protocol/config/supervisor-record";

const roots: string[] = [];

async function freshHome(): Promise<string> {
  const root = await mkdtemp(
    join(tmpdir(), "service-start-supervisor-relaunch-test-"),
  );
  roots.push(root);
  return join(root, "host-home");
}

afterEach(async () => {
  homeRef.current = "";
  mocks.controllerCalls = [];
  mocks.lockCalls = [];
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function sampleSupervisorRecord(pid: number): SupervisorRecord {
  return {
    v: 1,
    pid,
    cliVersion: "1.0.0",
    capabilities: [],
    startedAt: new Date().toISOString(),
  };
}

function sampleRunState(
  pid: number,
  admission: SupervisorRunState["admission"],
  identity: ProcessStartIdentity | null,
): SupervisorRunState {
  return {
    v: 1,
    supervisorPid: pid,
    supervisorStartIdentity: identity,
    admission,
    origin: null,
    adopted: false,
    lastPresence: null,
    updatedAt: new Date().toISOString(),
  };
}

function fakeCtx(): CommandContext {
  return {
    runtime: {
      json: false,
      quiet: false,
      noProgress: false,
      noBootstrap: false,
      nonInteractive: false,
      environment: "production",
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    },
    output: {
      progress: vi.fn(),
      human: vi.fn(),
      humanRequired: vi.fn(),
      emitResult: vi.fn(),
      emitError: vi.fn(),
    },
    progress: vi.fn(),
  };
}

describe("buildServiceStartCommand - CRASH-RELAUNCH-ENSURE-RACE", () => {
  it("exits 0 with data.supervisorRelaunchingPid and starts nothing when the host is not serving but its own supervisor is alive", async () => {
    const hostHomeDir = await freshHome();
    homeRef.current = hostHomeDir;
    const identity = readProcessStartIdentity(process.pid);
    await writeSupervisorRecords("production", {
      record: sampleSupervisorRecord(process.pid),
      runState: sampleRunState(process.pid, "granted", identity),
    });

    const result = await buildServiceStartCommand({
      lifecycleOrigin: "terminal",
    })(fakeCtx());

    expect(result.exitCode).toBe(0);
    expect(result.data).toMatchObject({
      supervisorRelaunchingPid: process.pid,
    });
    expect(mocks.controllerCalls).toEqual([]);
    expect(result.human ?? "").toContain(
      `its supervisor (pid ${String(process.pid)}) is relaunching the host`,
    );
    expect(result.human ?? "").toContain("no start was requested");
  });
});
