import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DoctorResult } from "../issues";
import type { ServiceRegistrationDisabled } from "../../service/registration-disabled";

/**
 * `traycer host doctor`'s issue: `HOST_SERVICE_REGISTRATION_DISABLED`,
 * emitted by `serviceRegistrationIssues` (engine.ts) whenever
 * `readServiceRegistrationDisabled` reads `{kind:"disabled"}` - in ANY
 * lifecycle mode, unlike the definition issues above it which the
 * Background mode suppresses.
 *
 * Mocks `../../service/registration-disabled` (real exports via
 * `importOriginal`, plus a `vi.fn` `readServiceRegistrationDisabled`) so the
 * read is fully controlled. Follows `engine-service-definition.test.ts`'s
 * pattern: a real temp host home for the lifecycle-policy read, only the
 * install record / bootstrap log / service controller mocked.
 *
 * HOME isolation: the hoisted `node:os` mock below redirects `homedir()` to
 * a fresh per-test temp dir, and `HOME`/`USERPROFILE` are pointed at the
 * same dir - the same two-part isolation `engine-service-definition.test.ts`
 * uses. Nothing here touches the real `~/.traycer`.
 */

const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => osHome.current || actual.tmpdir() };
});

const mocks = vi.hoisted(() => ({
  readServiceRegistrationDisabled:
    vi.fn<() => Promise<ServiceRegistrationDisabled>>(),
}));

vi.mock("../../service/registration-disabled", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../service/registration-disabled")
    >();
  return {
    ...actual,
    readServiceRegistrationDisabled: mocks.readServiceRegistrationDisabled,
  };
});

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;

let workHome: string;

beforeEach(() => {
  workHome = mkdtempSync(
    join(tmpdir(), "traycer-doctor-service-registration-test-"),
  );
  osHome.current = workHome;
  process.env.HOME = workHome;
  process.env.USERPROFILE = workHome;
  vi.resetModules();
  mocks.readServiceRegistrationDisabled.mockReset();
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
  vi.doUnmock("../../service/definition-refresh");
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
  // Neutralize the sibling definition issues so this suite's assertions
  // are only ever about HOST_SERVICE_REGISTRATION_DISABLED.
  vi.doMock("../../service/definition-refresh", () => ({
    createServiceDefinitionRefresher: () => ({
      inspect: async () => ({ kind: "current" as const }),
      refresh: vi.fn(),
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

describe("runDoctor service-registration issues", () => {
  it("(d1) disabled: exactly one HOST_SERVICE_REGISTRATION_DISABLED issue, with the fields the ruling specifies", async () => {
    stageQuietEnvironment();
    // Background mode on purpose: the sibling definition issues suppress
    // themselves here, but this issue must fire in EVERY lifecycle mode.
    writePolicy("background");
    mocks.readServiceRegistrationDisabled.mockResolvedValue({
      kind: "disabled",
    });

    const result = await runDoctorHere();
    const matches = result.issues.filter(
      (candidate) => candidate.code === "HOST_SERVICE_REGISTRATION_DISABLED",
    );

    expect(matches).toHaveLength(1);
    const issue = matches[0];
    expect(issue?.severity).toBe("error");
    expect(issue?.title).toBe(
      "Traycer Host task is disabled in Task Scheduler",
    );
    expect(
      issue?.message.startsWith(
        "the Traycer Host task is disabled in Task Scheduler; enable it or run `traycer host service install`",
      ),
    ).toBe(true);
    expect(issue?.fixAction).toBe("service-install");
    expect(issue?.terminalCommand).toBe("traycer host service install");
    expect(issue?.details).toBeNull();
  });

  it("(d2) not-disabled: no HOST_SERVICE_REGISTRATION_DISABLED issue", async () => {
    stageQuietEnvironment();
    writePolicy("ask");
    mocks.readServiceRegistrationDisabled.mockResolvedValue({
      kind: "not-disabled",
    });

    const result = await runDoctorHere();

    expect(
      result.issues.find(
        (candidate) => candidate.code === "HOST_SERVICE_REGISTRATION_DISABLED",
      ),
    ).toBeUndefined();
  });

  it("(d3) unknown: no HOST_SERVICE_REGISTRATION_DISABLED issue", async () => {
    stageQuietEnvironment();
    writePolicy("linked");
    mocks.readServiceRegistrationDisabled.mockResolvedValue({
      kind: "unknown",
      reason: "schtasks /Query could not run (ETIMEDOUT)",
    });

    const result = await runDoctorHere();

    expect(
      result.issues.find(
        (candidate) => candidate.code === "HOST_SERVICE_REGISTRATION_DISABLED",
      ),
    ).toBeUndefined();
  });
});
