/**
 * Plain-data mirrors for desktop-only multi-window bridges. These types are
 * intentionally kept out of the shared `IRunnerHost` contract; desktop
 * renderers feature-detect `window.runnerHost.windows` before using them.
 */

import type { Layer0UnavailableCause } from "@traycer/protocol/host/lifecycle/layer0-frame";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface WindowSummary {
  readonly windowId: string;
  readonly title: string;
  readonly isFocused: boolean;
  readonly isVisible: boolean;
}

export interface OwnershipEntry {
  readonly tabId: string;
  readonly epicId: string;
  readonly windowId: string;
}

export type OwnershipClaimResult =
  { readonly ok: true } | { readonly ok: false; readonly currentOwner: string };

export interface PerWindowEpicViewTab {
  readonly id: string;
  readonly epicId: string;
  readonly name: string;
  /**
   * Persisted presentation mode for a tab. Older snapshots intentionally omit
   * this and the renderer restores them as the normal Epic surface.
   */
  readonly surfaceMode?:
    | { readonly kind: "epic" }
    | { readonly kind: "phase-migration"; readonly phaseId: string };
}

export type PerWindowStateFeature = "tab-strip-layout-v2" | "active-route-v1";

/** Main-owned feature declaration. Never infer support from bridge presence. */
export interface PerWindowStateCapabilities {
  readonly schemaVersion: number;
  readonly features: readonly PerWindowStateFeature[];
}

/** Returned only by a main process that durably accepted the patch. */
export interface PerWindowStateUpdateAcknowledgement {
  readonly capabilities: PerWindowStateCapabilities;
  readonly revision: number;
}

export interface PerWindowLandingDraft {
  readonly id: string;
  /**
   * Full editor JSON (hash-only image nodes, no base64), carried opaquely as
   * `JsonValue`. The renderer validates the doc shape on parse.
   */
  readonly content: JsonValue;
  /** Cursor position (from/to) as opaque JSON; renderer parses it back. */
  readonly selection: JsonValue | null;
  /** Last content/selection edit time; drives renderer-side LRU eviction. */
  readonly lastTouchedAt: number;
  readonly settings: JsonValue | null;
  readonly composerMode: string | null;
  readonly workspace: JsonValue | null;
}

export interface PerWindowSnapshot {
  /** Monotonic, per-window persisted revision. Legacy snapshots begin at 0. */
  readonly revision?: number;
  readonly epicTabs: readonly PerWindowEpicViewTab[];
  readonly activeTabId: string | null;
  readonly canvasByTabId: Readonly<Record<string, JsonValue>>;
  readonly landingDrafts: readonly PerWindowLandingDraft[];
  readonly activeLandingDraftId: string | null;
  /** Opaque renderer-owned JSON for the version-2 tab strip. */
  readonly tabStripLayout?: JsonValue | null;
  /** Last accepted app-relative route, paired atomically with tabStripLayout. */
  readonly activeRoute?: string | null;
}

export interface PerWindowStatePatch {
  readonly epicTabs?: readonly PerWindowEpicViewTab[];
  readonly activeTabId?: string | null;
  readonly canvasByTabId?: Readonly<Record<string, JsonValue>>;
  readonly landingDrafts?: readonly PerWindowLandingDraft[];
  readonly activeLandingDraftId?: string | null;
  readonly tabStripLayout?: JsonValue | null;
  readonly activeRoute?: string | null;
}

export type DesktopAuthSessionStatus =
  "signed-out" | "signing-in" | "signed-in";

export interface DesktopAuthSessionProfile {
  readonly userId: string;
  readonly userName: string;
  readonly email: string;
}

export interface DesktopAuthSessionSnapshot {
  readonly status: DesktopAuthSessionStatus;
  readonly token: string | null;
  readonly profile: DesktopAuthSessionProfile | null;
}

export type OpenEpicInNewWindowResult =
  | { readonly result: "focused"; readonly windowId: string }
  | { readonly result: "moved"; readonly windowId: string }
  | { readonly result: "queued-discard"; readonly windowId: string };

