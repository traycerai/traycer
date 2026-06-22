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
    const [desktopLogContent, hostLogContent] = await Promise.all([
      readLogTail(resolveDesktopLogPath(), 500),
      readLogTail(this.hostLayout.logFile, 500),
    ]);

    // No DSN baked in (dev/staging without sentry) - keep the user-facing
    // flow working by returning the locally generated id; the GitHub issue
    // will still open with environment + report id in the body.
    if (!Sentry.isInitialized()) {
      return { reportId };
    }

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

    try {
      await Sentry.flush(2000);
    } catch (err) {
      log.error("[support] sentry flush failed", { reportId, err });
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

async function readLogTail(path: string, lines: number): Promise<string> {
  const content = await readFile(path, "utf-8").catch(() => "");
  const all = content.split("\n");
  return all.slice(-lines).join("\n");
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
