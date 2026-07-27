import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostFsLayout } from "../../host/host-paths";
import type {
  DesktopAuthSessionSnapshot,
  SupportSubmitReportRequest,
} from "../../../ipc-contracts/window-types";

vi.mock("electron", () => ({
  app: {
    getVersion: (): string => "0.0.0-test",
    getPath: (_key: string): string => "/tmp/traycer-desktop-support-test",
  },
  shell: {
    showItemInFolder: vi.fn(),
  },
}));

vi.mock("electron-log", () => ({
  default: {
    transports: { file: { level: "info" }, console: { level: "info" } },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("@sentry/electron/main", () => ({
  isInitialized: vi.fn((): boolean => false),
  captureFeedback: vi.fn((): string => "sentry-event-id"),
  flush: vi.fn(async (): Promise<boolean> => true),
}));

import * as Sentry from "@sentry/electron/main";
import { DesktopSupportService } from "../support";

const EMPTY_REPORT_FORM: SupportSubmitReportRequest = {
  title: "Something broke",
  whatHappened: "",
  stepsToReproduce: "",
  expectedBehavior: "",
  actualBehavior: "",
};

/**
 * The `layer0` bytes under test are copied from the real published record
 * (a packaged build's `pid.json`, `evidence` included) rather than invented
 * here - a decoder tested against inputs the host cannot produce proves the
 * assertion, not the contract.
 */
async function withPidMetadataFile(
  content: unknown,
  run: (layout: HostFsLayout) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "support-layer0-test-"));
  try {
    const pidMetadataFile = join(dir, "pid.json");
    if (content !== undefined) {
      await writeFile(pidMetadataFile, JSON.stringify(content), "utf8");
    }
    await run({
      rootDir: dir,
      pidMetadataFile,
      logFile: join(dir, "host.log"),
      installDir: join(dir, "install"),
      installRecordFile: join(dir, "install", "install.json"),
      stagedDir: join(dir, "staged"),
      stagedRecordFile: join(dir, "staged", "staged.json"),
      pendingLoginItemRevisionFile: join(
        dir,
        "pending-login-item-revision.json",
      ),
      environment: "production",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function buildService(hostLayout: HostFsLayout): DesktopSupportService {
  const authSession: DesktopAuthSessionSnapshot = {
    status: "signed-out",
    token: null,
    profile: null,
  };
  return new DesktopSupportService({
    appName: "Traycer",
    host: { getSnapshot: () => null },
    authSession: { get: () => authSession },
    hostLayout,
  });
}

describe("DesktopSupportService.getSnapshot layer0", () => {
  it("surfaces a degraded layer0 record with cause and evidence intact", async () => {
    await withPidMetadataFile(
      {
        pid: 25149,
        hostId: "36bee6d0-test",
        version: "0.0.0-dev",
        websocketUrl: "ws://127.0.0.1:63857/rpc",
        layer0: {
          status: "degraded",
          attemptId: "sea-addon-degraded",
          cause: "addon-load-failed",
          evidence:
            "Cannot find module '/Applications/Traycer.app/Contents/Resources/lifecycle_lock.node'",
        },
      },
      async (hostLayout) => {
        const service = buildService(hostLayout);
        const snapshot = await service.getSnapshot();
        expect(snapshot.host.layer0).toEqual({
          status: "degraded",
          attemptId: "sea-addon-degraded",
          cause: "addon-load-failed",
          evidence:
            "Cannot find module '/Applications/Traycer.app/Contents/Resources/lifecycle_lock.node'",
        });
      },
    );
  });

  it("reports layer0 as null, not fabricated as healthy, when pid.json predates the field", async () => {
    await withPidMetadataFile(
      {
        pid: 25149,
        hostId: "36bee6d0-test",
        version: "0.0.0-dev",
        websocketUrl: "ws://127.0.0.1:63857/rpc",
      },
      async (hostLayout) => {
        const service = buildService(hostLayout);
        const snapshot = await service.getSnapshot();
        expect(snapshot.host.layer0).toBeNull();
      },
    );
  });

  it("reports layer0 as null, not fabricated as healthy, when no host is running", async () => {
    await withPidMetadataFile(undefined, async (hostLayout) => {
      const service = buildService(hostLayout);
      const snapshot = await service.getSnapshot();
      expect(snapshot.host.layer0).toBeNull();
    });
  });
});

/**
 * The snapshot alone isn't the point - a support engineer reads the Sentry
 * event, not the IPC payload. These pin the actual `Sentry.captureFeedback`
 * call: the bounded `layer0Status` tag (filterable, never free text) and the
 * full record riding in `contexts.layer0` (unbounded, not indexed) - the two
 * channels a free-text cause/evidence pair must never be split across.
 */
describe("DesktopSupportService.submitReport layer0 routing", () => {
  beforeEach(() => {
    vi.mocked(Sentry.isInitialized).mockReturnValue(true);
    vi.mocked(Sentry.captureFeedback).mockClear();
  });

  it("tags a degraded layer0 record and carries the full record in a Sentry context", async () => {
    await withPidMetadataFile(
      {
        pid: 25149,
        hostId: "36bee6d0-test",
        version: "0.0.0-dev",
        websocketUrl: "ws://127.0.0.1:63857/rpc",
        layer0: {
          status: "degraded",
          attemptId: "sea-addon-degraded",
          cause: "addon-load-failed",
          evidence:
            "Cannot find module '/Applications/Traycer.app/Contents/Resources/lifecycle_lock.node'",
        },
      },
      async (hostLayout) => {
        const service = buildService(hostLayout);
        await service.submitReport(EMPTY_REPORT_FORM);

        expect(Sentry.captureFeedback).toHaveBeenCalledTimes(1);
        const [feedback, hint] = vi.mocked(Sentry.captureFeedback).mock
          .calls[0];
        expect(hint?.captureContext).toMatchObject({
          tags: expect.objectContaining({ layer0Status: "degraded" }),
          contexts: {
            layer0: {
              status: "degraded",
              attemptId: "sea-addon-degraded",
              cause: "addon-load-failed",
              evidence:
                "Cannot find module '/Applications/Traycer.app/Contents/Resources/lifecycle_lock.node'",
            },
          },
        });
        expect(feedback.message).toContain(
          "Layer 0: degraded (addon-load-failed)",
        );
      },
    );
  });

  it("tags an absent layer0 record without fabricating a structured context", async () => {
    await withPidMetadataFile(undefined, async (hostLayout) => {
      const service = buildService(hostLayout);
      await service.submitReport(EMPTY_REPORT_FORM);

      expect(Sentry.captureFeedback).toHaveBeenCalledTimes(1);
      const [feedback, hint] = vi.mocked(Sentry.captureFeedback).mock.calls[0];
      expect(hint?.captureContext).toMatchObject({
        tags: expect.objectContaining({ layer0Status: "absent" }),
      });
      expect(hint?.captureContext).not.toHaveProperty("contexts");
      expect(feedback.message).not.toContain("Layer 0:");
    });
  });
});