export type MenuCommandId =
  | "app.openSettings"
  | "app.signIn"
  | "app.signOut"
  | "app.checkForUpdates"
  | "app.openLogs"
  | "app.about"
  | "app.aboutDetails"
  | "app.reportIssue"
  | "app.quit"
  | "host.restart"
  | "host.installUpdate"
  | "epic.newWindow"
  | "epic.openInNewWindow"
  | "epic.closeTab"
  | "view.zoomIn"
  | "view.zoomOut"
  | "view.resetZoom"
  | "window.minimizeWindow"
  | "window.zoomWindow"
  | "window.closeWindow"
  | "view.findInPage"
  | "view.findNext"
  | "view.findPrevious";

/**
 * Top-level application menus rendered by the Windows frameless title bar.
 * The native Electron menu remains the command/state authority; the renderer
 * sends one of these ids only to ask main to open the matching submenu.
 */
export const DESKTOP_TOP_LEVEL_MENU_IDS = [
  "file",
  "edit",
  "view",
  "window",
  "help",
] as const;

export type DesktopTopLevelMenuId = (typeof DESKTOP_TOP_LEVEL_MENU_IDS)[number];

export type DesktopRuntimePlatform = "darwin" | "win32" | "linux";

export function desktopTopLevelMenuItemId(
  menuId: DesktopTopLevelMenuId,
): string {
  return `traycer.top-level-menu.${menuId}`;
}

export function isDesktopTopLevelMenuId(
  value: unknown,
): value is DesktopTopLevelMenuId {
  return DESKTOP_TOP_LEVEL_MENU_IDS.some((menuId) => menuId === value);
}

export interface MenuCommandPayload {
  readonly command: MenuCommandId;
  readonly windowId: string;
}

export type SupportLogTarget = "desktop" | "host";

export type SupportLinkId =
  "website" | "documentation" | "release-notes" | "discord" | "support";

export interface SupportLinkDescriptor {
  readonly id: SupportLinkId;
  readonly label: string;
  readonly url: string;
}

export interface SupportLogDescriptor {
  readonly target: SupportLogTarget;
  readonly label: string;
  readonly path: string;
}

/**
 * Plain-data mirror of `DesktopHostLayer0Record`
 * (`electron-main/host/host-state.ts`). The record stays declared at the IPC
 * boundary, while its cause comes from the protocol owner so additions cannot
 * silently drift into a string-shaped desktop copy.
 */
export type SupportHostLayer0Snapshot =
  | { readonly status: "acquired"; readonly attemptId: string }
  | {
      readonly status: "degraded";
      readonly attemptId: string;
      readonly cause: Layer0UnavailableCause;
      readonly evidence: string;
    }
  | { readonly status: "unrecognized"; readonly raw: string };

export interface SupportHostSnapshot {
  readonly status: "ready" | "starting";
  readonly version: string | null;
  readonly pid: number | null;
  readonly hostId: string | null;
  /**
   * The host's Layer 0 single-writer verdict, or `null` when it is not
   * known - either no host is running, or its `pid.json` predates the
   * field. Absence must never render as "guaranteed".
   */
  readonly layer0: SupportHostLayer0Snapshot | null;
}

export interface SupportRuntimeVersions {
  readonly electron: string;
  readonly chrome: string;
  readonly node: string;
}

export interface SupportUserSnapshot {
  readonly status: DesktopAuthSessionStatus;
  readonly userName: string | null;
  readonly email: string | null;
}

export interface SupportSnapshot {
  readonly appName: string;
  readonly appVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly user: SupportUserSnapshot;
  readonly versions: SupportRuntimeVersions;
  readonly host: SupportHostSnapshot;
  readonly logs: readonly SupportLogDescriptor[];
  readonly links: readonly SupportLinkDescriptor[];
  readonly supportEmail: string;
  // DSN presence, known at startup. `submitReport` can still resolve to
  // "unavailable" without this (e.g. Sentry client init failed), but this is
  // the preflight signal the dialog uses to set expectations before the user
  // invests effort writing a report.
  readonly privateDeliveryAvailable: boolean;
}

export interface SupportRevealLogResult {
  readonly target: SupportLogTarget;
  readonly path: string;
}

