import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Wiring pin: `probeMacosWedgedJob` existing is not the same thing as
// runDoctor consulting it. This mocks the probe module and asserts a
// wedged verdict actually reaches the issue list. darwin-only because the
// engine gates the probe behind the platform check - the same reason this
// pin matters: a gate nobody exercises is how wiring silently dies.

const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => osHome.current || actual.tmpdir() };
});

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;

let workHome: string;

beforeEach(() => {
  workHome = mkdtempSync(join(tmpdir(), "traycer-doctor-wedge-test-"));
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
  vi.doUnmock("../launchd-wedge");
  vi.doUnmock("../../manifest/host-install");
  vi.doUnmock("../../host/bootstrap-log");
  vi.doUnmock("../../host/pid-metadata");
  vi.doUnmock("../../service");
});

describe.runIf(process.platform === "darwin")(
  "runDoctor launchd wedge wiring",
  () => {
    it("surfaces the wedge probe's issue in the doctor result", async () => {
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
        readBootstrapMarkers: async () => [],
      }));
      vi.doMock("../../host/pid-metadata", () => ({
        readHostPidMetadata: async () => null,
      }));
      vi.doMock("../../service", () => ({
        createServiceController: () => ({
          status: async () => ({
            state: "externally-managed",
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
      const probeCalls: unknown[] = [];
      vi.doMock("../launchd-wedge", () => ({
        createRealLaunchdPrintRunner: () => async () => {
          throw new Error("real runner must not be invoked in this test");
        },
        probeMacosWedgedJob: async (input: unknown) => {
          probeCalls.push(input);
          return {
            code: "SERVICE_JOB_WEDGED",
            severity: "error",
            title: "Host launchd job is loaded but wedged",
            message: "stubbed wedge issue",
            fixAction: null,
            terminalCommand: "traycer host service uninstall",
            details: { labelId: "ai.traycer.host.production.agent" },
          };
        },
      }));

      const { runDoctor } = await import("../engine");
      const result = await runDoctor({
        environment: "production",
        portConflictDeps: null,
      });

      const issue = result.issues.find((i) => i.code === "SERVICE_JOB_WEDGED");
      expect(issue).toBeDefined();
      expect(issue?.severity).toBe("error");
      // The engine passed its own label pair to the probe.
      expect(probeCalls).toHaveLength(1);
      expect(probeCalls[0]).toMatchObject({
        labelId: "ai.traycer.host.production",
        agentLabelId: "ai.traycer.host.production.agent",
        hasPidMetadata: false,
      });
    });
  },
);
