import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Doctor used to CANCEL a crash marker whenever a later `starting` marker
// existed - which erased the evidence on the exact auto-respawn path that
// recovered the host. It now keeps the crash and downgrades severity to
// "recovered by restart".

const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => osHome.current || actual.tmpdir() };
});

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;

let workHome: string;

beforeEach(() => {
  workHome = mkdtempSync(join(tmpdir(), "traycer-doctor-crash-"));
  osHome.current = workHome;
  process.env.HOME = workHome;
  process.env.USERPROFILE = workHome;
  vi.resetModules();
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
  vi.doUnmock("../../host/pid-metadata");
  vi.doUnmock("../../service");
  vi.doUnmock("../../store/cli-lock");
});

interface Marker {
  readonly timestamp: string;
  readonly phase: string;
  readonly fields: Record<string, string>;
}

function stageQuietHost(markers: readonly Marker[]): void {
  const hostExecutablePath = join(workHome, "bin", "host");
  mkdirSync(join(workHome, "bin"), { recursive: true });
  writeFileSync(hostExecutablePath, "host-bin");
  vi.doMock("../../manifest/host-install", () => ({
    readHostInstallRecord: () => ({
      version: "1.4.0",
      environment: "production",
      executablePath: hostExecutablePath,
      installedAt: "2026-04-01T00:00:00Z",
      source: "registry",
      archiveSha256: "f".repeat(64),
      signatureKeyId: "registry:prod-2026",
    }),
  }));
  vi.doMock("../../host/bootstrap-log", () => ({
    readBootstrapMarkers: async () => markers,
  }));
  // No live host / no service - so unrecovered crash severity is "error".
  vi.doMock("../../host/pid-metadata", () => ({
    readHostPidMetadata: async () => null,
  }));
  vi.doMock("../../service", () => ({
    createServiceController: () => ({
      status: async () => ({
        state: "stopped",
        version: "1.4.0",
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
    }),
  }));
  vi.doMock("../../store/cli-lock", () => ({
    isProcessAlive: () => false,
  }));
}

describe("runDoctor RECENT_CRASH_MARKERS recovery", () => {
  it("downgrades a crash followed by a later starting marker to recovered warning", async () => {
    stageQuietHost([
      {
        timestamp: "2026-01-01T00:00:00.000Z",
        phase: "crashed",
        fields: {
          code: "3221226505",
          exitMeaning: "0xC0000409 STATUS_STACK_BUFFER_OVERRUN",
          report: "report.json",
        },
      },
      {
        timestamp: "2026-01-01T00:00:05.000Z",
        phase: "starting",
        fields: {},
      },
    ]);

    const { runDoctor } = await import("../engine");
    const result = await runDoctor({
      environment: "production",
      portConflictDeps: { runCommand: async () => null, platform: "darwin" },
    });

    const issue = result.issues.find((i) => i.code === "RECENT_CRASH_MARKERS");
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("warning");
    expect(issue?.title).toContain("recovered by restart");
    expect(issue?.details).toMatchObject({
      phase: "crashed",
      recovered: true,
    });
    expect(issue?.message).toContain("meaning=0xC0000409");
    expect(issue?.message).toContain("report=report.json");
  });

  it("keeps an unrecovered crash as error when no later start exists", async () => {
    stageQuietHost([
      {
        timestamp: "2026-01-01T00:00:00.000Z",
        phase: "crashed",
        fields: {
          code: "7",
        },
      },
    ]);

    const { runDoctor } = await import("../engine");
    const result = await runDoctor({
      environment: "production",
      portConflictDeps: { runCommand: async () => null, platform: "darwin" },
    });

    const issue = result.issues.find((i) => i.code === "RECENT_CRASH_MARKERS");
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("error");
    expect(issue?.title).toBe("Host crashed recently");
    expect(issue?.title).not.toContain("recovered");
    expect(issue?.details).toMatchObject({
      phase: "crashed",
      recovered: false,
    });
  });

  it("reports failed-to-spawn with recovered=true after a later starting marker", async () => {
    stageQuietHost([
      {
        timestamp: "2026-01-01T00:00:00.000Z",
        phase: "failed-to-spawn",
        fields: { error: "ENOENT" },
      },
      {
        timestamp: "2026-01-01T00:00:01.000Z",
        phase: "starting",
        fields: {},
      },
    ]);

    const { runDoctor } = await import("../engine");
    const result = await runDoctor({
      environment: "production",
      portConflictDeps: { runCommand: async () => null, platform: "darwin" },
    });

    const issue = result.issues.find((i) => i.code === "RECENT_CRASH_MARKERS");
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("warning");
    expect(issue?.title).toBe(
      "Host failed to spawn recently (recovered by restart)",
    );
    expect(issue?.details).toMatchObject({ recovered: true });
  });

  it("treats killed+SIGABRT as a crash (unrecovered → error)", async () => {
    stageQuietHost([
      {
        timestamp: "2026-01-01T00:00:00.000Z",
        phase: "killed",
        fields: {
          signal: "SIGABRT",
          exitMeaning:
            "SIGABRT abort (V8 fatal/OOM, assertion, or native abort)",
          report: "report.json",
        },
      },
    ]);

    const { runDoctor } = await import("../engine");
    const result = await runDoctor({
      environment: "production",
      portConflictDeps: { runCommand: async () => null, platform: "darwin" },
    });

    const issue = result.issues.find((i) => i.code === "RECENT_CRASH_MARKERS");
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("error");
    expect(issue?.title).toBe("Host crashed recently");
    expect(issue?.details).toMatchObject({
      phase: "killed",
      recovered: false,
    });
    expect(issue?.message).toContain("signal=SIGABRT");
  });

  it("treats killed+SIGABRT followed by starting as recovered crash", async () => {
    stageQuietHost([
      {
        timestamp: "2026-01-01T00:00:00.000Z",
        phase: "killed",
        fields: { signal: "SIGABRT" },
      },
      {
        timestamp: "2026-01-01T00:00:05.000Z",
        phase: "starting",
        fields: {},
      },
    ]);

    const { runDoctor } = await import("../engine");
    const result = await runDoctor({
      environment: "production",
      portConflictDeps: { runCommand: async () => null, platform: "darwin" },
    });

    const issue = result.issues.find((i) => i.code === "RECENT_CRASH_MARKERS");
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("warning");
    expect(issue?.title).toContain("recovered by restart");
    expect(issue?.details).toMatchObject({
      phase: "killed",
      recovered: true,
    });
  });

  it("does not treat killed+SIGTERM as a crash marker", async () => {
    stageQuietHost([
      {
        timestamp: "2026-01-01T00:00:00.000Z",
        phase: "killed",
        fields: { signal: "SIGTERM" },
      },
    ]);

    const { runDoctor } = await import("../engine");
    const result = await runDoctor({
      environment: "production",
      portConflictDeps: { runCommand: async () => null, platform: "darwin" },
    });

    const crash = result.issues.find((i) => i.code === "RECENT_CRASH_MARKERS");
    expect(crash).toBeUndefined();
  });
});
