import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DoctorResult } from "../issues";
import type { ServiceDefinitionState } from "../../service/service-definition";

/**
 * `traycer host doctor`'s service-DEFINITION issues (M1):
 *
 * - `HOST_SERVICE_DEFINITION_STALE` - a non-Background mode is set, but the
 *   registered definition predates the current launcher form.
 * - `HOST_SERVICE_DEFINITION_UNRECOGNIZED` - a non-Background mode is set,
 *   but the registration is not one a Traycer emitter wrote.
 *
 * `serviceDefinitionIssues` (engine.ts) asks `createServiceDefinitionRefresher(
 * null).inspect(label)` the same question `host service refresh` acts on;
 * this suite mocks that factory (`../../service/definition-refresh`) so the
 * inspected `ServiceDefinitionState` is fully controlled, and spies on
 * `inspect` to pin the Background early return as a call-count fact, not
 * just an absent-issue fact.
 *
 * Follows `engine-lifecycle-policy.test.ts`'s pattern: a real temp host home
 * for the lifecycle-policy read, only the install record / bootstrap log /
 * service CONTROLLER mocked (status/install/etc, not the definition
 * refresher).
 */

// `store/paths` binds its home root from `os.homedir()` at module load.
const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => osHome.current || actual.tmpdir() };
});

const mocks = vi.hoisted(() => ({
  inspect: vi.fn<() => Promise<ServiceDefinitionState>>(),
}));

vi.mock("../../service/definition-refresh", () => ({
  createServiceDefinitionRefresher: () => ({
    inspect: mocks.inspect,
    refresh: vi.fn(),
  }),
}));

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;

let workHome: string;

beforeEach(() => {
  workHome = mkdtempSync(join(tmpdir(), "traycer-doctor-service-def-test-"));
  osHome.current = workHome;
  process.env.HOME = workHome;
  process.env.USERPROFILE = workHome;
  vi.resetModules();
  mocks.inspect.mockReset();
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
  vi.restoreAllMocks();
  vi.doUnmock("../../manifest/host-install");
  vi.doUnmock("../../host/bootstrap-log");
  vi.doUnmock("../../service");
});

function hostRoot(): string {
  return join(workHome, ".traycer", "host");
}

function stageQuietEnvironment(): void {
  const hostExecutablePath = join(workHome, "bin", "host");
  mkdirSync(join(workHome, "bin"), { recursive: true });
  writeFileSync(hostExecutablePath, "host-bin");
  vi.doMock("../../manifest/host-install", () => ({
    readHostInstallRecord: () => ({
      version: "1.7.2",
      environment: "production",
      executablePath: hostExecutablePath,
      installedAt: "2026-04-01T00:00:00Z",
      source: "registry",
      archiveSha256: "f".repeat(64),
      signatureKeyId: "registry:prod-2026",
    }),
  }));
  vi.doMock("../../host/bootstrap-log", () => ({
    readBootstrapMarkers: async () => [],
  }));
  vi.doMock("../../service", () => ({
    createServiceController: () => ({
      status: async () => ({
        state: "stopped",
        version: "1.7.2",
        listenUrl: null,
        pid: null,
      }),
      install: async () => undefined,
      uninstall: async () => undefined,
      start: async () => undefined,
      stop: async () => undefined,
      restart: async () => undefined,
    }),
    serviceLabelFor: (environment: string) => ({
      id: `ai.traycer.host.${environment}`,
      displayName: "Traycer Host",
      environment,
      devSlot: null,
    }),
  }));
}

function writePolicy(mode: string): void {
  mkdirSync(hostRoot(), { recursive: true });
  writeFileSync(
    join(hostRoot(), "lifecycle-policy.json"),
    JSON.stringify(
      {
        v: 1,
        rev: 1,
        mode,
        updatedAt: "2026-08-01T00:00:00.000Z",
        updatedBy: "cli",
      },
      null,
      2,
    ),
    "utf8",
  );
}

async function runDoctorHere(): Promise<DoctorResult> {
  const { runDoctor } = await import("../engine");
  return runDoctor({
    environment: "production",
    portConflictDeps: { runCommand: async () => null, platform: "darwin" },
  });
}

