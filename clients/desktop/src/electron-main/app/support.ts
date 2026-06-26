import { app, shell } from "electron";
import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { open, mkdir, readFile, stat } from "node:fs/promises";
import { arch, platform } from "node:process";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import * as Sentry from "@sentry/electron/main";
import {
  DIAGNOSTICS_REDACTION_POLICY_VERSION,
  placeholderDiagnosticsStatus,
  readDiagnosticsRawSync,
  redactDiagnosticsLogTail,
  resolveDiagnosticsEffective,
  type DiagnosticsRawConfig,
  type DiagnosticsStatus,
} from "@traycer/protocol/config";
import type { HostFsLayout } from "../host/host-paths";
import { log, resolveDesktopLogPath } from "./logger";
import type { DesktopLocalHostSnapshot } from "../../ipc-contracts/host-types";
import type {
  DesktopAuthSessionSnapshot,
  SupportDiagnosticsSnapshot,
  SupportLogTarget,
  SupportLogTailResult,
  SupportRevealLogResult,
  SupportSnapshot,
  SupportSubmitReportRequest,
  SupportSubmitReportResult,
} from "../../ipc-contracts/window-types";
import { buildSupportLinks, TRAYCER_SUPPORT_EMAIL } from "./support-links";
import { runTraycerCliJson } from "../cli/traycer-cli";

const SUPPORT_LOG_TAIL_BYTES = 5 * 1024 * 1024;
const SUPPORT_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export interface SupportHostSnapshotProvider {
  getSnapshot(): DesktopLocalHostSnapshot | null;
}

export interface SupportAuthSessionProvider {
  get(): DesktopAuthSessionSnapshot;
}

interface LocalDiagnosticsSnapshotArgs {
  readonly host: DesktopLocalHostSnapshot | null;
  readonly hostEnvironment: string;
  readonly hostLayout: HostFsLayout;
}

interface SupportLogAttachment {
  readonly manifest: SupportLogAttachmentManifest;
  readonly content: string | null;
}

type SupportAttachmentTarget = SupportLogTarget | "diagnostics-export";

interface DiagnosticsExportResult {
  readonly bundlePath: string;
  readonly manifest: unknown;
}

interface SupportLogAttachmentManifest {
  readonly target: SupportAttachmentTarget;
  readonly path: string;
  readonly status: "included" | "missing" | "unreadable" | "omitted";
  readonly originalBytes: number | null;
  readonly includedBytes: number;
  readonly truncated: boolean;
  readonly redacted: boolean;
  readonly reason: string | null;
}

interface SupportReportManifestArgs {
  readonly reportId: string;
  readonly snapshot: SupportSnapshot;
  readonly diagnosticsSnapshot: SanitizedSupportDiagnosticsSnapshot;
  readonly files: readonly SupportLogAttachmentManifest[];
}

interface SanitizedSupportDiagnosticsSnapshot {
  readonly cliVersion: string | null;
  readonly raw: {
    readonly readStatus: DiagnosticsRawConfig["readStatus"];
    readonly path: string;
    readonly mtimeMs: number | null;
  };
  readonly effective: {
    readonly general: SanitizedDiagnosticsEffectiveScope;
    readonly host: SanitizedDiagnosticsEffectiveScope;
    readonly rawHostSetting: SupportDiagnosticsSnapshot["effective"]["rawHostSetting"];
  };
  readonly hostStatus: DiagnosticsStatus;
}

interface SanitizedDiagnosticsEffectiveScope {
  readonly level: string;
  readonly source: string;
  readonly expiresAt: string | null;
}

export class DesktopSupportService {
  private readonly appName: string;
  private readonly host: SupportHostSnapshotProvider;
  private readonly authSession: SupportAuthSessionProvider;
  private readonly hostLayout: HostFsLayout;
  private readonly hostEnvironment: string;

