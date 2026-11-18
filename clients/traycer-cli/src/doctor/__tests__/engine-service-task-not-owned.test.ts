import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DoctorResult } from "../issues";
import type { ServiceRegistrationDisabled } from "../../service/registration-disabled";
import type { ServiceRegistrationOwnership } from "../../service/registration-owner";
import { SERVICE_TASK_NOT_OWNED_MESSAGE } from "../../service/platforms/windows-task-gate";

/**
 * `traycer host doctor` over a service registration another Windows user owns:
 * ONE issue, `HOST_SERVICE_TASK_NOT_OWNED`, with no fix, and none of the
 * missing / stopped / stale / disabled issues a task that is not this account's
 * would otherwise raise - every repair they offer is a write the ownership gate
 * refuses. (Structure follows `engine-service-registration-disabled.test.ts`.)
 *
 * The rest of this comment is that file's, whose harness this reuses:
 * `HOST_SERVICE_REGISTRATION_DISABLED`,
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
  readServiceRegistrationOwnership:
    vi.fn<() => Promise<ServiceRegistrationOwnership>>(),
  status: vi.fn(),
}));

vi.mock("../../service/registration-owner", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../service/registration-owner")>();
  return {
    ...actual,
    readServiceRegistrationOwnership: mocks.readServiceRegistrationOwnership,
  };
});

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
  mocks.readServiceRegistrationOwnership.mockReset();
  mocks.status.mockReset();
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
      status: mocks.status,
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
  // A STALE definition, so a task that were this account's would also raise
  // the definition issue - which the ownership issue must suppress.
  vi.doMock("../../service/definition-refresh", () => ({
    createServiceDefinitionRefresher: () => ({
      inspect: async () => ({
        kind: "stale" as const,
        form: "direct-action" as const,
        appliesAt: "next-start" as const,
      }),
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

const OTHER_SERVICE_ISSUE_CODES = [
  "SERVICE_NOT_REGISTERED",
  "HOST_SERVICE_REGISTRATION_DISABLED",
  "HOST_SERVICE_STOPPED",
  "HOST_SERVICE_DEFINITION_STALE",
];

async function runDoctorHere(): Promise<DoctorResult> {
  const { runDoctor } = await import("../engine");
  return runDoctor({
    environment: "production",
    portConflictDeps: { runCommand: async () => null, platform: "darwin" },
  });
}

describe("runDoctor over a service registration another Windows user owns", () => {
  it("(o1) not-owned: exactly one HOST_SERVICE_TASK_NOT_OWNED issue - error, no fix, no command, the refusal's own copy", async () => {
    stageQuietEnvironment();
    writePolicy("ask");
    mocks.readServiceRegistrationOwnership.mockResolvedValue({
      kind: "not-owned",
      reason: "other-owner",
    });
    mocks.readServiceRegistrationDisabled.mockResolvedValue({
      kind: "disabled",
    });
    mocks.status.mockResolvedValue({
      state: "not-installed",
      version: null,
      listenUrl: null,
      pid: null,
    });

    const result = await runDoctorHere();
    const matches = result.issues.filter(
      (candidate) => candidate.code === "HOST_SERVICE_TASK_NOT_OWNED",
    );

    expect(matches).toHaveLength(1);
    const issue = matches[0];
    expect(issue?.severity).toBe("error");
    expect(issue?.fixAction).toBeNull();
    expect(issue?.terminalCommand).toBeNull();
    expect(issue?.message).toBe(SERVICE_TASK_NOT_OWNED_MESSAGE);
    expect(issue?.message).toContain("owned by another Windows user");
    expect(issue?.details).toBeNull();
    expect(JSON.stringify(issue)).not.toMatch(/S-1-\d/);
  });

  // T08 ruling 13: a task whose owner could not be confirmed is the same
  // issue code and the same "no fix", but it is not reported as another
  // user's - nothing confirmed that it is.
  it("(o1u) unconfirmed: the same issue code, no fix, but the copy says ownership could not be confirmed and never another Windows user", async () => {
    stageQuietEnvironment();
    writePolicy("ask");
    mocks.readServiceRegistrationOwnership.mockResolvedValue({
      kind: "not-owned",
      reason: "unconfirmed",
    });
    mocks.readServiceRegistrationDisabled.mockResolvedValue({
      kind: "not-disabled",
    });
    mocks.status.mockResolvedValue({
      state: "not-installed",
      version: null,
      listenUrl: null,
      pid: null,
    });

    const result = await runDoctorHere();
    const matches = result.issues.filter(
      (candidate) => candidate.code === "HOST_SERVICE_TASK_NOT_OWNED",
    );

    expect(matches).toHaveLength(1);
    const issue = matches[0];
    expect(issue?.severity).toBe("error");
    expect(issue?.fixAction).toBeNull();
    expect(issue?.message).toBe(
      "Traycer couldn't confirm that the Traycer Host task on this PC belongs to your Windows account, so it left the task alone. Run the checks again.",
    );
    expect(JSON.stringify(issue)).not.toMatch(/another (Windows )?user/);
  });

  it("(o2) and none of the missing / stopped / stale / disabled service issues follow it", async () => {
    stageQuietEnvironment();
    writePolicy("ask");
    mocks.readServiceRegistrationOwnership.mockResolvedValue({
      kind: "not-owned",
      reason: "unconfirmed",
    });
    mocks.readServiceRegistrationDisabled.mockResolvedValue({
      kind: "disabled",
    });
    mocks.status.mockResolvedValue({
      state: "not-installed",
      version: null,
      listenUrl: null,
      pid: null,
    });

    const result = await runDoctorHere();

    expect(
      result.issues.filter((candidate) =>
        OTHER_SERVICE_ISSUE_CODES.includes(candidate.code),
      ),
    ).toEqual([]);
    // The service was not even asked about: this account has none here.
    expect(mocks.status).not.toHaveBeenCalled();
    // And no issue on the whole offers a service repair.
    expect(
      result.issues.filter(
        (candidate) =>
          candidate.fixAction === "service-install" ||
          candidate.terminalCommand === "traycer host service install",
      ),
    ).toEqual([]);
  });

  it("(o3) control: a task that is this account's (or none) raises no ownership issue, and the disabled / stale issues still appear", async () => {
    stageQuietEnvironment();
    writePolicy("ask");
    mocks.readServiceRegistrationOwnership.mockResolvedValue({
      kind: "own-or-none",
    });
    mocks.readServiceRegistrationDisabled.mockResolvedValue({
      kind: "disabled",
    });
    mocks.status.mockResolvedValue({
      state: "stopped",
      version: "1.7.2",
      listenUrl: null,
      pid: null,
    });

    const result = await runDoctorHere();
    const codes = result.issues.map((candidate) => candidate.code);

    expect(codes).not.toContain("HOST_SERVICE_TASK_NOT_OWNED");
    expect(codes).toContain("HOST_SERVICE_REGISTRATION_DISABLED");
    expect(mocks.status).toHaveBeenCalled();
  });

  it("(o4) an ownership read that throws raises no issue and does not stop the other checks", async () => {
    stageQuietEnvironment();
    writePolicy("ask");
    mocks.readServiceRegistrationOwnership.mockRejectedValue(
      new Error("schtasks exploded"),
    );
    mocks.readServiceRegistrationDisabled.mockResolvedValue({
      kind: "disabled",
    });
    mocks.status.mockResolvedValue({
      state: "stopped",
      version: "1.7.2",
      listenUrl: null,
      pid: null,
    });

    const result = await runDoctorHere();
    const codes = result.issues.map((candidate) => candidate.code);

    expect(codes).not.toContain("HOST_SERVICE_TASK_NOT_OWNED");
    expect(codes).toContain("HOST_SERVICE_REGISTRATION_DISABLED");
  });
});
