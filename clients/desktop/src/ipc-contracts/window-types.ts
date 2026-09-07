
import type { Layer0UnavailableCause } from "@traycer/protocol/host/lifecycle/layer0-frame";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

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
  | { readonly ok: true }
  | { readonly ok: false; readonly currentOwner: string };

export interface PerWindowEpicViewTab {
  readonly id: string;
  readonly epicId: string;
  readonly name: string;
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
  | "signed-out"
  | "signing-in"
  | "signed-in";

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

export type DesktopAuthSessionRefusalReason =
  | "malformed-token"
  | "unsupported-algorithm"
  | "unknown-signing-key"
  | "key-source-unavailable"
  | "bad-signature"
  | "expired"
  | "issuer-mismatch"
  | "audience-mismatch"
  | "subject-mismatch";

export type DesktopAuthSessionSetResult =
  | { readonly outcome: "accepted" }
  | {
      readonly outcome: "refused";
      readonly reason: DesktopAuthSessionRefusalReason;
    };

export type OpenEpicInNewWindowResult =
  | { readonly result: "focused"; readonly windowId: string }
  | { readonly result: "moved"; readonly windowId: string }
  | { readonly result: "queued-discard"; readonly windowId: string };

export type OpenDraftInNewWindowResult =
  | { readonly result: "moved"; readonly windowId: string }
  | { readonly result: "not-found"; readonly windowId: string };

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

// Unlike `desktop`/`host`, absence of the trace file is the normal production state, so every consumer of this target must go through the existence-filtered `SupportSnapshot.logs`.
export type SupportLogTarget =
  | "desktop"
  | "host"
  | "browserTelemetry"
  | "browserTrace";

export type SupportLinkId =
  | "website"
  | "documentation"
  | "release-notes"
  | "discord"
  | "support";

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

/** The record stays declared at the IPC boundary, while its cause comes from the protocol owner so additions cannot silently drift into a string-shaped desktop copy. */
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
  /** Absence must never render as "guaranteed". */
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
  readonly privateDeliveryAvailable: boolean;
}

export interface SupportRevealLogResult {
  readonly target: SupportLogTarget;
  readonly path: string;
}

/** Structured private cause, allowlisted onto the wire field by field so an error boundary can never smuggle an arbitrary object past this contract. */
export interface SupportPrivateDiagnosticsCause {
  readonly type: string;
  readonly message: string;
  readonly stack: string | null;
  readonly componentStack: string | null;
  readonly errorCode: string | null;
  readonly sourceAction: string | null;
  readonly timestamp: number;
}

/** `known` is fresh; `stale` is a prior value the write side no longer confirms live (e.g. provider state read before the host went unreachable) - never silently reported as current. */
export type SupportCapturedField<T> =
  | { readonly status: "known"; readonly value: T }
  | { readonly status: "stale"; readonly value: T }
  | { readonly status: "unavailable" };

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

export interface SupportPrivateDiagnostics {
  readonly cause: SupportPrivateDiagnosticsCause | null;
  readonly registry: SupportContextRegistrySnapshot;
  readonly fingerprint: string | null;
  readonly stackFamily: string | null;
  readonly correlationId: string;
}

export type SupportReportType = "bug" | "idea" | "other";

export type SupportReportFrequency =
  | "once"
  | "sometimes"
  | "every_time"
  | "not_sure";

/** One attached screenshot, crossing IPC as a raw byte array (never base64 - ticket 08 / T5) so no string-encoding step ever touches image content. */
export interface SupportImageAttachmentInput {
  readonly fileName: string;
  readonly mimeType: string;
  readonly bytes: ArrayBuffer;
}

// "none" covers both "never attempted" (no-DSN Case B) and a definite `failed` result: neither left anything on the Sentry side to reference, so both get the same honest "nothing to.
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
  readonly location: string | null;
  readonly allowContact: boolean;
  readonly includeDesktopLog: boolean;
  readonly includeHostLog: boolean;
  readonly includeBrowserDiagnostics: boolean;
  // The report's own identity (reportId, fingerprint, correlationId) is never gated by this - it is not "diagnostics" in the privacy sense.
  readonly includeDiagnostics: boolean;
  readonly images: readonly SupportImageAttachmentInput[];
  readonly overrideTitle: string | null;
  // Lets the builder phrase the report-ID reference and the repro/proposal placeholder honestly per route, and omit the screenshot-count line entirely when nothing was ever privately.
  readonly privateOutcome: SupportPrivateOutcome;
  readonly privateDiagnostics?: SupportPrivateDiagnostics;
}

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
  readonly fingerprint: string | null;
}

export interface SupportFreezeEvidenceResult {
  // Minted once per draft, at freeze time - not per submit call. Every retry
  // (T2) and the GitHub fallback prefill reuse this same id.
  readonly reportId: string;
}

/** Powers the dialog's "Nth time on this install" strip - never a cross-device / per-account count. */
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

export interface SupportBugReportDraftFields {
  readonly "what-happened": string;
  readonly version: string;
  readonly os: string;
  readonly component: string;
  readonly repro: string;
}

export interface SupportFeatureRequestDraftFields {
  readonly problem: string;
  readonly proposal: string;
  readonly alternatives: string;
  readonly component: string;
}

export interface SupportGeneralDraftFields {
  readonly details: string;
}

export type SupportBuildPublicDraftResult =
  | {
      readonly template: "bug_report.yml";
      readonly title: string;
      readonly fields: SupportBugReportDraftFields;
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
