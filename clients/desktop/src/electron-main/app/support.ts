import { app, shell } from "electron";
import { randomUUID } from "node:crypto";
import { open, mkdir, readFile } from "node:fs/promises";
import { arch, platform } from "node:process";
import { dirname } from "node:path";
import * as Sentry from "@sentry/electron/main";
import type { HostFsLayout } from "../host/host-paths";
import { log, resolveDesktopLogPath } from "./logger";
import type { DesktopLocalHostSnapshot } from "../../ipc-contracts/host-types";
import type {
  DesktopAuthSessionSnapshot,
  SupportLogTarget,
  SupportLogTailResult,
  SupportRevealLogResult,
  SupportSnapshot,
  SupportSubmitReportRequest,
  SupportSubmitReportResult,
} from "../../ipc-contracts/window-types";
import { buildSupportLinks, TRAYCER_SUPPORT_EMAIL } from "./support-links";

const LOG_TAIL_LINES = 500;
// Per attachment. Two logs stay well inside Sentry's envelope limits, and the
// transport gzips before sending, so this is ~50 KB on the wire in practice.
const LOG_ATTACHMENT_MAX_BYTES = 512_000;
// The user is watching a spinner, but losing the report costs far more than
// waiting: 2s was not enough to upload two log attachments on a slow link.
const SENTRY_FLUSH_TIMEOUT_MS = 10_000;

export interface SupportHostSnapshotProvider {
  getSnapshot(): DesktopLocalHostSnapshot | null;
}

export interface SupportAuthSessionProvider {
  get(): DesktopAuthSessionSnapshot;
}

export class DesktopSupportService {
  private readonly appName: string;
  private readonly host: SupportHostSnapshotProvider;
  private readonly authSession: SupportAuthSessionProvider;
  private readonly hostLayout: HostFsLayout;

  constructor(options: {
    readonly appName: string;
    readonly host: SupportHostSnapshotProvider;
    readonly authSession: SupportAuthSessionProvider;
    // Environment-scoped layout matching the host supervisor's writes.
    // Production passes the prod layout; `make dev-desktop` passes the
    // dev layout so Support → Reveal Log opens the dev host's log.
    readonly hostLayout: HostFsLayout;
  }) {
    this.appName = options.appName;
    this.host = options.host;
    this.authSession = options.authSession;
    this.hostLayout = options.hostLayout;
  }

  getSnapshot(): SupportSnapshot {
    const host = this.host.getSnapshot();
    const authSession = this.authSession.get();
    return {
      appName: this.appName,
      appVersion: app.getVersion(),
      platform,
      arch,
      user: {
        status: authSession.status,
        userName: authSession.profile?.userName ?? null,
        email: authSession.profile?.email ?? null,
      },
      versions: {
        electron: process.versions.electron ?? "",
        chrome: process.versions.chrome ?? "",
        node: process.versions.node,
      },
      host: {
        status: host === null ? "starting" : "ready",
        version: host?.version ?? null,
        pid: host?.pid ?? null,
        hostId: host?.hostId ?? null,
      },
      logs: [
        {
          target: "desktop",
          label: "Desktop Log",
          path: resolveDesktopLogPath(),
        },
        {
          target: "host",
          label: "Host Log",
          path: this.hostLayout.logFile,
        },
      ],
      links: buildSupportLinks(),
      supportEmail: TRAYCER_SUPPORT_EMAIL,
    };
  }

  async revealLog(target: SupportLogTarget): Promise<SupportRevealLogResult> {
    const path = this.resolveSupportLogPath(target);
    await ensureLogFile(path);
    shell.showItemInFolder(path);
    return { target, path };
  }