describe("runDoctor service-definition issues (M1)", () => {
  it("HOST_SERVICE_DEFINITION_STALE: mode already 'ask' (no transition - the policy was written before this run) plus a stale definition", async () => {
    stageQuietEnvironment();
    // "Already ask" on purpose: this doctor run is not itself the mode
    // change that would have triggered `host service refresh` - it is the
    // retry surface for a refresh that failed, or a definition an OLDER
    // CLI re-registered after the mode was already set.
    writePolicy("ask");
    mocks.inspect.mockResolvedValue({
      kind: "stale",
      form: "direct",
      appliesAt: "next-start",
    });

    const result = await runDoctorHere();
    const issue = result.issues.find(
      (candidate) => candidate.code === "HOST_SERVICE_DEFINITION_STALE",
    );

    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("warning");
    expect(issue?.fixAction).toBe("service-refresh");
    expect(issue?.terminalCommand).toBe("traycer host service refresh");
    expect(issue?.details).toEqual({
      mode: "ask",
      form: "direct",
      appliesAt: "next-start",
    });
  });

  it("HOST_SERVICE_DEFINITION_STALE: a next-login definition's message names the next login", async () => {
    stageQuietEnvironment();
    writePolicy("linked");
    mocks.inspect.mockResolvedValue({
      kind: "stale",
      form: "launcher-file",
      appliesAt: "next-login",
    });

    const result = await runDoctorHere();
    const issue = result.issues.find(
      (candidate) => candidate.code === "HOST_SERVICE_DEFINITION_STALE",
    );

    expect(issue).toBeDefined();
    expect(issue?.message).toContain("next login");
    expect(issue?.details).toMatchObject({ appliesAt: "next-login" });
  });

  it("HOST_SERVICE_DEFINITION_UNRECOGNIZED: fixAction 'service-install', terminalCommand names the install command", async () => {
    stageQuietEnvironment();
    writePolicy("stop-if-idle");
    mocks.inspect.mockResolvedValue({
      kind: "unrecognized",
      reason: "its ExecStart is not a Traycer host start",
    });

    const result = await runDoctorHere();
    const issue = result.issues.find(
      (candidate) => candidate.code === "HOST_SERVICE_DEFINITION_UNRECOGNIZED",
    );

    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("warning");
    expect(issue?.fixAction).toBe("service-install");
    expect(issue?.terminalCommand).toBe("traycer host service install");
    expect(issue?.details).toEqual({
      mode: "stop-if-idle",
      reason: "its ExecStart is not a Traycer host start",
    });
  });

  it("mode 'background' with a stale definition: neither issue fires, AND inspect is never called (the early return, not just a filtered-out issue)", async () => {
    stageQuietEnvironment();
    writePolicy("background");
    mocks.inspect.mockResolvedValue({
      kind: "stale",
      form: "direct",
      appliesAt: "next-start",
    });

    const result = await runDoctorHere();

    expect(
      result.issues.find((candidate) =>
        candidate.code.startsWith("HOST_SERVICE_DEFINITION_"),
      ),
    ).toBeUndefined();
    expect(mocks.inspect).not.toHaveBeenCalled();
  });

  it("no policy file at all (defaults to background) with a stale definition: neither issue fires, inspect never called", async () => {
    stageQuietEnvironment();
    // No lifecycle-policy.json - effective mode defaults to background.
    mocks.inspect.mockResolvedValue({
      kind: "stale",
      form: "direct",
      appliesAt: "next-start",
    });

    const result = await runDoctorHere();

    expect(
      result.issues.find((candidate) =>
        candidate.code.startsWith("HOST_SERVICE_DEFINITION_"),
      ),
    ).toBeUndefined();
    expect(mocks.inspect).not.toHaveBeenCalled();
  });

  it("current: neither issue fires (inspect IS called - the positive control for the background early return above)", async () => {
    stageQuietEnvironment();
    writePolicy("ask");
    mocks.inspect.mockResolvedValue({ kind: "current" });

    const result = await runDoctorHere();

    expect(
      result.issues.find((candidate) =>
        candidate.code.startsWith("HOST_SERVICE_DEFINITION_"),
      ),
    ).toBeUndefined();
    expect(mocks.inspect).toHaveBeenCalledTimes(1);
  });

  it("not-registered: neither issue fires", async () => {
    stageQuietEnvironment();
    writePolicy("none");
    mocks.inspect.mockResolvedValue({ kind: "not-registered" });

    const result = await runDoctorHere();

    expect(
      result.issues.find((candidate) =>
        candidate.code.startsWith("HOST_SERVICE_DEFINITION_"),
      ),
    ).toBeUndefined();
    expect(mocks.inspect).toHaveBeenCalledTimes(1);
  });
});