  constructor(options: {
    readonly appName: string;
    readonly host: SupportHostSnapshotProvider;
    readonly authSession: SupportAuthSessionProvider;
    // Environment-scoped layout matching the host supervisor's writes.
    // Production passes the prod layout; `make dev-desktop` passes the
    // dev layout so Support → Reveal Log opens the dev host's log.
    readonly hostLayout: HostFsLayout;
    readonly hostEnvironment: string;
  }) {
    this.appName = options.appName;
    this.host = options.host;
    this.authSession = options.authSession;
    this.hostLayout = options.hostLayout;
    this.hostEnvironment = options.hostEnvironment;
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
      diagnostics: buildLocalDiagnosticsSnapshot({
        host,
        hostEnvironment: this.hostEnvironment,
        hostLayout: this.hostLayout,
      }),
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
    const diagnosticsSnapshot = await readDiagnosticsSnapshotForReport(
      snapshot.diagnostics,
    );
    const hostLogPath = resolveTrustedHostLogPath(
      diagnosticsSnapshot.hostStatus.logPath,
      this.hostLayout,
    );
    const sanitizedDiagnosticsSnapshot = sanitizeDiagnosticsSnapshot({
      diagnosticsSnapshot,
      hostLogPath,
    });
    const [desktopLog, hostLog, diagnosticsExport] = await Promise.all([
      readSupportLogAttachment("desktop", resolveDesktopLogPath()),
      readSupportLogAttachment("host", hostLogPath),
      readDiagnosticsExportAttachment(),
    ]);
    const cappedAttachments = capSupportAttachments({
      diagnosticsExport,
      desktopLog,
      hostLog,
    });
    const manifest = buildReportManifest({
      reportId,
      snapshot,
      diagnosticsSnapshot: sanitizedDiagnosticsSnapshot,
      files: [
        cappedAttachments.diagnosticsExport.manifest,
        cappedAttachments.desktopLog.manifest,
        cappedAttachments.hostLog.manifest,
      ],
    });

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
          { filename: "diagnostics-manifest.json", data: manifest },
          {
            filename: "diagnostics-config.json",
            data: JSON.stringify(sanitizedDiagnosticsSnapshot, null, 2),
          },
          ...(cappedAttachments.diagnosticsExport.content !== null
            ? [
                {
                  filename: "diagnostics-export.json",
                  data: cappedAttachments.diagnosticsExport.content,
                },
              ]
            : []),
          ...(cappedAttachments.desktopLog.content !== null
            ? [
                {
                  filename: "desktop.log",
                  data: cappedAttachments.desktopLog.content,
                },
              ]
            : []),
          ...(cappedAttachments.hostLog.content !== null
            ? [
                {
                  filename: "host.log",
                  data: cappedAttachments.hostLog.content,
                },
              ]
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

function buildLocalDiagnosticsSnapshot(
  args: LocalDiagnosticsSnapshotArgs,
): SupportDiagnosticsSnapshot {
  const raw = readDiagnosticsRawSync();
  const effective = resolveDiagnosticsEffective(raw, new Date());
  return {
    raw,
    effective,
    hostStatus: buildUnconfirmedDiagnosticsStatus({
      raw,
      activeSlot: args.hostEnvironment,
      hostVersion: args.host?.version ?? null,
      logPath: args.hostLayout.logFile,
    }),
    cliVersion: null,
  };
}

async function readDiagnosticsSnapshotForReport(
  fallback: SupportDiagnosticsSnapshot | null,
): Promise<SupportDiagnosticsSnapshot> {
  try {
    return await runTraycerCliJson<SupportDiagnosticsSnapshot>([
      "config",
      "diagnostics",
      "get",
    ]);
  } catch (err) {
    log.warn("[support] diagnostics config snapshot fallback", { err });
    if (fallback !== null) return fallback;
    const raw = readDiagnosticsRawSync();
    return {
      raw,
      effective: resolveDiagnosticsEffective(raw, new Date()),
      hostStatus: buildUnconfirmedDiagnosticsStatus({
        raw,
        activeSlot: "unknown",
        hostVersion: null,
        logPath: null,
      }),
      cliVersion: null,
    };
  }
}

function buildUnconfirmedDiagnosticsStatus(args: {
  readonly raw: DiagnosticsRawConfig;
  readonly activeSlot: string;
  readonly hostVersion: string | null;
  readonly logPath: string | null;
}): DiagnosticsStatus {
  return placeholderDiagnosticsStatus({
    supported: false,
    source: "unreachable",
    readStatus: args.raw.readStatus,
    configPath: args.raw.path,
    configMtimeMs: args.raw.mtimeMs,
    hostVersion: args.hostVersion,
    activeSlot: args.activeSlot,
    logPath: args.logPath,
  });
}

function resolveTrustedHostLogPath(
  reportedPath: string | null,
  hostLayout: HostFsLayout,
): string {
  if (reportedPath === null) return hostLayout.logFile;

  const rootPath = resolve(hostLayout.rootDir);
  const candidatePath = resolve(reportedPath);
  const relativePath = relative(rootPath, candidatePath);
  const insideRoot =
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath));

  return insideRoot ? candidatePath : hostLayout.logFile;
}

function sanitizeDiagnosticsSnapshot(args: {
  readonly diagnosticsSnapshot: SupportDiagnosticsSnapshot;
  readonly hostLogPath: string;
}): SanitizedSupportDiagnosticsSnapshot {
  const { diagnosticsSnapshot } = args;
  return {
    cliVersion: diagnosticsSnapshot.cliVersion,
    raw: {
      readStatus: diagnosticsSnapshot.raw.readStatus,
      path: diagnosticsSnapshot.raw.path,
      mtimeMs: diagnosticsSnapshot.raw.mtimeMs,
    },
    effective: {
      general: sanitizeDiagnosticsEffectiveScope(
        diagnosticsSnapshot.effective.general,
      ),
      host: sanitizeDiagnosticsEffectiveScope(
        diagnosticsSnapshot.effective.host,
      ),
      rawHostSetting: diagnosticsSnapshot.effective.rawHostSetting,
    },
    hostStatus: {
      ...diagnosticsSnapshot.hostStatus,
      logPath: args.hostLogPath,
    },
  };
}

function sanitizeDiagnosticsEffectiveScope(
  scope: SupportDiagnosticsSnapshot["effective"]["general"],
): SanitizedDiagnosticsEffectiveScope {
  return {
    level: scope.level,
    source: scope.source,
    expiresAt: scope.expiresAt,
  };
}

async function readSupportLogAttachment(
  target: SupportAttachmentTarget,
  path: string,
): Promise<SupportLogAttachment> {
  let fileStat: Stats;
  try {
    fileStat = await stat(path);
  } catch (err) {
    return {
      manifest: unavailableLogManifest(
        target,
        path,
        unavailableStatus(err),
        err,
      ),
      content: null,
    };
  }

  if (!fileStat.isFile()) {
    return {
      manifest: unavailableLogManifest(
        target,
        path,
        "unreadable",
        "not-a-file",
      ),
      content: null,
    };
  }

  const bytesToRead = Math.min(fileStat.size, SUPPORT_LOG_TAIL_BYTES);
  const start = Math.max(fileStat.size - bytesToRead, 0);
  let raw: string;
  try {
    raw = await readFileRange(path, start, bytesToRead);
  } catch (err) {
    return {
      manifest: unavailableLogManifest(target, path, "unreadable", err),
      content: null,
    };
  }

  const truncated = fileStat.size > bytesToRead;
  const marker = truncated
    ? `[truncated: showing last ${bytesToRead} of ${fileStat.size} bytes]\n`
    : "";
  // Drop the partial first line of a truncated tail before redacting so a
  // header split across the byte-window boundary (e.g. `Authorization: Basic …`)
  // can't slip past the line-anchored header redaction.
  const content = `${marker}${redactDiagnosticsLogTail(raw, truncated)}`;
  return {
    manifest: {
      target,
      path,
      status: "included",
      originalBytes: fileStat.size,
      includedBytes: Buffer.byteLength(content, "utf8"),
      truncated,
      redacted: true,
      reason: null,
    },
    content,
  };
}

async function readDiagnosticsExportAttachment(): Promise<SupportLogAttachment> {
  try {
    const result = await runTraycerCliJson<DiagnosticsExportResult>([
      "diagnostics",
      "export",
    ]);
    const content = await readFile(result.bundlePath, "utf8");
    return {
      manifest: {
        target: "diagnostics-export",
        path: result.bundlePath,
        status: "included",
        originalBytes: Buffer.byteLength(content, "utf8"),
        includedBytes: Buffer.byteLength(content, "utf8"),
        truncated: false,
        redacted: true,
        reason: null,
      },
      content,
    };
  } catch (err) {
    log.warn("[support] diagnostics export unavailable", { err });
    return {
      manifest: unavailableLogManifest(
        "diagnostics-export",
        "",
        "unreadable",
        err,
      ),
      content: null,
    };
  }
}

async function readFileRange(
  path: string,
  start: number,
  length: number,
): Promise<string> {
  if (length === 0) return "";
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const result = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, result.bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function capSupportAttachments(args: {
  readonly diagnosticsExport: SupportLogAttachment;
  readonly desktopLog: SupportLogAttachment;
  readonly hostLog: SupportLogAttachment;
}): {
  readonly diagnosticsExport: SupportLogAttachment;
  readonly desktopLog: SupportLogAttachment;
  readonly hostLog: SupportLogAttachment;
} {
  // The standalone desktop + host logs are what a triager opens first, and the
  // diagnostics-export bundle already embeds tails of them, so grant the raw
  // logs the budget first and let the (redundant) export bundle take the
  // remainder rather than evicting the raw logs wholesale.
  const desktopLog = fitSupportAttachment(
    args.desktopLog,
    SUPPORT_TOTAL_ATTACHMENT_BYTES,
  );
  const remainingAfterDesktop =
    SUPPORT_TOTAL_ATTACHMENT_BYTES - attachmentBytes(desktopLog);
  const hostLog = fitSupportAttachment(args.hostLog, remainingAfterDesktop);
  const remainingAfterHost = remainingAfterDesktop - attachmentBytes(hostLog);
  return {
    diagnosticsExport: fitSupportAttachment(
      args.diagnosticsExport,
      remainingAfterHost,
    ),
    desktopLog,
    hostLog,
  };
}

function fitSupportAttachment(
  attachment: SupportLogAttachment,
  remainingBytes: number,
): SupportLogAttachment {
  if (attachment.content === null) return attachment;
  const bytes = Buffer.byteLength(attachment.content, "utf8");
  if (bytes <= remainingBytes) return attachment;
  return {
    manifest: {
      ...attachment.manifest,
      status: "omitted",
      includedBytes: 0,
      truncated: false,
      redacted: false,
      reason: "support-attachment-size-limit",
    },
    content: null,
  };
}

function attachmentBytes(attachment: SupportLogAttachment): number {
  return attachment.content === null
    ? 0
    : Buffer.byteLength(attachment.content, "utf8");
}

function unavailableLogManifest(
  target: SupportAttachmentTarget,
  path: string,
  status: "missing" | "unreadable",
  reason: unknown,
): SupportLogAttachmentManifest {
  return {
    target,
    path,
    status,
    originalBytes: null,
    includedBytes: 0,
    truncated: false,
    redacted: false,
    reason: describeReason(reason),
  };
}

function buildReportManifest(args: SupportReportManifestArgs): string {
  return JSON.stringify(
    {
      version: 1,
      reportId: args.reportId,
      createdAt: new Date().toISOString(),
      redactionPolicyVersion: DIAGNOSTICS_REDACTION_POLICY_VERSION,
      limits: {
        maxLogFileBytes: SUPPORT_LOG_TAIL_BYTES,
        maxTotalAttachmentBytes: SUPPORT_TOTAL_ATTACHMENT_BYTES,
      },
      app: {
        name: args.snapshot.appName,
        version: args.snapshot.appVersion,
        platform: args.snapshot.platform,
        arch: args.snapshot.arch,
        versions: args.snapshot.versions,
      },
      host: args.snapshot.host,
      diagnostics: {
        cliVersion: args.diagnosticsSnapshot.cliVersion,
        raw: args.diagnosticsSnapshot.raw,
        effective: args.diagnosticsSnapshot.effective,
        hostStatus: args.diagnosticsSnapshot.hostStatus,
      },
      files: args.files,
    },
    null,
    2,
  );
}

function unavailableStatus(reason: unknown): "missing" | "unreadable" {
  return errorCode(reason) === "ENOENT" ? "missing" : "unreadable";
}

function describeReason(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  return String(reason);
}

function errorCode(reason: unknown): string | null {
  if (reason !== null && typeof reason === "object" && "code" in reason) {
    const value = reason.code;
    return typeof value === "string" ? value : null;
  }
  return null;
}

async function ensureLogFile(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "a");
  await handle.close();
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
