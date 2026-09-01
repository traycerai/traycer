import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
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
  // No client exercised in this file - `submitReport` falls back to
  // `flush`'s own boolean, exactly as before the afterSendEvent mechanism.
  getClient: vi.fn(() => undefined),
}));

import * as Sentry from "@sentry/electron/main";
import { shell } from "electron";
import { DesktopSupportService } from "../support";

const EMPTY_REPORT_FORM: SupportSubmitReportRequest = {
  draftId: 1,
  type: "bug",
  intent: "",
  frequency: null,
  location: null,
  allowContact: false,
  includeDesktopLog: true,
  includeHostLog: true,
  includeBrowserDiagnostics: true,
  includeDiagnostics: true,
  images: [],
  overrideTitle: null,
  privateOutcome: "none",
};

// Frozen-evidence key is composed in the IPC layer (sender id + draftId);
// these tests exercise the service directly, so a fixed key stands in.
const KEY = "sender-1:1";

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
      identityEnrollmentFile: join(dir, "identity", "enrollment.json"),
      logFile: join(dir, "host.log"),
      installDir: join(dir, "install"),
      installRecordFile: join(dir, "install", "install.json"),
      stagedDir: join(dir, "staged"),
      stagedRecordFile: join(dir, "staged", "staged.json"),
      pendingLoginItemRevisionFile: join(
        dir,
        "pending-login-item-revision.json",
      ),
      substrateFile: join(dir, "substrate.json"),
      transitionJournalFile: join(dir, "transition.json"),
      browserTelemetryFile: join(dir, "browser-telemetry.jsonl"),
      browserTelemetryRotatedFile: join(dir, "browser-telemetry.jsonl.1"),
      browserTraceFile: join(dir, "browser-trace.jsonl"),
      browserTraceRotatedFile: join(dir, "browser-trace.jsonl.1"),
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

  it("tags a degraded layer0 record and carries the full record in a Sentry context, path-pseudonymized (ticket 09)", async () => {
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
        await service.freezeEvidence(KEY, null);
        await service.submitReport(EMPTY_REPORT_FORM, KEY);

        expect(Sentry.captureFeedback).toHaveBeenCalledTimes(1);
        const [feedback, hint] = vi.mocked(Sentry.captureFeedback).mock
          .calls[0];
        // The deep scrubber (ticket 09) runs on `contexts` right before this
        // call: the absolute path in `evidence` is pseudonymized (host.log
        // and stack-carried paths are the dominant leak vector this scrubber
        // exists for), while the rest of the record - status/attemptId/cause,
        // none of them path-shaped - survives untouched.
        expect(hint?.captureContext).toMatchObject({
          tags: expect.objectContaining({ layer0Status: "degraded" }),
          contexts: {
            layer0: {
              status: "degraded",
              attemptId: "sea-addon-degraded",
              cause: "addon-load-failed",
              evidence: "Cannot find module '<path-1>'",
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
      await service.freezeEvidence(KEY, null);
      await service.submitReport(EMPTY_REPORT_FORM, KEY);

      expect(Sentry.captureFeedback).toHaveBeenCalledTimes(1);
      const [feedback, hint] = vi.mocked(Sentry.captureFeedback).mock.calls[0];
      expect(hint?.captureContext).toMatchObject({
        tags: expect.objectContaining({ layer0Status: "absent" }),
      });
      expect(hint?.captureContext).not.toHaveProperty("contexts");
      expect(feedback.message).not.toContain("Layer 0:");
    });
  });

  /**
   * The structured `os-error` arm is the reason T1 stops flattening cause to
   * a string: syscall/code/fsType must arrive intact in `contexts.layer0`,
   * not as a pre-stringified blob that loses typed filtering later.
   */
  it("carries a structured os-error layer0 discriminant intact in Sentry contexts.layer0", async () => {
    const osErrorCause = {
      kind: "os-error" as const,
      syscall: "open",
      code: "EACCES",
      fsType: null,
    };
    await withPidMetadataFile(
      {
        pid: 25149,
        hostId: "36bee6d0-test",
        version: "0.0.0-dev",
        websocketUrl: "ws://127.0.0.1:63857/rpc",
        layer0: {
          status: "degraded",
          attemptId: "host-os-error",
          cause: osErrorCause,
          evidence: "kernel lifecycle lock acquisition was not determinable",
        },
      },
      async (hostLayout) => {
        const service = buildService(hostLayout);
        await service.freezeEvidence(KEY, null);
        await service.submitReport(EMPTY_REPORT_FORM, KEY);

        expect(Sentry.captureFeedback).toHaveBeenCalledTimes(1);
        const [feedback, hint] = vi.mocked(Sentry.captureFeedback).mock
          .calls[0];
        expect(hint?.captureContext).toMatchObject({
          tags: expect.objectContaining({ layer0Status: "degraded" }),
          contexts: {
            layer0: {
              status: "degraded",
              attemptId: "host-os-error",
              cause: osErrorCause,
              evidence:
                "kernel lifecycle lock acquisition was not determinable",
            },
          },
        });
        // Nested fields must still be objects on the wire, not a JSON string.
        const layer0Context = (
          hint?.captureContext as {
            contexts?: { layer0?: { cause?: unknown } };
          }
        )?.contexts?.layer0;
        expect(typeof layer0Context?.cause).toBe("object");
        expect(layer0Context?.cause).toEqual(osErrorCause);
        expect(feedback.message).toContain(
          `Layer 0: degraded (${JSON.stringify(osErrorCause)})`,
        );
      },
    );
  });

  it("tags an unrecognized newer-host layer0 and preserves the raw payload in Sentry context", async () => {
    const newerHostLayer0 = {
      status: "degraded",
      attemptId: "future-host-attempt",
      cause: "future-unknown-cause",
      evidence: "host emits a cause this desktop build does not list yet",
    };
    await withPidMetadataFile(
      {
        pid: 25149,
        hostId: "36bee6d0-test",
        version: "0.0.0-dev",
        websocketUrl: "ws://127.0.0.1:63857/rpc",
        layer0: newerHostLayer0,
      },
      async (hostLayout) => {
        const service = buildService(hostLayout);
        await service.freezeEvidence(KEY, null);
        await service.submitReport(EMPTY_REPORT_FORM, KEY);

        expect(Sentry.captureFeedback).toHaveBeenCalledTimes(1);
        const [feedback, hint] = vi.mocked(Sentry.captureFeedback).mock
          .calls[0];
        expect(hint?.captureContext).toMatchObject({
          tags: expect.objectContaining({ layer0Status: "unrecognized" }),
          contexts: {
            layer0: {
              status: "unrecognized",
              raw: JSON.stringify(newerHostLayer0),
            },
          },
        });
        expect(feedback.message).toContain(
          `Layer 0: unrecognized (${JSON.stringify(newerHostLayer0)})`,
        );
      },
    );
  });

  it("ships image attachments on captureFeedback and keeps them out of contexts (ticket 08)", async () => {
    const png = new Uint8Array(24);
    png[0] = 0x89;
    png[1] = 0x50;
    png[2] = 0x4e;
    png[3] = 0x47;
    await withPidMetadataFile(undefined, async (hostLayout) => {
      const service = buildService(hostLayout);
      await service.freezeEvidence(KEY, null);
      await service.submitReport(
        {
          ...EMPTY_REPORT_FORM,
          images: [
            {
              fileName: "layer0-context.png",
              mimeType: "image/png",
              bytes: png.buffer,
            },
          ],
        },
        KEY,
      );

      expect(Sentry.captureFeedback).toHaveBeenCalledTimes(1);
      const [, hint] = vi.mocked(Sentry.captureFeedback).mock.calls[0] as [
        unknown,
        {
          attachments?: ReadonlyArray<{
            filename: string;
            data: unknown;
            contentType?: string;
          }>;
          captureContext?: { contexts?: Record<string, unknown> };
        },
      ];
      const image = hint?.attachments?.find(
        (a) => a.filename === "layer0-context.png",
      );
      expect(image?.contentType).toBe("image/png");
      expect(image?.data).toBeInstanceOf(Uint8Array);
      // Images must never ride through the scrubbed contexts object.
      expect(hint?.captureContext?.contexts ?? {}).not.toHaveProperty("images");
    });
  });
});

