import { app, shell } from "electron";
import { randomUUID } from "node:crypto";
import {
  open,
  mkdir,
  mkdtemp,
  readdir,
  stat,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { arch, platform } from "node:process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import * as Sentry from "@sentry/electron/main";
import type { Layer0UnavailableCause } from "@traycer/protocol/host/lifecycle/layer0-frame";
import type { HostFsLayout } from "../host/host-paths";
import { readHostLayer0Record } from "../host/host-state";
import { log, resolveDesktopLogPath } from "./logger";
import { handleGetMetrics } from "./diagnostics";
import type { DesktopPublishedHostSnapshot } from "../../ipc-contracts/host-types";
import type {
  DesktopAuthSessionSnapshot,
  SupportBuildPublicDraftResult,
  SupportHostLayer0Snapshot,
  SupportFreezeEvidenceResult,
  SupportImageAttachmentInput,
  SupportLogDescriptor,
  SupportLogTarget,
  SupportLogTailResult,
  SupportRevealLogResult,
  SupportSaveDiagnosticBundleResult,
  SupportSnapshot,
  SupportSubmitReportRequest,
  SupportSubmitReportResult,
} from "../../ipc-contracts/window-types";
import { buildSupportLinks, TRAYCER_SUPPORT_EMAIL } from "./support-links";
import {
  getFingerprintOccurrence,
  recordFiledReport,
  recordFingerprintSighting,
  type FingerprintOccurrence,
} from "./report-ledger";
import { buildPublicDraftFields } from "./support-public-draft";
import { deepScrubSupportValue, scrubSupportText } from "./support-scrubber";
import {
  REPORT_LOG_TAIL_MAX_BYTES,
  reportImageMediaTypeForMimeType,
} from "@traycer-clients/shared/support/image-attachment-guards";

const DIAGNOSTIC_BUNDLE_RETENTION_MS = 60 * 60_000;

const LOG_TAIL_LINES = 500;
const LOG_ATTACHMENT_MAX_BYTES = REPORT_LOG_TAIL_MAX_BYTES;
// The user is watching a spinner, but losing the report costs far more than
// waiting: 2s was not enough to upload two log attachments on a slow link.
const SENTRY_FLUSH_TIMEOUT_MS = 10_000;
// This only bounds the (practically unreachable, since nothing in this app's Sentry init samples or filters feedback events) case where the hook never fires at all despite `flush`.
const SEND_OUTCOME_GRACE_MS = 500;
// A draft's frozen evidence is dropped explicitly on cancel/replacement; this
// is only a backstop against a lost discard message (e.g. a window force-
// closed mid-dialog) growing the map without bound across a long-lived app.
const FROZEN_EVIDENCE_MAX_ENTRIES = 20;
const REPORT_ID_PREFIX = "rpt_";

interface FrozenLogTail {
  readonly content: string;
  // Whether either bound (line count or byte cap) cut the source at freeze
  // time - computed once, at freeze, since the live file can grow past
  // either window for the rest of the dialog session.
  readonly truncated: boolean;
}

interface FrozenEvidence {
  readonly reportId: string;
  readonly desktop: FrozenLogTail;
  readonly host: FrozenLogTail;
  readonly browserTelemetry: FrozenLogTail;
  readonly browserTrace: FrozenLogTail;
}

// The map key is scoped by sender (composed in support-ipc.ts), never a bare draftId - a draftId is only unique within one renderer realm.
type FrozenEvidenceEntry =
  | { readonly kind: "pending"; readonly promise: Promise<FrozenEvidence> }
  | { readonly kind: "ready"; readonly evidence: FrozenEvidence };

export interface SupportHostSnapshotProvider {
  getSnapshot(): DesktopPublishedHostSnapshot | null;
}

export interface SupportAuthSessionProvider {
  get(): DesktopAuthSessionSnapshot;
}

/** Bounded + TTL so a long-lived process cannot grow the set forever. */
const SIGHTING_DEDUPE_TTL_MS = 10 * 60 * 1000;
const SIGHTING_DEDUPE_MAX_ENTRIES = 200;

export class DesktopSupportService {
  private readonly appName: string;
  private readonly host: SupportHostSnapshotProvider;
  private readonly authSession: SupportAuthSessionProvider;
  private readonly hostLayout: HostFsLayout;
  private readonly frozenEvidenceByKey = new Map<string, FrozenEvidenceEntry>();
  // frozenEvidenceKey -> lastSightedAtMs. Intentionally NOT cleared on discard.
  private readonly recentSightingKeys = new Map<string, number>();

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
    const browserLogs = await existingBrowserLogDescriptors(this.hostLayout);
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
        ...browserLogs,
      ],
      links: buildSupportLinks(),
      supportEmail: TRAYCER_SUPPORT_EMAIL,
      privateDeliveryAvailable: Sentry.isInitialized(),
    };
  }

  async revealLog(target: SupportLogTarget): Promise<SupportRevealLogResult> {
    const path = this.resolveSupportLogPath(target);
    if (!isBrowserLogTarget(target)) {
      await ensureLogFile(path);
    } else if (!(await pathExists(path))) {
      // A race between the existence-filtered manifest and this call (the
      // file rotated away, or never actually existed) - early-return rather
      // than handing `shell.showItemInFolder` a path with nothing there.
      return { target, path };
    }
    shell.showItemInFolder(path);
    return { target, path };
  }

  /** Called at report-open, before the dialog renders. */
  async freezeEvidence(
    frozenEvidenceKey: string,
    fingerprint: string | null,
  ): Promise<SupportFreezeEvidenceResult> {
    const existing = this.frozenEvidenceByKey.get(frozenEvidenceKey);
    if (existing !== undefined) {
      const evidence =
        existing.kind === "ready" ? existing.evidence : await existing.promise;
      return { reportId: evidence.reportId };
    }
    const reportId = generateReportId();
    // Fire-and-forget onto the ledger mutation queue: a disk blip must never block freeze / dialog open.
    // The queue is still scheduled synchronously so a later getFingerprintOccurrence (which awaits the queue) sees it.
    if (
      fingerprint !== null &&
      fingerprint.length > 0 &&
      this.claimSightingSlot(frozenEvidenceKey)
    ) {
      void recordFingerprintSighting(fingerprint);
    }
    const promise = captureFrozenEvidence(
      reportId,
      resolveDesktopLogPath(),
      this.hostLayout,
    );
    this.setFrozenEvidence(frozenEvidenceKey, { kind: "pending", promise });
    const evidence = await promise;
    // Either way, a late resolution here must not resurrect or overwrite it.
    const current = this.frozenEvidenceByKey.get(frozenEvidenceKey);
    if (
      current !== undefined &&
      current.kind === "pending" &&
      current.promise === promise
    ) {
      this.setFrozenEvidence(frozenEvidenceKey, { kind: "ready", evidence });
    }
    return { reportId };
  }

  /** Survives discard so StrictMode's discard-between-setups cannot re-claim. */
  private claimSightingSlot(frozenEvidenceKey: string): boolean {
    const nowMs = Date.now();
    for (const [key, claimedAt] of this.recentSightingKeys) {
      if (nowMs - claimedAt > SIGHTING_DEDUPE_TTL_MS) {
        this.recentSightingKeys.delete(key);
      }
    }
    if (this.recentSightingKeys.has(frozenEvidenceKey)) {
      return false;
    }
    // Bound the map: drop oldest (Map iteration order = insertion order).
    while (this.recentSightingKeys.size >= SIGHTING_DEDUPE_MAX_ENTRIES) {
      const oldestKey = this.recentSightingKeys.keys().next().value;
      if (oldestKey === undefined) break;
      this.recentSightingKeys.delete(oldestKey);
    }
    this.recentSightingKeys.set(frozenEvidenceKey, nowMs);
    return true;
  }

  /** Backed by the report ledger (userData), never renderer localStorage. */
  getFingerprintOccurrence(
    fingerprint: string,
  ): Promise<FingerprintOccurrence | null> {
    return getFingerprintOccurrence(fingerprint);
  }

  /** Cancel, or a dialog replacing this draft, drops its frozen evidence. */
  discardFrozenEvidence(frozenEvidenceKey: string): void {
    this.frozenEvidenceByKey.delete(frozenEvidenceKey);
  }

  async readFrozenLogTail(
    frozenEvidenceKey: string,
    target: SupportLogTarget,
  ): Promise<SupportLogTailResult> {
    const path = this.resolveSupportLogPath(target);
    const frozen = await this.resolveFrozenEvidence(frozenEvidenceKey);
    if (frozen === undefined) {
      return { target, path, lines: [], truncated: false };
    }
    const tail = frozenLogTailForTarget(frozen, target);
    return {
      target,
      path,
      lines: splitLogLines(tail.content),
      truncated: tail.truncated,
    };
  }

  async submitReport(
    form: SupportSubmitReportRequest,
    frozenEvidenceKey: string,
  ): Promise<SupportSubmitReportResult> {
    const frozen = await this.resolveFrozenEvidence(frozenEvidenceKey);
    if (frozen === undefined) {
      // The dialog always freezes evidence before it lets the user submit;
      // reaching here means that call was skipped or its draft already
      // expired. Failing honestly beats minting a fresh, non-idempotent id.
      log.error("[support] submitReport called with no frozen evidence", {
        draftId: form.draftId,
        frozenEvidenceKey,
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
    // Diagnostics toggle gates layer-0/process-metrics/version-platform-host tags+contexts.
    // `fingerprint`/`correlationId` are never gated by it - they are the report's own identity, not "diagnostics" in the privacy sense, and travel below independent of this flag.
    const includeDiagnostics = form.includeDiagnostics;
    const processMetrics = includeDiagnostics
      ? await handleGetMetrics().catch((err: unknown) => {
          log.error("[support] failed to collect process metrics", { err });
          return null;
        })
      : null;

    const message = scrubSupportText(
      [
        `Type: ${form.type}`,
        includeDiagnostics ? layer0MessageLine(snapshot.host.layer0) : false,
        form.intent && `What they were trying to do:\n${form.intent}`,
        form.location && `Where: ${form.location}`,
        form.frequency && `Frequency: ${form.frequency}`,
        `Report ID: ${frozen.reportId}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    );

    const userEmail = form.allowContact ? snapshot.user.email : null;
    const privateDiagnostics = form.privateDiagnostics;
    const imageAttachments = sentryAttachmentsForImages(form.images);
    const eventId = sentryEventIdFromReportId(frozen.reportId);
    const contexts: Record<string, Record<string, unknown>> = includeDiagnostics
      ? deepScrubSupportValue({
          ...(snapshot.host.layer0 === null
            ? {}
            : { layer0: { ...snapshot.host.layer0 } }),
          ...(processMetrics === null
            ? {}
            : {
                processMetrics: {
                  main: { ...processMetrics.main },
                  cpuUsage: { ...processMetrics.cpuUsage },
                },
                appMetrics: flattenAppMetricsForSentry(
                  processMetrics.appMetrics,
                ),
              }),
          ...(privateDiagnostics?.cause == null
            ? {}
            : { errorCause: { ...privateDiagnostics.cause } }),
          ...(privateDiagnostics === undefined
            ? {}
            : { registry: { ...privateDiagnostics.registry } }),
        })
      : {};
    // `afterSendEvent` carries the transport's real response, which `flush` alone cannot distinguish from rejection.
    const sendOutcome = watchSentrySendOutcome(eventId);
    try {
      try {
        Sentry.captureFeedback(
          {
            name: userEmail ?? "anonymous",
            email: userEmail ?? undefined,
            message,
          },
          {
            event_id: eventId,
            captureContext: {
              tags: {
                reportId: frozen.reportId,
                ...(includeDiagnostics
                  ? {
                      appVersion: snapshot.appVersion,
                      platform: `${snapshot.platform}/${snapshot.arch}`,
                      localHostVersion: snapshot.host.version ?? "unknown",
                      electronVersion: snapshot.versions.electron ?? "unknown",
                      layer0Status: layer0StatusTag(snapshot.host.layer0),
                    }
                  : {}),
                ...(privateDiagnostics?.fingerprint == null
                  ? {}
                  : { fingerprint: privateDiagnostics.fingerprint }),
                // Sub-clustering only - deliberately not part of `fingerprint` (a one-frame refactor must not re-identify a defect), and unlike fingerprint/correlationId this IS diagnostics content.
                ...(includeDiagnostics &&
                privateDiagnostics?.stackFamily != null
                  ? { stackFamily: privateDiagnostics.stackFamily }
                  : {}),
                ...(privateDiagnostics === undefined
                  ? {}
                  : { correlationId: privateDiagnostics.correlationId }),
              },
              ...(Object.keys(contexts).length === 0 ? {} : { contexts }),
            },
            // Consent panel's two log toggles gate this directly: an "off"
            // toggle must actually withhold the tail, not just stop
            // rendering it, or the toggle is a dishonest no-op.
            attachments: [
              ...(form.includeDesktopLog && frozen.desktop.content
                ? [{ filename: "desktop.log", data: frozen.desktop.content }]
                : []),
              // Named for the local traycer-host this Electron process
              // supervises (D10) - a tab can be bound to a different host,
              // so this must never be read as "the log for that host".
              ...(form.includeHostLog && frozen.host.content
                ? [
                    {
                      filename: "local-host.log",
                      data: frozen.host.content,
                    },
                  ]
                : []),
              ...(form.includeBrowserDiagnostics &&
              frozen.browserTelemetry.content
                ? [
                    {
                      filename: "browser-telemetry.jsonl",
                      data: frozen.browserTelemetry.content,
                    },
                  ]
                : []),
              ...(form.includeBrowserDiagnostics && frozen.browserTrace.content
                ? [
                    {
                      filename: "browser-trace.jsonl",
                      data: frozen.browserTrace.content,
                    },
                  ]
                : []),
              // Screenshots attach here only - never to the GitHub URL/public
              // draft (ticket 08).
              ...imageAttachments,
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
      const outcome = await sendOutcome.awaitOutcome();
      if (outcome !== null && outcome.status === "failed") {
        log.error("[support] sentry rejected the report", {
          reportId: frozen.reportId,
          statusCode: outcome.statusCode,
        });
        return { status: "failed", reason: "error" };
      }
      // unconfirmed/failed/unavailable must not - a phantom entry would inflate later router counts and fixed-in work.
      // Fire-and- forget: ledger failure must not turn a successful upload into a failed submit result.
      const deliveredFingerprint = privateDiagnostics?.fingerprint;
      if (
        deliveredFingerprint !== null &&
        deliveredFingerprint !== undefined &&
        deliveredFingerprint.length > 0
      ) {
        void recordFiledReport(frozen.reportId, deliveredFingerprint);
      }
      return { status: "delivered", reportId: frozen.reportId };
    } finally {
      sendOutcome.unsubscribe();
    }
  }

  async saveDiagnosticBundle(
    form: SupportSubmitReportRequest,
    frozenEvidenceKey: string,
  ): Promise<SupportSaveDiagnosticBundleResult> {
    const frozen = await this.resolveFrozenEvidence(frozenEvidenceKey);
    const snapshot = await this.getSnapshot();
    const bundle = {
      reportId: frozen?.reportId ?? null,
      generatedAt: new Date().toISOString(),
      type: form.type,
      intent: scrubSupportText(form.intent),
      frequency: form.frequency,
      location: form.location === null ? null : scrubSupportText(form.location),
      // Same diagnostics toggle `submitReport` honors: version/platform/host
      // is environment diagnostics, not the report's own identity, so an
      // "off" toggle withholds it from the bundle too, not just the upload.
      ...(form.includeDiagnostics
        ? {
            appVersion: snapshot.appVersion,
            platform: snapshot.platform,
            arch: snapshot.arch,
            versions: snapshot.versions,
            host: {
              status: snapshot.host.status,
              version: snapshot.host.version,
            },
          }
        : {}),
      // Same consent-panel toggles submitReport honors - an "off" log toggle
      // must withhold the tail from the bundle too, not just the upload.
      logs: {
        desktop: form.includeDesktopLog ? (frozen?.desktop.content ?? "") : "",
        host: form.includeHostLog ? (frozen?.host.content ?? "") : "",
        browserTelemetry: form.includeBrowserDiagnostics
          ? (frozen?.browserTelemetry.content ?? "")
          : "",
        browserTrace: form.includeBrowserDiagnostics
          ? (frozen?.browserTrace.content ?? "")
          : "",
      },
    };
    const dir = await mkdtemp(join(tmpdir(), "traycer-diagnostic-bundle-"));
    await this.removeOtherDiagnosticBundles(dir);
    const path = join(dir, `${frozen?.reportId ?? "report"}.json`);
    await writeFile(path, JSON.stringify(bundle, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    log.info("[support] diagnostic bundle written", { path });
    // Save-and-reveal is one action, same as `revealLog` - the whole point is
    // the user can immediately see and inspect what a "local file" means.
    shell.showItemInFolder(path);
    return { path };
  }

  private async removeOtherDiagnosticBundles(keep: string): Promise<void> {
    const root = tmpdir();
    const entries = await readdir(root).catch(() => []);
    const cutoff = Date.now() - DIAGNOSTIC_BUNDLE_RETENTION_MS;
    await Promise.all(
      entries
        .filter((entry) => entry.startsWith("traycer-diagnostic-bundle-"))
        .map((entry) => join(root, entry))
        .filter((candidate) => candidate !== keep)
        .map(async (candidate) => {
          // A candidate we cannot stat is left alone: removing it would be
          // acting on an age nothing established.
          const modifiedAt = await stat(candidate)
            .then((stats) => stats.mtimeMs)
            .catch(() => null);
          if (modifiedAt === null || modifiedAt > cutoff) return;
          await rm(candidate, { recursive: true, force: true }).catch(
            () => undefined,
          );
        }),
    );
  }

  async buildPublicDraft(
    form: SupportSubmitReportRequest,
    frozenEvidenceKey: string,
  ): Promise<SupportBuildPublicDraftResult> {
    const frozen = await this.resolveFrozenEvidence(frozenEvidenceKey);
    const snapshot = await this.getSnapshot();
    return buildPublicDraftFields({
      type: form.type,
      intent: form.intent,
      frequency: form.frequency,
      appVersion: snapshot.appVersion,
      platform: snapshot.platform,
      arch: snapshot.arch,
      hostVersion: snapshot.host.version,
      reportId: frozen?.reportId ?? null,
      privateDiagnostics: form.privateDiagnostics,
      imageCount: form.images.length,
      overrideTitle: form.overrideTitle,
      privateOutcome: form.privateOutcome,
    });
  }

  /** Resolves to `undefined` if never frozen, discarded, or evicted. */
  private async resolveFrozenEvidence(
    frozenEvidenceKey: string,
  ): Promise<FrozenEvidence | undefined> {
    const entry = this.frozenEvidenceByKey.get(frozenEvidenceKey);
    if (entry === undefined) return undefined;
    return entry.kind === "ready" ? entry.evidence : entry.promise;
  }

  private setFrozenEvidence(key: string, entry: FrozenEvidenceEntry): void {
    this.frozenEvidenceByKey.delete(key);
    this.frozenEvidenceByKey.set(key, entry);
    while (this.frozenEvidenceByKey.size > FROZEN_EVIDENCE_MAX_ENTRIES) {
      const oldestKey = this.frozenEvidenceByKey.keys().next().value;
      if (oldestKey === undefined) break;
      this.frozenEvidenceByKey.delete(oldestKey);
    }
  }

  async tailLog(input: {
    readonly target: SupportLogTarget;
    readonly tailLines: number;
  }): Promise<SupportLogTailResult> {
    const path = this.resolveSupportLogPath(input.target);
    if (!isBrowserLogTarget(input.target)) {
      await ensureLogFile(path);
    }
    const content = isBrowserLogTarget(input.target)
      ? await readBrowserLogFiles(
          input.target === "browserTelemetry"
            ? this.hostLayout.browserTelemetryRotatedFile
            : this.hostLayout.browserTraceRotatedFile,
          path,
        )
      : await readFile(path, "utf8");
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
    if (target === "host") {
      return this.hostLayout.logFile;
    }
    if (target === "browserTelemetry") {
      return this.hostLayout.browserTelemetryFile;
    }
    return this.hostLayout.browserTraceFile;
  }
}

function isBrowserLogTarget(
  target: SupportLogTarget,
): target is "browserTelemetry" | "browserTrace" {
  return target === "browserTelemetry" || target === "browserTrace";
}

async function readBrowserLogFiles(
  rotatedPath: string,
  livePath: string,
): Promise<string> {
  const readIfPresent = async (path: string): Promise<string> =>
    readFile(path, "utf8").catch((error: unknown) => {
      if (isMissingPathError(error)) return "";
      throw error;
    });
  const [rotated, live] = await Promise.all([
    readIfPresent(rotatedPath),
    readIfPresent(livePath),
  ]);
  if (rotated.length === 0 || live.length === 0 || rotated.endsWith("\n")) {
    return rotated + live;
  }
  return `${rotated}\n${live}`;
}

function frozenLogTailForTarget(
  frozen: FrozenEvidence,
  target: SupportLogTarget,
): FrozenLogTail {
  if (target === "desktop") return frozen.desktop;
  if (target === "host") return frozen.host;
  if (target === "browserTelemetry") return frozen.browserTelemetry;
  return frozen.browserTrace;
}

async function existingBrowserLogDescriptors(
  hostLayout: HostFsLayout,
): Promise<readonly SupportLogDescriptor[]> {
  const [telemetryExists, traceExists] = await Promise.all([
    pathExists(hostLayout.browserTelemetryFile),
    pathExists(hostLayout.browserTraceFile),
  ]);
  return [
    ...(telemetryExists
      ? [
          {
            target: "browserTelemetry" as const,
            label: "Browser Telemetry Log",
            path: hostLayout.browserTelemetryFile,
          },
        ]
      : []),
    ...(traceExists
      ? [
          {
            target: "browserTrace" as const,
            label: "Browser Trace Log",
            path: hostLayout.browserTraceFile,
          },
        ]
      : []),
  ];
}

// This gates whether a browser log entry is offered at all (manifest listing, reveal), so a broken file must never be able to break report-issue itself.
async function pathExists(path: string): Promise<boolean> {
  try {
    const handle = await open(path, "r");
    await handle.close();
    return true;
  } catch {
    return false;
  }
}

async function ensureLogFile(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "a");
  await handle.close();
}

async function captureFrozenEvidence(
  reportId: string,
  desktopLogPath: string,
  hostLayout: HostFsLayout,
): Promise<FrozenEvidence> {
  const [desktop, host, browserTelemetry, browserTrace] = await Promise.all([
    captureLogTail(desktopLogPath, LOG_TAIL_LINES, LOG_ATTACHMENT_MAX_BYTES),
    captureLogTail(
      hostLayout.logFile,
      LOG_TAIL_LINES,
      LOG_ATTACHMENT_MAX_BYTES,
    ),
    captureBrowserLogTail(
      hostLayout.browserTelemetryRotatedFile,
      hostLayout.browserTelemetryFile,
      LOG_ATTACHMENT_MAX_BYTES,
    ),
    captureBrowserLogTail(
      hostLayout.browserTraceRotatedFile,
      hostLayout.browserTraceFile,
      LOG_ATTACHMENT_MAX_BYTES,
    ),
  ]);
  return { reportId, desktop, host, browserTelemetry, browserTrace };
}

async function captureLogTail(
  path: string,
  lines: number,
  maxBytes: number,
): Promise<FrozenLogTail> {
  const content = await readFile(path, "utf-8").catch(() => "");
  const allLines = splitLogLines(content);
  const truncatedByLineCount = allLines.length > lines;
  const tail = allLines.slice(-lines).join("\n");
  // Scrub BEFORE the byte cap below, never after: `host.log` is written with zero redaction at source, so this is the only point that ever sees the raw tail.
  // Truncating first could cut a token/path mid-match so the scrubber's regexes miss the remainder, and the byte budget itself must measure what will actually ship (the scrubbed.
  const scrubbed = scrubSupportText(tail);
  const truncatedByByteCount = Buffer.byteLength(scrubbed, "utf8") > maxBytes;
  return {
    content: truncateToTrailingBytes(scrubbed, maxBytes),
    truncated: truncatedByLineCount || truncatedByByteCount,
  };
}

async function captureBrowserLogTail(
  rotatedPath: string,
  livePath: string,
  maxBytes: number,
): Promise<FrozenLogTail> {
  const window = await readConcatenatedJsonlTailWindow(
    rotatedPath,
    livePath,
    maxBytes,
  );
  const decodedLines = splitLogLines(window.bytes.toString("utf8"));
  // A byte window can begin mid-codepoint and mid-record. Drop the first line
  // only when the first included file was read from a nonzero offset; omitting
  // an earlier file does not make the next file's first record partial.
  const lines = window.headIsPartial ? decodedLines.slice(1) : decodedLines;
  // Scrub BEFORE the byte cap, never after - same invariant as
  // `captureLogTail` (ticket 09).
  const scrubbed = scrubSupportText(lines.join("\n"));
  const truncatedByByteCount = Buffer.byteLength(scrubbed, "utf8") > maxBytes;
  return {
    content: truncateToTrailingBytes(scrubbed, maxBytes),
    truncated: window.windowed || truncatedByByteCount,
  };
}

interface JsonlTailWindow {
  readonly bytes: Buffer;
  /** True when the window omits bytes from the start of the concatenation. */
  readonly windowed: boolean;
  /** True when the first returned byte is not the first byte of its file. */
  readonly headIsPartial: boolean;
}

async function readConcatenatedJsonlTailWindow(
  rotatedPath: string,
  livePath: string,
  maxBytes: number,
): Promise<JsonlTailWindow> {
  const live = await readTailBytes(livePath, maxBytes);
  const rotated = await readTailBytes(
    rotatedPath,
    maxBytes - live.bytes.length,
  );
  const totalSize = rotated.size + live.size;
  const windowed = rotated.bytes.length + live.bytes.length < totalSize;
  const headIsPartial =
    rotated.bytes.length > 0
      ? rotated.bytes.length < rotated.size
      : live.bytes.length < live.size;
  const rotatedEndsInNewline =
    rotated.bytes.length === 0 ||
    rotated.bytes[rotated.bytes.length - 1] === 0x0a;
  const bytes = rotatedEndsInNewline
    ? Buffer.concat([rotated.bytes, live.bytes])
    : Buffer.concat([rotated.bytes, Buffer.from("\n"), live.bytes]);
  return { bytes, windowed, headIsPartial };
}

interface TailBytesResult {
  readonly bytes: Buffer;
  /** The file's real total size, even when `maxBytes` is 0. */
  readonly size: number;
}

// Total: ANY error - missing file, a permission error, a stat/read failure
// mid-flight - resolves to an empty, zero-size result rather than a throw. A
// broken browser log file must never be able to break the report dialog.
async function readTailBytes(
  path: string,
  maxBytes: number,
): Promise<TailBytesResult> {
  let handle: FileHandle;
  try {
    handle = await open(path, "r");
  } catch {
    return { bytes: Buffer.alloc(0), size: 0 };
  }
  try {
    const { size } = await handle.stat();
    const bytesToRead = Math.min(Math.max(size, 0), Math.max(maxBytes, 0));
    const startOffset = size - bytesToRead;
    const buffer = Buffer.alloc(bytesToRead);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        startOffset + bytesRead,
      );
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    return { bytes: buffer.subarray(0, bytesRead), size };
  } catch {
    return { bytes: Buffer.alloc(0), size: 0 };
  } finally {
    await handle.close();
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function truncateToTrailingBytes(text: string, maxBytes: number): string {
  const encoded = Buffer.from(text, "utf8");
  if (encoded.byteLength <= maxBytes) return text;
  const kept = encoded.subarray(-maxBytes).toString("utf8");
  // The byte cut can land mid-codepoint or mid-line; drop the partial head.
  const firstNewline = kept.indexOf("\n");
  return firstNewline === -1 ? kept : kept.slice(firstNewline + 1);
}

function sentryAttachmentsForImages(
  images: readonly SupportImageAttachmentInput[],
): ReadonlyArray<{
  readonly filename: string;
  readonly data: Uint8Array;
  readonly contentType: string;
}> {
  return images.map((image) => {
    const mediaType = reportImageMediaTypeForMimeType(image.mimeType);
    if (mediaType === null) {
      throw new Error(
        `[support] validated image attachment carries an unsupported mimeType: ${image.mimeType}`,
      );
    }
    return {
      filename: image.fileName,
      data: new Uint8Array(image.bytes),
      contentType: mediaType,
    };
  });
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

interface SentrySendOutcome {
  readonly status: "delivered" | "failed";
  // Undefined on a network-level failure (e.g. a destroyed connection) -
  // there was no HTTP response to read a code off, but the send still
  // definitively did not reach the store, so it is still `"failed"`.
  readonly statusCode: number | undefined;
}

/**
 * Must be constructed before `Sentry.captureFeedback` is called, so the listener is live before the send it needs to observe starts.
 * `SEND_OUTCOME_GRACE_MS` bounds the case where the hook never fires despite `flush` saying the queue is empty.
 */
function watchSentrySendOutcome(eventId: string): {
  readonly awaitOutcome: () => Promise<SentrySendOutcome | null>;
  readonly unsubscribe: () => void;
} {
  const client = Sentry.getClient();
  if (client === undefined) {
    return { awaitOutcome: () => Promise.resolve(null), unsubscribe: () => {} };
  }
  let settleOutcome: (outcome: SentrySendOutcome) => void = () => {};
  const outcome = new Promise<SentrySendOutcome>((resolve) => {
    settleOutcome = resolve;
  });
  const unsubscribe = client.on("afterSendEvent", (event, sendResponse) => {
    if (event.event_id !== eventId) return;
    const statusCode = sendResponse.statusCode;
    settleOutcome({
      status:
        statusCode !== undefined && statusCode >= 200 && statusCode < 300
          ? "delivered"
          : "failed",
      statusCode,
    });
  });
  return {
    unsubscribe,
    awaitOutcome: () =>
      new Promise((resolve) => {
        const graceTimer = setTimeout(
          () => resolve(null),
          SEND_OUTCOME_GRACE_MS,
        );
        void outcome.then((result) => {
          clearTimeout(graceTimer);
          resolve(result);
        });
      }),
  };
}

function flattenAppMetricsForSentry(
  appMetrics: ReadonlyArray<Electron.ProcessMetric>,
): Record<string, unknown> {
  return {
    ...appMetrics.map((metric) => ({
      type: metric.type,
      pid: metric.pid,
      name: metric.name ?? metric.serviceName ?? null,
      cpuPercent: metric.cpu.percentCPUUsage,
      cpuIdleWakeupsPerSecond: metric.cpu.idleWakeupsPerSecond,
      memoryWorkingSetKb: metric.memory.workingSetSize,
      memoryPeakWorkingSetKb: metric.memory.peakWorkingSetSize,
    })),
  };
}

/** A bounded enum for Sentry tags (filterable), never the free-text cause/evidence. */
function layer0StatusTag(
  layer0: SupportHostLayer0Snapshot | null,
): "acquired" | "degraded" | "unrecognized" | "absent" {
  return layer0 === null ? "absent" : layer0.status;
}

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