/**
 * Structured private cause, allowlisted onto the wire field by field so an
 * error boundary can never smuggle an arbitrary object past this contract.
 * Field-for-field match with ticket 05's `PrivateErrorCause`
 * (`clients/gui-app/src/lib/report-issue-draft-context.ts`).
 */
export interface SupportPrivateDiagnosticsCause {
  readonly type: string;
  readonly message: string;
  readonly stack: string | null;
  readonly componentStack: string | null;
  readonly errorCode: string | null;
  readonly sourceAction: string | null;
  readonly timestamp: number;
}

/**
 * One captured field's availability. `known` is fresh; `stale` is a prior
 * value the write side no longer confirms live (e.g. provider state read
 * before the host went unreachable) - never silently reported as current;
 * `unavailable` means never observed this session. Mirrors ticket 05's
 * `CapturedField<T>` (`clients/gui-app/src/lib/support-context-registry.ts`).
 */
export type SupportCapturedField<T> =
  | { readonly status: "known"; readonly value: T }
  | { readonly status: "stale"; readonly value: T }
  | { readonly status: "unavailable" };

/**
 * Last-known session state (ticket 05's support-context registry). Every
 * field is opaque (ids, not full URLs/paths); `hostId` here is the tab-bound
 * host, which is not necessarily the same host `submitReport` attaches logs
 * from (see the "local host" labeling in `support.ts` - D10).
 * Field-for-field match with ticket 05's `SupportContextSnapshot`.
 */
export interface SupportContextRegistrySnapshot {
  readonly routeTemplate: SupportCapturedField<string>;
  readonly hostId: SupportCapturedField<string>;
  readonly epicId: SupportCapturedField<string>;
  readonly tabId: SupportCapturedField<string>;
  readonly artifactId: SupportCapturedField<string>;
  readonly chatId: SupportCapturedField<string>;
  readonly agentId: SupportCapturedField<string>;
  readonly harnessId: SupportCapturedField<string>;
  readonly model: SupportCapturedField<string>;
  /** `null` value = ambient/host login, distinct from `unavailable`. */
  readonly profileId: SupportCapturedField<string | null>;
  readonly providerSelectionClass: SupportCapturedField<
    "bundled" | "path" | "custom"
  >;
  /** `null` value = version not yet probed, distinct from `unavailable`. */
  readonly providerVersion: SupportCapturedField<string | null>;
}

/**
 * Wire mirror of ticket 05's `SerializedReportIssuePrivateDiagnostics`
 * (`serializeReportIssuePrivateDiagnostics` in
 * `report-issue-draft-context.ts`) - same five keys, always all present when
 * this object is sent at all: `registry` is never itself absent (an "empty"
 * session is all-`unavailable` fields, not a missing registry), and
 * `correlationId` is always a fresh id minted at draft-open.
 */
export interface SupportPrivateDiagnostics {
  readonly cause: SupportPrivateDiagnosticsCause | null;
  readonly registry: SupportContextRegistrySnapshot;
  readonly fingerprint: string | null;
  /**
   * Normalized stack frame family, for maintainer-side sub-clustering ONLY -
   * deliberately NOT part of `fingerprint`'s identity, so a one-frame
   * refactor can't re-identify a defect.
   */
  readonly stackFamily: string | null;
  readonly correlationId: string;
}

// Ticket 07 (T4): "bug" routes to bug_report.yml, "idea" to
// feature_request.yml, "other" (Flow 2's "Something else") to general.yml -
// see `SupportBuildPublicDraftResult` and `issue-reporter.ts`.
export type SupportReportType = "bug" | "idea" | "other";

export type SupportReportFrequency =
  "once" | "sometimes" | "every_time" | "not_sure";

/**
 * One attached screenshot, crossing IPC as a raw byte array (never base64 -
 * ticket 08 / T5) so no string-encoding step ever touches image content.
 * `mimeType` is the browser-reported `File.type` at attach time; Electron
 * main revalidates it against the actual bytes (magic-byte check) rather
 * than trusting it - see `support-ipc.ts`'s `parseSupportImageAttachments`.
 */
