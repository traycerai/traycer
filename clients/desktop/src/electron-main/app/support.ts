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
import type { DesktopPublishedHostSnapshot } from "../../ipc-contracts/host-types";
import type {
  DesktopAuthSessionSnapshot,
  SupportBuildPublicDraftResult,
  SupportHostLayer0Snapshot,
  SupportFreezeEvidenceResult,
  SupportImageAttachmentInput,
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

const LOG_TAIL_LINES = 500;
// Per attachment. Two logs stay well inside Sentry's envelope limits, and the
// transport gzips before sending, so this is ~50 KB on the wire in practice.
// Imported from the shared image-attachment-guards module (not redefined
// here) since ticket 08's total attachment budget arithmetic depends on this
// exact value staying in sync with the renderer's attach-time check.
const LOG_ATTACHMENT_MAX_BYTES = REPORT_LOG_TAIL_MAX_BYTES;
// The user is watching a spinner, but losing the report costs far more than
// waiting: 2s was not enough to upload two log attachments on a slow link.
const SENTRY_FLUSH_TIMEOUT_MS = 10_000;
// `flush` reports the queue drained the instant our envelope's transport
// promise settles, but the `afterSendEvent` hook that carries the real HTTP
// outcome is chained off that same settlement through its own, separately
// registered `.then()`s - close, but not guaranteed to fire before `flush`
// resolves. This only bounds the (practically unreachable, since nothing in
// this app's Sentry init samples or filters feedback events) case where the
// hook never fires at all despite `flush` saying the queue is empty; in the
// normal case the hook resolves within a handful of microtasks, nowhere near
// this window.
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
}

// The map key is scoped by sender (composed in support-ipc.ts), never a bare
// draftId - a draftId is only unique within one renderer realm. `pending`
// exists between the moment a freeze is admitted and its file reads
// resolving, so a same-key freeze that arrives while one is already in
// flight (React StrictMode's double-effect, a duplicate call) can await the
// SAME operation and report instead of racing a second file read under a
// second id, and so a discard that lands mid-read has something concrete to
// cancel instead of racing an insert that hasn't happened yet.
type FrozenEvidenceEntry =
  | { readonly kind: "pending"; readonly promise: Promise<FrozenEvidence> }
  | { readonly kind: "ready"; readonly evidence: FrozenEvidence };

export interface SupportHostSnapshotProvider {
  getSnapshot(): DesktopPublishedHostSnapshot | null;
}

export interface SupportAuthSessionProvider {
  get(): DesktopAuthSessionSnapshot;
}