/**
 * Ticket 03 / plan D3: the seek-based jsonl tail window, exercised through
 * the service's public surface (`freezeEvidence` + `readFrozenLogTail`)
 * rather than the private reader functions - what matters is what a
 * consent-panel "view" click or a submitted attachment actually contains.
 */
describe("DesktopSupportService browser diagnostics jsonl tail window (ticket 03)", () => {
  it("resolves an empty, non-truncated tail when neither browser file exists", async () => {
    await withPidMetadataFile(undefined, async (hostLayout) => {
      const service = buildService(hostLayout);
      await service.freezeEvidence(KEY, null);
      const result = await service.readFrozenLogTail(KEY, "browserTrace");
      expect(result.lines).toEqual([]);
      expect(result.truncated).toBe(false);
    });
  });

  it("concatenates the .1 rotation file before the live file, in that order", async () => {
    await withPidMetadataFile(undefined, async (hostLayout) => {
      await writeFile(
        hostLayout.browserTraceRotatedFile,
        '{"seq":1,"source":"rotated"}\n{"seq":2,"source":"rotated"}\n',
        "utf8",
      );
      await writeFile(
        hostLayout.browserTraceFile,
        '{"seq":3,"source":"live"}\n',
        "utf8",
      );
      const service = buildService(hostLayout);
      await service.freezeEvidence(KEY, null);
      const result = await service.readFrozenLogTail(KEY, "browserTrace");
      expect(result.truncated).toBe(false);
      expect(result.lines).toEqual([
        '{"seq":1,"source":"rotated"}',
        '{"seq":2,"source":"rotated"}',
        '{"seq":3,"source":"live"}',
      ]);
    });
  });

  it("windows a large combined trace to the trailing bytes and drops the partial head record", async () => {
    await withPidMetadataFile(undefined, async (hostLayout) => {
      const lineFor = (seq: number): string =>
        `{"seq":"${String(seq).padStart(6, "0")}","pad":"${"x".repeat(20)}"}\n`;
      // 40_000 fixed-width lines is comfortably over the 512_000-byte window
      // on its own, so the trailing window necessarily starts mid-file - and,
      // for most seeks, mid-record.
      const rotatedLines = Array.from({ length: 40_000 }, (_, i) => lineFor(i));
      await writeFile(
        hostLayout.browserTraceRotatedFile,
        rotatedLines.join(""),
        "utf8",
      );
      const liveLines = [lineFor(40_000), lineFor(40_001), lineFor(40_002)];
      await writeFile(hostLayout.browserTraceFile, liveLines.join(""), "utf8");

      const service = buildService(hostLayout);
      await service.freezeEvidence(KEY, null);
      const result = await service.readFrozenLogTail(KEY, "browserTrace");

      expect(result.truncated).toBe(true);
      // The live file is read last and is far smaller than the window, so
      // every one of its lines survives in full, in order.
      expect(result.lines.slice(-3)).toEqual([
        lineFor(40_000).trimEnd(),
        lineFor(40_001).trimEnd(),
        lineFor(40_002).trimEnd(),
      ]);
      // The earliest rotated lines are outside the trailing window.
      expect(result.lines).not.toContain(lineFor(0).trimEnd());
      // A byte window can begin mid-record; every surviving line must still
      // be independently valid JSON - proof the partial head record was
      // dropped, not shipped broken (correct for jsonl).
      for (const line of result.lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });
  });

  it("reads from the rotated file alone when the live file is missing", async () => {
    await withPidMetadataFile(undefined, async (hostLayout) => {
      await writeFile(
        hostLayout.browserTraceRotatedFile,
        '{"seq":1,"source":"rotated"}\n',
        "utf8",
      );
      const service = buildService(hostLayout);
      await service.freezeEvidence(KEY, null);
      const result = await service.readFrozenLogTail(KEY, "browserTrace");
      expect(result.truncated).toBe(false);
      expect(result.lines).toEqual(['{"seq":1,"source":"rotated"}']);
    });
  });

  it("reads from the live file alone when the rotated .1 file is missing", async () => {
    await withPidMetadataFile(undefined, async (hostLayout) => {
      await writeFile(
        hostLayout.browserTraceFile,
        '{"seq":1,"source":"live"}\n',
        "utf8",
      );
      const service = buildService(hostLayout);
      await service.freezeEvidence(KEY, null);
      const result = await service.readFrozenLogTail(KEY, "browserTrace");
      expect(result.truncated).toBe(false);
      expect(result.lines).toEqual(['{"seq":1,"source":"live"}']);
    });
  });

  it("inserts a newline between a torn rotated tail and the live file's first record", async () => {
    await withPidMetadataFile(undefined, async (hostLayout) => {
      // No trailing newline on the rotated file - a crash/kill mid-write can
      // leave the last flush torn like this. Without the fix the two records
      // fuse into one unparseable line.
      await writeFile(
        hostLayout.browserTraceRotatedFile,
        '{"seq":1,"source":"rotated"}',
        "utf8",
      );
      await writeFile(
        hostLayout.browserTraceFile,
        '{"seq":2,"source":"live"}\n',
        "utf8",
      );
      const service = buildService(hostLayout);
      await service.freezeEvidence(KEY, null);
      const result = await service.readFrozenLogTail(KEY, "browserTrace");
      expect(result.truncated).toBe(false);
      expect(result.lines).toEqual([
        '{"seq":1,"source":"rotated"}',
        '{"seq":2,"source":"live"}',
      ]);
    });
  });

  it("drops the sole line entirely when the window captures only a truncated head record", async () => {
    await withPidMetadataFile(undefined, async (hostLayout) => {
      // One record with no newline anywhere in the file, comfortably larger
      // than the 512_000-byte window - the captured window is exactly one
      // (partial) line. Unconditionally dropping the "head" record (ruling
      // 4) correctly yields empty output here rather than shipping one
      // truncated, unparseable line.
      const hugeLine = `{"seq":1,"pad":"${"x".repeat(700_000)}"}`;
      await writeFile(hostLayout.browserTraceFile, hugeLine, "utf8");

      const service = buildService(hostLayout);
      await service.freezeEvidence(KEY, null);
      const result = await service.readFrozenLogTail(KEY, "browserTrace");

      expect(result.truncated).toBe(true);
      expect(result.lines).toEqual([]);
    });
  });
});

/**
 * Ticket 03 / plan D3: absence of `browser-trace.jsonl` is the normal
 * production state, so the manifest must filter on existence (unlike
 * `desktop`/`host`, always listed) and neither `revealLog` nor `tailLog` may
 * ever fabricate a browser file the host did not write.
 */
describe("DesktopSupportService browser diagnostics existence handling (ticket 03)", () => {
  it("omits both browser entries from the snapshot manifest when neither file exists", async () => {
    await withPidMetadataFile(undefined, async (hostLayout) => {
      const service = buildService(hostLayout);
      const snapshot = await service.getSnapshot();
      const targets = snapshot.logs.map((entry) => entry.target);
      expect(targets).toEqual(["desktop", "host"]);
    });
  });

  it("lists only the browser file(s) that actually exist", async () => {
    await withPidMetadataFile(undefined, async (hostLayout) => {
      await writeFile(hostLayout.browserTelemetryFile, "{}\n", "utf8");
      const service = buildService(hostLayout);
      const snapshot = await service.getSnapshot();
      const targets = snapshot.logs.map((entry) => entry.target);
      expect(targets).toEqual(["desktop", "host", "browserTelemetry"]);
    });
  });

  it("lists both browser entries once both files exist", async () => {
    await withPidMetadataFile(undefined, async (hostLayout) => {
      await writeFile(hostLayout.browserTelemetryFile, "{}\n", "utf8");
      await writeFile(hostLayout.browserTraceFile, "{}\n", "utf8");
      const service = buildService(hostLayout);
      const snapshot = await service.getSnapshot();
      const targets = snapshot.logs.map((entry) => entry.target);
      expect(targets).toEqual([
        "desktop",
        "host",
        "browserTelemetry",
        "browserTrace",
      ]);
    });
  });

  it("never creates a missing browser file on reveal, and never asks the shell to show it", async () => {
    await withPidMetadataFile(undefined, async (hostLayout) => {
      const service = buildService(hostLayout);
      await service.revealLog("browserTrace");
      await expect(stat(hostLayout.browserTraceFile)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(shell.showItemInFolder).not.toHaveBeenCalled();
    });
  });

  it("reveals an existing browser file normally", async () => {
    await withPidMetadataFile(undefined, async (hostLayout) => {
      await writeFile(hostLayout.browserTraceFile, "{}\n", "utf8");
      const service = buildService(hostLayout);
      const result = await service.revealLog("browserTrace");
      expect(result.path).toBe(hostLayout.browserTraceFile);
      expect(shell.showItemInFolder).toHaveBeenCalledWith(
        hostLayout.browserTraceFile,
      );
    });
  });

  it("never creates a missing browser file on tailLog, and returns an empty tail", async () => {
    await withPidMetadataFile(undefined, async (hostLayout) => {
      const service = buildService(hostLayout);
      const result = await service.tailLog({
        target: "browserTrace",
        tailLines: 100,
      });
      expect(result.lines).toEqual([]);
      await expect(stat(hostLayout.browserTraceFile)).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });
});