  async submitReport(
    form: SupportSubmitReportRequest,
  ): Promise<SupportSubmitReportResult> {
    const reportId = generateReportId();
    const snapshot = this.getSnapshot();

    // No DSN baked in (dev/staging without sentry). Nothing is uploaded, so
    // there is no report to hand back - returning the locally generated id
    // here is what put ids into GitHub issues that exist nowhere in Sentry.
    if (!Sentry.isInitialized()) {
      log.warn("[support] sentry unavailable, report not uploaded", {
        reportId,
      });
      return { reportId: null };
    }

    const [desktopLogContent, hostLogContent] = await Promise.all([
      readLogTail(
        resolveDesktopLogPath(),
        LOG_TAIL_LINES,
        LOG_ATTACHMENT_MAX_BYTES,
      ),
      readLogTail(
        this.hostLayout.logFile,
        LOG_TAIL_LINES,
        LOG_ATTACHMENT_MAX_BYTES,
      ),
    ]);

    const message = [
      `Title: ${form.title}`,
      form.whatHappened && `What happened:\n${form.whatHappened}`,
      form.stepsToReproduce && `Steps to reproduce:\n${form.stepsToReproduce}`,
      form.expectedBehavior && `Expected:\n${form.expectedBehavior}`,
      form.actualBehavior && `Actual:\n${form.actualBehavior}`,
      `Report ID: ${reportId}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    const userEmail = snapshot.user.email;
    Sentry.captureFeedback(
      {
        name: userEmail ?? "anonymous",
        email: userEmail ?? undefined,
        message,
      },
      {
        captureContext: {
          tags: {
            reportId,
            appVersion: snapshot.appVersion,
            platform: `${snapshot.platform}/${snapshot.arch}`,
            hostVersion: snapshot.host.version ?? "unknown",
            electronVersion: snapshot.versions.electron ?? "unknown",
          },
        },
        attachments: [
          ...(desktopLogContent
            ? [{ filename: "desktop.log", data: desktopLogContent }]
            : []),
          ...(hostLogContent
            ? [{ filename: "host.log", data: hostLogContent }]
            : []),
        ],
      },
    );

    // `flush` resolves false when the queue did not drain inside the timeout.
    // The result used to be discarded, which made a timed-out upload
    // indistinguishable from a delivered one - the report id still reached the
    // GitHub issue and triage then hunted for a report that never arrived.
    const flushed = await Sentry.flush(SENTRY_FLUSH_TIMEOUT_MS).catch(
      (err: unknown) => {
        log.error("[support] sentry flush failed", { reportId, err });
        return false;
      },
    );
    if (!flushed) {
      log.error("[support] report upload did not complete", { reportId });
      return { reportId: null };
    }
    return { reportId };
  }

  async tailLog(input: {
    readonly target: SupportLogTarget;
    readonly tailLines: number;
  }): Promise<SupportLogTailResult> {
    const path = this.resolveSupportLogPath(input.target);
    await ensureLogFile(path);
    const content = await readFile(path, "utf8");
    const lines = splitLogLines(content);
    return {
      target: input.target,
      path,
      lines: lines.slice(-input.tailLines),
      truncated: lines.length > input.tailLines,
    };
  }

  private resolveSupportLogPath(target: SupportLogTarget): string {
    if (target === "desktop") {
      return resolveDesktopLogPath();
    }
    return this.hostLayout.logFile;
  }
}

async function ensureLogFile(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "a");
  await handle.close();
}

async function readLogTail(
  path: string,
  lines: number,
  maxBytes: number,
): Promise<string> {
  const content = await readFile(path, "utf-8").catch(() => "");
  const tail = content.split("\n").slice(-lines).join("\n");
  return truncateToTrailingBytes(tail, maxBytes);
}

// A line count is not a size bound: one host log line can carry a multi-KB
// JSON payload, so 500 lines can run to megabytes. Sentry rejects oversized
// envelopes, and that rejection surfaces as a delivered event whose attachment
// silently vanished - exactly the failure mode this file is fixing. Keep the
// trailing bytes; the tail is where the failure being reported lives.
function truncateToTrailingBytes(text: string, maxBytes: number): string {
  const encoded = Buffer.from(text, "utf8");
  if (encoded.byteLength <= maxBytes) return text;
  const kept = encoded.subarray(-maxBytes).toString("utf8");
  // The byte cut can land mid-codepoint or mid-line; drop the partial head.
  const firstNewline = kept.indexOf("\n");
  return firstNewline === -1 ? kept : kept.slice(firstNewline + 1);
}

function generateReportId(): string {
  return `rpt_${randomUUID().replace(/-/g, "")}`;
}

function splitLogLines(content: string): readonly string[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") {
    return lines.slice(0, -1);
  }
  return lines;
}