export interface SupportImageAttachmentInput {
  readonly fileName: string;
  readonly mimeType: string;
  readonly bytes: ArrayBuffer;
}

// What (if anything) actually reached the private channel for this draft, as
// known by the RENDERER at the moment it asks main to build a public draft -
// main has no memory of a prior `submitReport` call, so this travels on the
// wire each time. "none" covers both "never attempted" (no-DSN Case B) and a
// definite `failed` result: neither left anything on the Sentry side to
// reference, so both get the same honest "nothing to point at" treatment in
// `buildPublicDraftFields`.
export type SupportPrivateOutcome = "delivered" | "unconfirmed" | "none";

export interface SupportSubmitReportRequest {
  // Keys the frozen evidence (both log tails + the report id minted at
  // report-open) that `submitReport` and every retry must reuse.
  readonly draftId: number;
  readonly type: SupportReportType;
  // The single required question ("What were you trying to do?"). Replaces
  // the killed title/whatHappened/stepsToReproduce/expected/actual fields.
  readonly intent: string;
  // D9: null when left unselected (default) or hidden because the ledger
  // already knows the repeat count - never a synthesized default.
  readonly frequency: SupportReportFrequency | null;
  // D7: the "Where did this happen?" selector (manual bug opens only). Only
  // ever non-null when the user actively changed it away from its pre-filled
  // default - the untouched pre-filled value must never reach the wire, so
  // there is no separate "changed" flag to get out of sync with this.
  readonly location: string | null;
  // G1: identity (email/name) is attached to the private report only when
  // this is true. The checkbox itself only renders when a signed-in email
  // exists, but the flag is always sent explicitly rather than inferred from
  // email presence on the main-process side.
  readonly allowContact: boolean;
  // Consent panel's two log toggles (default on): whether each frozen tail
  // is attached to the private submission / included in the diagnostic
  // bundle. A toggle that visually turns "off" but keeps shipping the log
  // regardless would be exactly the dishonest-consent pattern this redesign
  // exists to remove.
  readonly includeDesktopLog: boolean;
  readonly includeHostLog: boolean;
  // Consent panel's diagnostics toggle: gates layer-0, process metrics,
  // version/platform/host tags+contexts, and provider info on BOTH the
  // Sentry event and the diagnostic bundle's environment block - not just
  // whether `privateDiagnostics` happens to be attached below (main computes
  // layer0/processMetrics itself from its own snapshot, independent of what
  // the renderer sends, so gating had to live on this side too). The report's
  // own identity (reportId, fingerprint, correlationId) is never gated by
  // this - it is not "diagnostics" in the privacy sense.
  readonly includeDiagnostics: boolean;
  // Up to 3 screenshots (ticket 08 / T5), already gated by the renderer's
  // attach-time checks - always present (empty array when none attached),
  // matching `frequency`/`location`'s "always on the wire" contract so a
  // missing key is a parser violation, not an omitted optional.
  readonly images: readonly SupportImageAttachmentInput[];
  // `buildPublicDraft`-only (ignored by `submitReport`/`saveDiagnosticBundle`,
  // shared here per the one-contract rule). Null on the initial preview
  // fetch (title is derived normally); the user's as-typed preview-title
  // edit on every subsequent "Open GitHub draft" - main re-scrubs and
  // re-fits it through the same budget pipeline as a derived title, since
  // `issue-reporter.ts` is assembly-only and must never see raw user text.
  readonly overrideTitle: string | null;
  // `buildPublicDraft`-only (ignored by `submitReport`/`saveDiagnosticBundle`).
  // Lets the builder phrase the report-ID reference and the repro/proposal
  // placeholder honestly per route, and omit the screenshot-count line
  // entirely when nothing was ever privately uploaded.
  readonly privateOutcome: SupportPrivateOutcome;
  readonly privateDiagnostics?: SupportPrivateDiagnostics;
}

