import { app, shell } from "electron";
import { randomUUID } from "node:crypto";
import { open, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { arch, platform } from "node:process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import * as Sentry from "@sentry/electron/main";
import type { Layer0UnavailableCause } from "@traycer/protocol/host/lifecycle/layer0-frame";
import type { HostFsLayout } from "../host/host-paths";
import { readHostLayer0Record } from "../host/host-state";
import { log, resolveDesktopLogPath } from "./logger";
import { handleGetMetrics } from "./diagnostics";
import type { DesktopLocalHostSnapshot } from "../../ipc-contracts/host-types";
import type {
  DesktopAuthSessionSnapshot,
  SupportHostLayer0Snapshot,
  SupportFreezeEvidenceResult,
  SupportLogTarget,
  SupportLogTailResult,
  SupportReadFrozenLogTailInput,
  SupportRevealLogResult,
  SupportSaveDiagnosticBundleResult,
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
// A draft's frozen evidence is dropped explicitly on cancel/replacement; this
// is only a backstop against a lost discard message (e.g. a window force-
// closed mid-dialog) growing the map without bound across a long-lived app.
const FROZEN_EVIDENCE_MAX_ENTRIES = 20;
const REPORT_ID_PREFIX = "rpt_";

interface FrozenLogTail {
  readonly content: string;
  // Whether the source had more than LOG_TAIL_LINES lines at freeze time -
  // computed once, at freeze, since the live file can grow past that window
  // for the rest of the dialog session.
  readonly truncated: boolean;
}

interface FrozenEvidence {
  readonly reportId: string;
  readonly desktop: FrozenLogTail;
  readonly host: FrozenLogTail;
}

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
  private readonly frozenEvidenceByDraftId = new Map<number, FrozenEvidence>();

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

  async getSnapshot(): Promise<SupportSnapshot> {
    const host = this.host.getSnapshot();
    const authSession = this.authSession.get();
    const layer0 = await readHostLayer0Record(this.hostLayout);
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
        layer0,
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
      privateDeliveryAvailable: Sentry.isInitialized(),
    };
  }

  async revealLog(target: SupportLogTarget): Promise<SupportRevealLogResult> {
    const path = this.resolveSupportLogPath(target);
    await ensureLogFile(path);
    shell.showItemInFolder(path);
    return { target, path };
  }

  /**
   * Called at report-open, before the dialog renders. Reads both log tails
   * and mints the draft's report id once; submit and every retry reuse both,
   * so a crash-looping host that keeps writing while the dialog is open can't
   * scroll the failing lines out of the window mid-session.
   */
  async freezeEvidence(draftId: number): Promise<SupportFreezeEvidenceResult> {
    const [desktop, host] = await Promise.all([
      captureLogTail(
        resolveDesktopLogPath(),
        LOG_TAIL_LINES,
        LOG_ATTACHMENT_MAX_BYTES,
      ),
      captureLogTail(
        this.hostLayout.logFile,
        LOG_TAIL_LINES,
        LOG_ATTACHMENT_MAX_BYTES,
      ),
    ]);
    const reportId = generateReportId();
    this.setFrozenEvidence(draftId, { reportId, desktop, host });
    return { reportId };
  }

  /** Cancel, or a dialog replacing this draft, drops its frozen evidence. */
  discardFrozenEvidence(draftId: number): void {
    this.frozenEvidenceByDraftId.delete(draftId);
  }

  /**
   * Serves the consent panel's "view" affordance from the frozen tail, not a
   * live read - what the user reviews here is exactly what submit ships.
   */
  async readFrozenLogTail(
    input: SupportReadFrozenLogTailInput,
  ): Promise<SupportLogTailResult> {
    const path = this.resolveSupportLogPath(input.target);
    const frozen = this.frozenEvidenceByDraftId.get(input.draftId);
    if (frozen === undefined) {
      return { target: input.target, path, lines: [], truncated: false };
    }
    const tail = input.target === "desktop" ? frozen.desktop : frozen.host;
    return {
      target: input.target,
      path,
      lines: splitLogLines(tail.content),
      truncated: tail.truncated,
    };
  }

  async submitReport(
    form: SupportSubmitReportRequest,
  ): Promise<SupportSubmitReportResult> {
    const frozen = this.frozenEvidenceByDraftId.get(form.draftId);
    if (frozen === undefined) {
      // The dialog always freezes evidence before it lets the user submit;
      // reaching here means that call was skipped or its draft already
      // expired. Failing honestly beats minting a fresh, non-idempotent id.
      log.error("[support] submitReport called with no frozen evidence", {
        draftId: form.draftId,
      });
      return { status: "failed", reason: "error" };
    }

    // No DSN baked in (dev/staging without sentry). Nothing is uploaded, so
    // there is no report to hand back.
    if (!Sentry.isInitialized()) {
      log.warn("[support] sentry unavailable, report not uploaded", {
        reportId: frozen.reportId,
      });
      return { status: "unavailable" };
    }

    const snapshot = await this.getSnapshot();
    const processMetrics = await handleGetMetrics().catch((err: unknown) => {
      log.error("[support] failed to collect process metrics", { err });
      return null;
    });

    const message = [
      `Title: ${form.title}`,
      layer0MessageLine(snapshot.host.layer0),
      form.whatHappened && `What happened:\n${form.whatHappened}`,
      form.stepsToReproduce && `Steps to reproduce:\n${form.stepsToReproduce}`,
      form.expectedBehavior && `Expected:\n${form.expectedBehavior}`,
      form.actualBehavior && `Actual:\n${form.actualBehavior}`,
      `Report ID: ${frozen.reportId}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    const userEmail = snapshot.user.email;
    const contexts: Record<string, Record<string, unknown>> = {
      ...(snapshot.host.layer0 === null
        ? {}
        : { layer0: { ...snapshot.host.layer0 } }),
      ...(processMetrics === null
        ? {}
        : { processMetrics: { ...processMetrics } }),
      ...(form.privateDiagnostics?.cause == null
        ? {}
        : { errorCause: { ...form.privateDiagnostics.cause } }),
      ...(form.privateDiagnostics?.session == null
        ? {}
        : { session: { ...form.privateDiagnostics.session } }),
    };
    try {
      Sentry.captureFeedback(
        {
          name: userEmail ?? "anonymous",
          email: userEmail ?? undefined,
          message,
        },
        {
          // Sentry's ingest dedupes on `event_id` within a time window, which
          // is what makes a retry idempotent - the reportId's suffix already
          // is a valid 32-hex-char event id (the uuid minus dashes), so
          // reusing it here instead of a per-call id is the whole mechanism.
          event_id: sentryEventIdFromReportId(frozen.reportId),
          captureContext: {
            tags: {
              reportId: frozen.reportId,
              appVersion: snapshot.appVersion,
              platform: `${snapshot.platform}/${snapshot.arch}`,
              hostVersion: snapshot.host.version ?? "unknown",
              electronVersion: snapshot.versions.electron ?? "unknown",
              layer0Status: layer0StatusTag(snapshot.host.layer0),
              ...(form.fingerprint === undefined
                ? {}
                : { fingerprint: form.fingerprint }),
              ...(form.correlationId === undefined
                ? {}
                : { correlationId: form.correlationId }),
            },
            ...(Object.keys(contexts).length === 0 ? {} : { contexts }),
          },
          attachments: [
            ...(frozen.desktop.content
              ? [{ filename: "desktop.log", data: frozen.desktop.content }]
              : []),
            ...(frozen.host.content
              ? [{ filename: "host.log", data: frozen.host.content }]
              : []),
          ],
        },
      );
    } catch (err) {
      log.error("[support] captureFeedback threw", {
        reportId: frozen.reportId,
        err,
      });
      return { status: "failed", reason: "error" };
    }

    // `flush` resolves false when the queue did not drain inside the timeout.
    // That is not the same as lost - the transport may still deliver it - so
    // this maps to `unconfirmed`, never `failed`; a blanket "failed" would
    // tell users a report failed that in fact arrived.
    const flushed = await Sentry.flush(SENTRY_FLUSH_TIMEOUT_MS).catch(
      (err: unknown) => {
        log.error("[support] sentry flush failed", {
          reportId: frozen.reportId,
          err,
        });
        return false;
      },
    );
    if (!flushed) {
      log.warn("[support] report upload did not confirm within timeout", {
        reportId: frozen.reportId,
      });
      return { status: "unconfirmed", reportId: frozen.reportId };
    }
    return { status: "delivered", reportId: frozen.reportId };
  }

  /**
   * Written on the unavailable path (Flow 4 Case B's "Save diagnostic
   * bundle"). Ships without log tails until ticket 09's scrubber lands - a
   * host.log line is never redacted at source, and this bundle is a local
   * file the user can hand to anyone, so it must not carry one unscrubbed.
   */
  async saveDiagnosticBundle(
    form: SupportSubmitReportRequest,
  ): Promise<SupportSaveDiagnosticBundleResult> {
    const frozen = this.frozenEvidenceByDraftId.get(form.draftId);
    const snapshot = await this.getSnapshot();
    const bundle = {
      reportId: frozen?.reportId ?? null,
      generatedAt: new Date().toISOString(),
      title: form.title,
      whatHappened: form.whatHappened,
      stepsToReproduce: form.stepsToReproduce,
      expectedBehavior: form.expectedBehavior,
      actualBehavior: form.actualBehavior,
      appVersion: snapshot.appVersion,
      platform: snapshot.platform,
      arch: snapshot.arch,
      versions: snapshot.versions,
      host: { status: snapshot.host.status, version: snapshot.host.version },
    };
    const dir = await mkdtemp(join(tmpdir(), "traycer-diagnostic-bundle-"));
    const path = join(dir, `${frozen?.reportId ?? "report"}.json`);
    await writeFile(path, JSON.stringify(bundle, null, 2), "utf8");
    log.info("[support] diagnostic bundle written", { path });
    // Save-and-reveal is one action, same as `revealLog` - the whole point is
    // the user can immediately see and inspect what a "local file" means.
    shell.showItemInFolder(path);
    return { path };
  }

  private setFrozenEvidence(draftId: number, evidence: FrozenEvidence): void {
    this.frozenEvidenceByDraftId.delete(draftId);
    this.frozenEvidenceByDraftId.set(draftId, evidence);
    while (this.frozenEvidenceByDraftId.size > FROZEN_EVIDENCE_MAX_ENTRIES) {
      const oldestDraftId = this.frozenEvidenceByDraftId.keys().next().value;
      if (oldestDraftId === undefined) break;
      this.frozenEvidenceByDraftId.delete(oldestDraftId);
    }
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

async function captureLogTail(
  path: string,
  lines: number,
  maxBytes: number,
): Promise<FrozenLogTail> {
  const content = await readFile(path, "utf-8").catch(() => "");
  const allLines = splitLogLines(content);
  const truncated = allLines.length > lines;
  const tail = allLines.slice(-lines).join("\n");
  return { content: truncateToTrailingBytes(tail, maxBytes), truncated };
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
  return `${REPORT_ID_PREFIX}${randomUUID().replace(/-/g, "")}`;
}

// Sentry's ingest dedupes on `event_id` within a time window - the reportId's
// suffix (a uuid with dashes stripped) is already a valid 32-hex-char id, so
// this is just re-deriving it, not generating anything new.
function sentryEventIdFromReportId(reportId: string): string {
  return reportId.slice(REPORT_ID_PREFIX.length);
}

/**
 * A bounded enum for Sentry tags (filterable), never the free-text
 * cause/evidence - those go in `contexts.layer0` below, which Sentry does
 * not index or limit the length of the way it does tags.
 */
function layer0StatusTag(
  layer0: SupportHostLayer0Snapshot | null,
): "acquired" | "degraded" | "unrecognized" | "absent" {
  return layer0 === null ? "absent" : layer0.status;
}

/**
 * Surfaces the degradation in the message body itself - the first thing a
 * support engineer reads, before they think to open `contexts.layer0` or
 * grep the host.log attachment. Silent for `acquired` (nothing to flag) and
 * for `null` (nothing recorded to report, per the "absence is not healthy
 * but also not a finding" contract `readHostLayer0Record` returns).
 */
function layer0MessageLine(
  layer0: SupportHostLayer0Snapshot | null,
): string | false {
  if (layer0 === null || layer0.status === "acquired") return false;
  if (layer0.status === "degraded")
    return `Layer 0: degraded (${formatLayer0Cause(layer0.cause)})`;
  return `Layer 0: unrecognized (${layer0.raw})`;
}

function formatLayer0Cause(cause: Layer0UnavailableCause): string {
  return typeof cause === "string" ? cause : JSON.stringify(cause);
}

function splitLogLines(content: string): readonly string[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") {
    return lines.slice(0, -1);
  }
  return lines;
}