/**
 * Survives `discardFrozenEvidence` so React StrictMode's
 * setup → cleanup(discard) → setup sequence records ONE sighting, not two.
 * Keyed by the frozen-evidence key (sender + draftId): a real second open
 * mints a new draftId, so it still counts. Bounded + TTL so a long-lived
 * process cannot grow the set forever.
 */
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
   *
   * Idempotent for a still-live key: a second call while the first is still
   * reading (or already landed) returns the SAME report id rather than
   * racing a second file read under a second one - React StrictMode's
   * double-effect mount is exactly this case.
   */
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
    // Sighting is recorded once per logical open of this frozen-evidence key,
    // not per freeze-map admission. React StrictMode mounts under
    // renderer-shell with setup → cleanup(discard) → setup, so the live-map
    // check above alone is not enough - discard clears the key between the
    // two setups and a second admission would inflate "Nth time on this
    // install". The short-TTL recentSightingKeys set survives discard.
    // Fire-and-forget onto the ledger mutation queue: a disk blip must never
    // block freeze / dialog open. The queue is still scheduled synchronously
    // so a later getFingerprintOccurrence (which awaits the queue) sees it.
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
      this.hostLayout.logFile,
    );
    this.setFrozenEvidence(frozenEvidenceKey, { kind: "pending", promise });
    const evidence = await promise;
    // Only commit if this exact in-flight operation is still the current
    // entry for the key. A discard mid-read deletes the entry; a second
    // freeze race installs its own pending entry first. Either way, a late
    // resolution here must not resurrect or overwrite it.
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

  /**
   * Returns true the first time `frozenEvidenceKey` is claimed within the
   * dedupe window; false if a prior claim is still live. Survives discard so
   * StrictMode's discard-between-setups cannot re-claim. A genuine second
   * dialog open uses a new draftId (new key) and claims again.
   */
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

  /**
   * Install-local occurrence info for the dialog's "Nth time on this install"
   * strip. Backed by the report ledger (userData), never renderer localStorage.
   */
  getFingerprintOccurrence(
    fingerprint: string,
  ): Promise<FingerprintOccurrence | null> {
    return getFingerprintOccurrence(fingerprint);
  }

  /** Cancel, or a dialog replacing this draft, drops its frozen evidence. */
  discardFrozenEvidence(frozenEvidenceKey: string): void {
    this.frozenEvidenceByKey.delete(frozenEvidenceKey);
  }

  /**
   * Serves the consent panel's "view" affordance from the frozen tail, not a
   * live read - what the user reviews here is exactly what submit ships.
   */
  async readFrozenLogTail(
    frozenEvidenceKey: string,
    target: SupportLogTarget,
  ): Promise<SupportLogTailResult> {
    const path = this.resolveSupportLogPath(target);
    const frozen = await this.resolveFrozenEvidence(frozenEvidenceKey);
    if (frozen === undefined) {
      return { target, path, lines: [], truncated: false };
    }
    const tail = target === "desktop" ? frozen.desktop : frozen.host;
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
    // Diagnostics toggle gates layer-0/process-metrics/version-platform-host
    // tags+contexts - main computes these itself from its own snapshot, so
    // the renderer omitting `privateDiagnostics` alone can never withhold
    // them; this is the actual gate. `fingerprint`/`correlationId` are never
    // gated by it - they are the report's own identity, not "diagnostics" in
    // the privacy sense, and travel below independent of this flag.
    const includeDiagnostics = form.includeDiagnostics;
    const processMetrics = includeDiagnostics
      ? await handleGetMetrics().catch((err: unknown) => {
          log.error("[support] failed to collect process metrics", { err });
          return null;
        })
      : null;

    // Scrubbed as one composed string, not field-by-field: every piece
    // (intent, location) is user- or error-derived free text, and
    // `scrubSupportText` operates line-wise with no length cap either way, so
    // there is no correctness difference - just one call instead of several.
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

    // G1: identity is attached to the private report only when the user
    // opted in via the contact checkbox - the checkbox itself only renders
    // when a signed-in email exists, but the gate lives here too so a stale
    // client can never smuggle identity past an unchecked box.
    const userEmail = form.allowContact ? snapshot.user.email : null;
    const privateDiagnostics = form.privateDiagnostics;
    // Images ride to Sentry as opaque binary attachments, built directly from
    // `form.images` below - deliberately never folded into `contexts` (the
    // object passed to `deepScrubSupportValue`). The scrubber's deep walk
    // treats a plain object's own enumerable keys as scrubbable fields; an
    // `ArrayBuffer`/`Buffer` handed to it would be walked as if it were a
    // record of numeric-string keys, corrupting the bytes for no privacy
    // benefit (accepted trade-off, ticket 08: the scrubber does not touch
    // image bytes).
    const imageAttachments = sentryAttachmentsForImages(form.images);
    const eventId = sentryEventIdFromReportId(frozen.reportId);
    // Deep-scrubbed as a whole right before it rides in the Sentry event:
    // `layer0.evidence`/`raw` are free text off a filesystem error and can
    // carry absolute paths (host.log is unredacted at source), and
    // `errorCause.stack`/`.message` are exactly the private strings this
    // scrubber exists for. `registry` and `processMetrics` are opaque
    // ids/numbers by contract - scrubbing them is a no-op, not a risk. All of
    // it is diagnostics content, so the whole block is skipped when the
    // consent toggle is off, not just individually omitted per-key.
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
                // Promoted to its own top-level context, NOT nested under
                // `processMetrics` - Sentry normalizes the whole `contexts`
                // object under one shared depth budget (3, its default,
                // unset here), and `processMetrics.appMetrics[i]` sits one
                // level too deep for even a fully-flattened per-process
                // object to survive that budget. Verified against the SDK's
                // actual `normalize()`, not just this file's return value -
                // a live delivered event still showed "[Object]" placeholders
                // after the per-entry flattening alone (round 2 of this fix).
                // One less level of nesting is what actually closes it.
                appMetrics: flattenAppMetricsForSentry(
                  processMetrics.appMetrics,
                ),
              }),
          ...(privateDiagnostics?.cause == null
            ? {}
            : { errorCause: { ...privateDiagnostics.cause } }),
          // D10: the registry's `hostId` is the tab-bound host, which can
          // differ from the "local host" this file attaches logs and
          // version from below - named `registry`, never `host`, so the
          // two can't be read as one.
          ...(privateDiagnostics === undefined
            ? {}
            : { registry: { ...privateDiagnostics.registry } }),
        })
      : {};
    // Registered after context construction but before `captureFeedback`, so
    // the listener is live when the envelope goes out and every later exit is
    // covered by the `finally` below. `afterSendEvent` carries the transport's
    // real response, which `flush` alone cannot distinguish from rejection.
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
            // Sentry's ingest dedupes on `event_id` within a time window,
            // which is what makes a retry idempotent - the reportId's suffix
            // already is a valid 32-hex-char event id (the uuid minus
            // dashes), so reusing it here instead of a per-call id is the
            // whole mechanism.
            event_id: eventId,
            captureContext: {
              tags: {
                // The report's own identity - always attached regardless of
                // the diagnostics toggle (not "diagnostics" in the privacy
                // sense; without it a retry or a support conversation has
                // nothing to key off).
                reportId: frozen.reportId,
                ...(includeDiagnostics
                  ? {
                      appVersion: snapshot.appVersion,
                      platform: `${snapshot.platform}/${snapshot.arch}`,
                      // "local" because it names the traycer-host this
                      // Electron process supervises, not necessarily the
                      // (possibly remote) host a failing tab is bound to -
                      // see the `registry` context.
                      localHostVersion: snapshot.host.version ?? "unknown",
                      electronVersion: snapshot.versions.electron ?? "unknown",
                      layer0Status: layer0StatusTag(snapshot.host.layer0),
                    }
                  : {}),
                ...(privateDiagnostics?.fingerprint == null
                  ? {}
                  : { fingerprint: privateDiagnostics.fingerprint }),
                // Sub-clustering only - deliberately not part of
                // `fingerprint` (a one-frame refactor must not re-identify a
                // defect), and unlike fingerprint/correlationId this IS
                // diagnostics content (stack shape), so it is gated with the
                // rest.
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

      // `flush` resolves false when the queue did not drain inside the
      // timeout. That is not the same as lost - the transport may still
      // deliver it - so this maps to `unconfirmed`, never `failed`; a
      // blanket "failed" would tell users a report failed that in fact
      // arrived.
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
      // The queue draining only means our envelope reached the transport,
      // not that Sentry's store accepted it - a 500 or a destroyed
      // connection drains the queue exactly as cleanly as a real success.
      // Resolve the actual per-event outcome the `afterSendEvent` hook
      // captured before trusting "delivered".
      const outcome = await sendOutcome.awaitOutcome();
      if (outcome !== null && outcome.status === "failed") {
        log.error("[support] sentry rejected the report", {
          reportId: frozen.reportId,
          statusCode: outcome.statusCode,
        });
        return { status: "failed", reason: "error" };
      }
      // Only confirmed deliveries land in the filed-report half of the
      // ledger. unconfirmed/failed/unavailable must not - a phantom entry
      // would inflate later router counts and fixed-in work. Fire-and-
      // forget: ledger failure must not turn a successful upload into a
      // failed submit result.
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

  /**
   * Written on the unavailable path (Flow 4 Case B's "Save diagnostic
   * bundle"). Every private string is scrubbed, and - now that ticket 09's
   * scrubber exists - the bundle gains both frozen log tails (already
   * scrubbed at freeze time, see `captureLogTail`): this is a local file the
   * user can hand to anyone, so nothing in it may ship unscrubbed.
   *
   * Screenshots (`form.images`, ticket 08) are deliberately NOT included:
   * this bundle is a single JSON file, and base64-inlining a few MB of image
   * data into it would bloat an otherwise small diagnostic file for no real
   * benefit - the user already reviewed the thumbnails in the dialog before
   * choosing to save. Not "trivially includable" the way the already-text
   * log tails are.
   */
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
      },
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

  /**
   * `support:buildPublicDraft` (ticket 09 / T6): the single main-process
   * producer of all public (GitHub-bound) text, always behind the deep
   * scrubber. Resolves its own frozen evidence rather than depending on a
   * prior `submitReport` result, so it is callable regardless of delivery
   * outcome (delivered/unconfirmed/unavailable/failed) - including when no
   * submit was ever attempted (Flow 4 Case B's no-DSN "Open a GitHub issue").
   */
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

async function captureFrozenEvidence(
  reportId: string,
  desktopLogPath: string,
  hostLogPath: string,
): Promise<FrozenEvidence> {
  const [desktop, host] = await Promise.all([
    captureLogTail(desktopLogPath, LOG_TAIL_LINES, LOG_ATTACHMENT_MAX_BYTES),
    captureLogTail(hostLogPath, LOG_TAIL_LINES, LOG_ATTACHMENT_MAX_BYTES),
  ]);
  return { reportId, desktop, host };
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
  // Scrub BEFORE the byte cap below, never after: `host.log` is written with
  // zero redaction at source, so this is the only point that ever sees the
  // raw tail. Truncating first could cut a token/path mid-match so the
  // scrubber's regexes miss the remainder, and the byte budget itself must
  // measure what will actually ship (the scrubbed text), not the raw text -
  // ticket 09's "field bounds enforced after scrubbing, never before".
  const scrubbed = scrubSupportText(tail);
  const truncatedByByteCount = Buffer.byteLength(scrubbed, "utf8") > maxBytes;
  return {
    content: truncateToTrailingBytes(scrubbed, maxBytes),
    truncated: truncatedByLineCount || truncatedByByteCount,
  };
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

/**
 * Builds Sentry's `attachments` entries straight from the already-validated
 * `form.images` (ticket 08 / T5) - never routed through `scrubSupportText`
 * or `deepScrubSupportValue`, since both operate on text/JSON, not opaque
 * binary. `support-ipc.ts`'s parser already enforced the MIME allowlist,
 * magic bytes, per-image size, and the total attachment budget, so
 * `reportImageMediaTypeForMimeType` here can never legitimately return
 * `null`; a defensive throw beats silently mislabeling the content type.
 */
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
 * Watches for the real transport outcome of the event `submitReport` is about
 * to send with `eventId`, via the SDK's `afterSendEvent` client hook - the
 * only place the actual HTTP response (status code, or nothing at all on a
 * network-level failure) is available. Must be constructed before
 * `Sentry.captureFeedback` is called, so the listener is live before the send
 * it needs to observe starts.
 *
 * `awaitOutcome` is only meaningful to call once `Sentry.flush` has already
 * reported the queue drained; before that point the outcome legitimately has
 * not happened yet, and `flush`'s own timeout remains the source of truth for
 * `unconfirmed`. `SEND_OUTCOME_GRACE_MS` bounds the case where the hook never
 * fires despite `flush` saying the queue is empty - it resolves `null`, and
 * the caller falls back to `flush`'s own "delivered" determination rather
 * than guessing.
 *
 * Callers must call `unsubscribe` exactly once, on every exit path, whether
 * or not `awaitOutcome` was ever called - otherwise every `submitReport` call
 * leaks one more permanent listener on the shared Sentry client.
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

/**
 * `app.getAppMetrics()` entries carry `cpu`/`memory` as nested sub-objects.
 * Round 1 of this fix flattened each entry to scalar fields, which is
 * necessary but not sufficient: Sentry's SDK normalizes the WHOLE `contexts`
 * object under one shared depth budget (`normalizeDepth`, default 3, unset
 * here), and `contexts.processMetrics.appMetrics[i]` sits one level too deep
 * for even a fully-flattened per-process object to survive it - verified
 * against the SDK's own `normalize()` (not just this function's return
 * value): a live delivered event still showed `appMetrics` as four
 * unusable "[Object]" placeholders after round 1 landed. `appMetrics` is
 * therefore promoted to its own top-level context (a sibling of
 * `processMetrics`, not nested inside it) - one less level of nesting is
 * what actually keeps it inside the budget. This does not raise the SDK's
 * global `normalizeDepth`, which would affect every event the app sends,
 * not just this one.
 */
function flattenAppMetricsForSentry(
  appMetrics: ReadonlyArray<Electron.ProcessMetric>,
): Record<string, unknown> {
  // Spread into a fresh object literal (numeric-string keys: "0", "1", ...)
  // rather than returning the mapped array directly - Sentry's `Contexts`
  // type requires every named context to be a plain record, and the two
  // shapes normalize identically (verified against the SDK's own
  // `normalize()`): depth-counting treats an array and an object the same
  // way, so this is a typing accommodation, not a behavior change.
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