// Four states, not three: "no DSN" and "flush timed out" used to collapse
// onto the same `reportId: null`, which told users a report failed when it
// may have arrived, and let a retry mint a duplicate. `failed` is reserved
// for definite non-delivery (capture threw, DSN rejected); a flush timeout
// maps to `unconfirmed`, never `failed` - the transport may still deliver it.
export type SupportSubmitReportResult =
  | { readonly status: "delivered"; readonly reportId: string }
  | { readonly status: "unconfirmed"; readonly reportId: string }
  | { readonly status: "unavailable" }
  | { readonly status: "failed"; readonly reason: "error" };

export interface SupportLogTailResult {
  readonly target: SupportLogTarget;
  readonly path: string;
  readonly lines: readonly string[];
  readonly truncated: boolean;
}

export interface SupportFreezeEvidenceInput {
  readonly draftId: number;
  /**
   * Client-side defect fingerprint (`fp:v1:...`) when known at report-open.
   * A non-null value records an install-local *sighting* (distinct from a
   * filed report) so the dialog can show "Nth time on this install". Null
   * for manual opens with no error envelope.
   */
  readonly fingerprint: string | null;
}

export interface SupportFreezeEvidenceResult {
  // Minted once per draft, at freeze time - not per submit call. Every retry
  // (T2) and the GitHub fallback prefill reuse this same id.
  readonly reportId: string;
}

/**
 * Install-local occurrence of a fingerprint from the per-install report
 * ledger. Powers the dialog's "Nth time on this install" strip - never a
 * cross-device / per-account count.
 */
export interface SupportFingerprintOccurrence {
  readonly firstSeen: number;
  readonly lastSeen: number;
  readonly count: number;
}

export interface SupportReadFrozenLogTailInput {
  readonly draftId: number;
  readonly target: SupportLogTarget;
}

export interface SupportSaveDiagnosticBundleResult {
  readonly path: string;
}

/**
 * Per-field values for the GitHub issue form (ticket 01's mapping,
 * `.github/ISSUE_TEMPLATE/bug_report.yml`). Keys match the form's field ids
 * verbatim so `issue-reporter.ts` can assemble `URLSearchParams` straight
 * from this object with zero composition of its own.
 */
export interface SupportBugReportDraftFields {
  readonly "what-happened": string;
  readonly version: string;
  readonly os: string;
  readonly component: string;
  readonly repro: string;
}

/**
 * Per-field values for `.github/ISSUE_TEMPLATE/feature_request.yml`
 * ("idea" reports, ticket 07's type-chip routing). Field ids verbatim.
 */
export interface SupportFeatureRequestDraftFields {
  readonly problem: string;
  readonly proposal: string;
  readonly alternatives: string;
  readonly component: string;
}

/**
 * Per-field values for `.github/ISSUE_TEMPLATE/general.yml` ("something
 * else" reports, ticket 07's type-chip routing). Field id verbatim.
 */
export interface SupportGeneralDraftFields {
  readonly details: string;
}

/**
 * Response of `support:buildPublicDraft` (ticket 09 / T6, extended by
 * ticket 07's type-to-template routing): the single main-process producer of
 * all public text, always behind the deep scrubber, callable regardless of
 * delivery outcome (delivered/unconfirmed/unavailable/failed) since it
 * resolves its own frozen evidence rather than depending on a prior
 * `submitReport` result. `template` names the GitHub issue-form file the
 * fields target - a discriminated union rather than one fixed field shape,
 * since bug/idea/other route to forms with different field ids entirely.
 */
export type SupportBuildPublicDraftResult =
  | {
      readonly template: "bug_report.yml";
      readonly title: string;
      readonly fields: SupportBugReportDraftFields;
      // True if any field was shortened to fit the GitHub issue form URL's
      // 8 KiB budget (see `support-public-draft.ts`) - surfaced so the
      // preview can say so, alongside the inline truncation marker the
      // shortened field carries.
      readonly truncated: boolean;
    }
  | {
      readonly template: "feature_request.yml";
      readonly title: string;
      readonly fields: SupportFeatureRequestDraftFields;
      readonly truncated: boolean;
    }
  | {
      readonly template: "general.yml";
      readonly title: string;
      readonly fields: SupportGeneralDraftFields;
      readonly truncated: boolean;
    };
