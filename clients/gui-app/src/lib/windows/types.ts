import type {
  GlobalShortcutId,
  GlobalShortcutIntent,
  GlobalShortcutStatus,
} from "@traycer-clients/shared/keybindings/global-shortcuts";

export type {
  GlobalShortcutId,
  GlobalShortcutIntent,
  GlobalShortcutStatus,
} from "@traycer-clients/shared/keybindings/global-shortcuts";
import type { HostControllerStatus } from "@traycer-clients/shared/platform/runner-host";

export type DesktopJsonPrimitive = string | number | boolean | null;
export type DesktopJsonValue =
  | DesktopJsonPrimitive
  | readonly DesktopJsonValue[]
  | { readonly [key: string]: DesktopJsonValue };

export interface DesktopWindowSummary {
  readonly windowId: string;
  readonly title: string;
  readonly isFocused: boolean;
  readonly isVisible: boolean;
}

export interface DesktopOwnershipEntry {
  readonly tabId: string;
  readonly epicId: string;
  readonly windowId: string;
}

export type DesktopOwnershipClaimResult =
  { readonly ok: true } | { readonly ok: false; readonly currentOwner: string };

export interface DesktopPerWindowEpicViewTab {
  readonly id: string;
  readonly epicId: string;
  readonly name: string;
  readonly surfaceMode?:
    | { readonly kind: "epic" }
    | { readonly kind: "phase-migration"; readonly phaseId: string };
}

export type DesktopPerWindowStateFeature =
  "tab-strip-layout-v2" | "active-route-v1";

export interface DesktopPerWindowStateCapabilities {
  readonly schemaVersion: number;
  readonly features: readonly DesktopPerWindowStateFeature[];
}

export interface DesktopPerWindowStateUpdateAcknowledgement {
  readonly capabilities: DesktopPerWindowStateCapabilities;
  readonly revision: number;
}

export interface DesktopPerWindowLandingDraft {
  readonly id: string;
  /**
   * Full editor JSON (hash-only image nodes, no base64). Crosses the IPC
   * boundary as opaque `DesktopJsonValue`; validated on parse, not via casts.
   */
  readonly content: DesktopJsonValue;
  /** Cursor position (from/to) as opaque JSON; parsed back to `{from,to}|null`. */
  readonly selection: DesktopJsonValue | null;
  /** Last content/selection edit time; drives LRU eviction on the renderer. */
  readonly lastTouchedAt: number;
  readonly settings: DesktopJsonValue | null;
  readonly composerMode: string | null;
  readonly workspace: DesktopJsonValue | null;
}

export interface DesktopPerWindowSnapshot {
  readonly revision?: number;
  readonly epicTabs: readonly DesktopPerWindowEpicViewTab[];
  readonly activeTabId: string | null;
  readonly canvasByTabId: Readonly<Record<string, DesktopJsonValue>>;
  readonly landingDrafts: readonly DesktopPerWindowLandingDraft[];
  readonly activeLandingDraftId: string | null;
  readonly tabStripLayout?: DesktopJsonValue | null;
  readonly activeRoute?: string | null;
}

export interface DesktopPerWindowStatePatch {
  readonly epicTabs?: readonly DesktopPerWindowEpicViewTab[];
  readonly activeTabId?: string | null;
  readonly canvasByTabId?: Readonly<Record<string, DesktopJsonValue>>;
  readonly landingDrafts?: readonly DesktopPerWindowLandingDraft[];
  readonly activeLandingDraftId?: string | null;
  readonly tabStripLayout?: DesktopJsonValue | null;
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

export type DesktopOpenEpicInNewWindowResult =
  | { readonly result: "focused"; readonly windowId: string }
  | { readonly result: "moved"; readonly windowId: string }
  | { readonly result: "queued-discard"; readonly windowId: string };

export type DesktopMenuCommandId =
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
  | "window.closeWindow"
  | "view.findInPage"
  | "view.findNext"
  | "view.findPrevious";

export interface DesktopMenuCommandPayload {
  readonly command: DesktopMenuCommandId;
  readonly windowId: string;
}

export type DesktopTopLevelMenuId =
  "file" | "edit" | "view" | "window" | "help";

export interface DesktopZoomBridge {
  readonly ladder: readonly number[];
  get(): Promise<number>;
  set(percent: number): Promise<number>;
  stepIn(): Promise<number>;
  stepOut(): Promise<number>;
  reset(): Promise<number>;
  onChange(handler: (percent: number) => void): { dispose: () => void };
}

export type DesktopSupportLogTarget = "desktop" | "host";

export type DesktopSupportLinkId =
  "website" | "documentation" | "release-notes" | "discord" | "support";

export interface DesktopSupportLinkDescriptor {
  readonly id: DesktopSupportLinkId;
  readonly label: string;
  readonly url: string;
}

export interface DesktopSupportLogDescriptor {
  readonly target: DesktopSupportLogTarget;
  readonly label: string;
  readonly path: string;
}

export interface DesktopSupportSnapshot {
  readonly appName: string;
  readonly appVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly user: {
    readonly status: DesktopAuthSessionStatus;
    readonly userName: string | null;
    readonly email: string | null;
  };
  readonly versions: {
    readonly electron: string;
    readonly chrome: string;
    readonly node: string;
  };
  readonly host: {
    readonly status: "ready" | "starting";
    readonly version: string | null;
    readonly pid: number | null;
    readonly hostId: string | null;
  };
  readonly logs: readonly DesktopSupportLogDescriptor[];
  readonly links: readonly DesktopSupportLinkDescriptor[];
  readonly supportEmail: string;
  readonly privateDeliveryAvailable: boolean;
}

export interface DesktopSupportRevealLogResult {
  readonly target: DesktopSupportLogTarget;
  readonly path: string;
}

export interface DesktopSupportLogTailResult {
  readonly target: DesktopSupportLogTarget;
  readonly path: string;
  readonly lines: readonly string[];
  readonly truncated: boolean;
}

export interface DesktopSupportFreezeEvidenceInput {
  readonly draftId: number;
  /**
   * Client-side defect fingerprint when known at report-open. Non-null
   * records an install-local sighting for "Nth time on this install".
   */
  readonly fingerprint: string | null;
}

export interface DesktopSupportFreezeEvidenceResult {
  readonly reportId: string;
}

/**
 * Install-local occurrence of a fingerprint. Copy must say "on this install".
 */
export interface DesktopFingerprintOccurrence {
  readonly firstSeen: number;
  readonly lastSeen: number;
  readonly count: number;
}

export interface DesktopSupportReadFrozenLogTailInput {
  readonly draftId: number;
  readonly target: DesktopSupportLogTarget;
}

export interface DesktopSupportSaveDiagnosticBundleResult {
  readonly path: string;
}

/**
 * Field-for-field match with ticket 09's `SupportBugReportDraftFields`
 * (`ipc-contracts/window-types.ts`). Keys match the GitHub issue form's field
 * ids verbatim so `buildGitHubIssueUrl` (`@traycer-clients/shared/support/
 * issue-reporter`) can assemble `URLSearchParams` straight from this object.
 */
export interface DesktopSupportBugReportDraftFields {
  readonly "what-happened": string;
  readonly version: string;
  readonly os: string;
  readonly component: string;
  readonly repro: string;
}

/** Field-for-field match with ticket 07's `SupportFeatureRequestDraftFields`. */
export interface DesktopSupportFeatureRequestDraftFields {
  readonly problem: string;
  readonly proposal: string;
  readonly alternatives: string;
  readonly component: string;
}

/** Field-for-field match with ticket 07's `SupportGeneralDraftFields`. */
export interface DesktopSupportGeneralDraftFields {
  readonly details: string;
}

/**
 * Result of `support.buildPublicDraft`: the single main-process producer of
 * all public text, always behind the deep scrubber. Field-for-field match
 * with ticket 09/07's `SupportBuildPublicDraftResult` - a discriminated union
 * since bug/idea/other route to GitHub issue forms with different field ids.
 */
export type DesktopSupportBuildPublicDraftResult =
  | {
      readonly template: "bug_report.yml";
      readonly title: string;
      readonly fields: DesktopSupportBugReportDraftFields;
      readonly truncated: boolean;
    }
  | {
      readonly template: "feature_request.yml";
      readonly title: string;
      readonly fields: DesktopSupportFeatureRequestDraftFields;
      readonly truncated: boolean;
    }
  | {
      readonly template: "general.yml";
      readonly title: string;
      readonly fields: DesktopSupportGeneralDraftFields;
      readonly truncated: boolean;
    };

/**
 * Field-for-field match with ticket 05's `PrivateErrorCause`
 * (`@/lib/report-issue-draft-context`).
 */
export interface DesktopPrivateDiagnosticsCause {
  readonly type: string;
  readonly message: string;
  readonly stack: string | null;
  readonly componentStack: string | null;
  readonly errorCode: string | null;
  readonly sourceAction: string | null;
  readonly timestamp: number;
}

/**
 * Mirrors ticket 05's `CapturedField<T>` (`@/lib/support-context-registry`):
 * `known` is fresh, `stale` is a prior value no longer confirmed live,
 * `unavailable` means never observed this session.
 */
export type DesktopCapturedField<T> =
  | { readonly status: "known"; readonly value: T }
  | { readonly status: "stale"; readonly value: T }
  | { readonly status: "unavailable" };

/**
 * Field-for-field match with ticket 05's `SupportContextSnapshot`
 * (`@/lib/support-context-registry`). `hostId` here is the tab-bound host,
 * not necessarily the "local host" Electron main attaches logs from.
 */
export interface DesktopContextRegistrySnapshot {
  readonly routeTemplate: DesktopCapturedField<string>;
  readonly hostId: DesktopCapturedField<string>;
  readonly epicId: DesktopCapturedField<string>;
  readonly tabId: DesktopCapturedField<string>;
  readonly artifactId: DesktopCapturedField<string>;
  readonly chatId: DesktopCapturedField<string>;
  readonly agentId: DesktopCapturedField<string>;
  readonly harnessId: DesktopCapturedField<string>;
  readonly model: DesktopCapturedField<string>;
  readonly profileId: DesktopCapturedField<string | null>;
  readonly providerSelectionClass: DesktopCapturedField<
    "bundled" | "path" | "custom"
  >;
  readonly providerVersion: DesktopCapturedField<string | null>;
}

/**
 * Wire mirror of ticket 05's `SerializedReportIssuePrivateDiagnostics`
 * (`serializeReportIssuePrivateDiagnostics` in
 * `@/lib/report-issue-draft-context`) - same five keys, always all present:
 * `registry` is never itself absent, `correlationId` is always a fresh id.
 */
export interface DesktopPrivateDiagnostics {
  readonly cause: DesktopPrivateDiagnosticsCause | null;
  readonly registry: DesktopContextRegistrySnapshot;
  readonly fingerprint: string | null;
  /**
   * Normalized stack frame family, for maintainer-side sub-clustering ONLY -
   * deliberately NOT part of `fingerprint`'s identity.
   */
  readonly stackFamily: string | null;
  readonly correlationId: string;
}

export interface DesktopMenuBridge {
  onCommand(handler: (payload: DesktopMenuCommandPayload) => void): {
    dispose(): void;
  };
}

export interface DesktopMenuPopupBridge {
  openTopLevel(
    menuId: DesktopTopLevelMenuId,
    anchorX: number,
    anchorY: number,
  ): Promise<void>;
}

export type DesktopAppUpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "error"
  | "up-to-date"
  | "unavailable";

export type DesktopAppUpdateCheckIntent = "automatic" | "manual";

// Linux deb/rpm only: shown when a privileged install can't be applied for
// the user automatically (WSL, or an install the package manager doesn't own
// at the path we're running from) and the renderer needs actual steps to
// follow, not just a tooltip label. `command` is the exact shell command to
// run against the file already downloaded to `installerPath`-equivalent
// storage; null only if guidance is somehow requested before a download
// completed.
export interface DesktopAppUpdateGuidance {
  readonly summary: string;
  readonly steps: readonly string[];
  readonly command: string | null;
  readonly releaseUrl: string;
}

export interface DesktopAppUpdateSnapshot {
  readonly sequence: number;
  readonly status: DesktopAppUpdateStatus;
  readonly currentVersion: string;
  readonly allowPrerelease: boolean;
  readonly latestVersion: string | null;
  // Whole-percent download progress (0-100) while `status` is "downloading";
  // null in every other state (including before a user-initiated download).
  readonly downloadProgress: number | null;
  // Non-null when updates can't be installed from the current location (macOS
  // app running outside /Applications). Carries the user-facing reason; the
  // renderer disables the download affordance and shows it as a tooltip.
  readonly installBlockedReason: string | null;
  // Non-null when a Linux deb/rpm install needs a manual step to finish
  // (see `DesktopAppUpdateGuidance`). Unlike `installBlockedReason`, the
  // renderer keeps the download/restart affordance clickable and opens a
  // dialog with the steps instead of disabling it - the update can still be
  // applied, just not fully automatically.
  readonly installGuidance: DesktopAppUpdateGuidance | null;
  // True from the moment the main process hands off to `quitAndInstall` until
  // the install either ends the process or fails back to "error". The quit is
  // not instant, so this is what every restart affordance reads to go pending -
  // it's broadcast, so a second window can't fire a duplicate install either.
  readonly installInFlight: boolean;
  readonly errorMessage: string | null;
  readonly lastCheckedAt: string | null;
  readonly lastCheckIntent: DesktopAppUpdateCheckIntent | null;
}

export interface DesktopAppUpdatesBridge {
  getSnapshot(): Promise<DesktopAppUpdateSnapshot>;
  checkForUpdates(
    intent: DesktopAppUpdateCheckIntent,
  ): Promise<DesktopAppUpdateSnapshot>;
  setAllowPrerelease(
    allowPrerelease: boolean,
  ): Promise<DesktopAppUpdateSnapshot>;
  downloadUpdate(): Promise<DesktopAppUpdateSnapshot>;
  installUpdate(): Promise<DesktopAppUpdateSnapshot>;
  onChange(handler: (snapshot: DesktopAppUpdateSnapshot) => void): {
    dispose(): void;
  };
}

/**
 * Wire snapshot pushed on `globalShortcutsChange` and returned by
 * `getSnapshot`. `sequence` guards against an out-of-order frame overwriting
 * a newer one in the renderer's store, the same monotonic pattern
 * `DesktopAppUpdateSnapshot` uses.
 */
export interface DesktopGlobalShortcutsSnapshot {
  readonly sequence: number;
  readonly statuses: Readonly<Record<GlobalShortcutId, GlobalShortcutStatus>>;
}

export interface DesktopGlobalShortcutsBridge {
  getSnapshot(): Promise<DesktopGlobalShortcutsSnapshot>;
  set(
    id: GlobalShortcutId,
    intent: GlobalShortcutIntent,
  ): Promise<GlobalShortcutStatus>;
  onChange(handler: (snapshot: DesktopGlobalShortcutsSnapshot) => void): {
    dispose(): void;
  };
}

export interface DesktopHostControllerStatusBridge {
  onChange(handler: (status: HostControllerStatus) => void): {
    dispose(): void;
  };
}

// Ticket 07 (T4): "bug" routes to bug_report.yml, "idea" to
// feature_request.yml, "other" to general.yml.
export type DesktopReportType = "bug" | "idea" | "other";

export type DesktopReportFrequency =
  "once" | "sometimes" | "every_time" | "not_sure";

/**
 * Field-for-field match with ticket 08's `SupportImageAttachmentInput`
 * (`ipc-contracts/window-types.ts`). Bytes cross IPC as a raw `ArrayBuffer`,
 * never base64.
 */
export interface DesktopImageAttachmentInput {
  readonly fileName: string;
  readonly mimeType: string;
  readonly bytes: ArrayBuffer;
}

// What (if anything) actually reached the private channel for this draft, as
// known by the renderer at the moment it asks main to build a public draft.
// "none" covers both "never attempted" (no-DSN) and a definite `failed`
// result - neither left anything on the Sentry side to reference.
export type DesktopPrivateOutcome = "delivered" | "unconfirmed" | "none";

export interface DesktopReportIssueForm {
  readonly draftId: number;
  readonly type: DesktopReportType;
  // The single required question ("What were you trying to do?").
  readonly intent: string;
  // D9: null when left unselected (default) or hidden because the ledger
  // already knows the repeat count.
  readonly frequency: DesktopReportFrequency | null;
  // D7: only non-null when the user actively changed the pre-filled
  // "Where did this happen?" selector away from its default.
  readonly location: string | null;
  // G1: identity is attached to the private report only when this is true.
  readonly allowContact: boolean;
  // Consent panel's two log toggles (default on): withholds the tail from
  // the private submission / diagnostic bundle when false.
  readonly includeDesktopLog: boolean;
  readonly includeHostLog: boolean;
  // Consent panel's diagnostics toggle: gates layer-0/process-metrics/
  // version-platform-host tags+contexts on both the Sentry event and the
  // bundle's environment block. Never gates the report's own identity
  // (reportId/fingerprint/correlationId).
  readonly includeDiagnostics: boolean;
  // Up to 3 screenshots (ticket 08 / T5) - always present, empty when none
  // attached.
  readonly images: readonly DesktopImageAttachmentInput[];
  // `buildPublicDraft`-only (ignored by submit/bundle). The user's as-typed
  // preview-title edit, re-scrubbed and re-fit through the same budget
  // pipeline as a derived title on every "Open GitHub draft" re-invocation;
  // null on the initial preview fetch.
  readonly overrideTitle: string | null;
  // `buildPublicDraft`-only (ignored by submit/bundle).
  readonly privateOutcome: DesktopPrivateOutcome;
  readonly privateDiagnostics?: DesktopPrivateDiagnostics;
}

// Four states, not a nullable id: "no DSN" and "flush timed out" used to
// collapse onto the same `reportId: null`, which claimed failure for reports
// that may have arrived. `failed` is reserved for definite non-delivery;
// `unconfirmed` never claims failure and never claims delivery.
export type DesktopSubmitReportResult =
  | { readonly status: "delivered"; readonly reportId: string }
  | { readonly status: "unconfirmed"; readonly reportId: string }
  | { readonly status: "unavailable" }
  | { readonly status: "failed"; readonly reason: "error" };

export interface DesktopSupportBridge {
  getSnapshot(): Promise<DesktopSupportSnapshot>;
  revealLog(
    target: DesktopSupportLogTarget,
  ): Promise<DesktopSupportRevealLogResult>;
  submitReport(
    form: DesktopReportIssueForm,
  ): Promise<DesktopSubmitReportResult>;
  tailLog(input: {
    readonly target: DesktopSupportLogTarget;
    readonly tailLines: number;
  }): Promise<DesktopSupportLogTailResult>;
  freezeEvidence(
    input: DesktopSupportFreezeEvidenceInput,
  ): Promise<DesktopSupportFreezeEvidenceResult>;
  discardFrozenEvidence(draftId: number): Promise<void>;
  readFrozenLogTail(
    input: DesktopSupportReadFrozenLogTailInput,
  ): Promise<DesktopSupportLogTailResult>;
  saveDiagnosticBundle(
    form: DesktopReportIssueForm,
  ): Promise<DesktopSupportSaveDiagnosticBundleResult>;
  getFingerprintOccurrence(
    fingerprint: string,
  ): Promise<DesktopFingerprintOccurrence | null>;
  buildPublicDraft(
    form: DesktopReportIssueForm,
  ): Promise<DesktopSupportBuildPublicDraftResult>;
}

export interface DesktopPowerBridge {
  setSleepBlocked(blocked: boolean): Promise<void>;
}

export interface DesktopWindowsBridge {
  readonly windowId: string;
  list(): Promise<readonly DesktopWindowSummary[]>;
  onChange(handler: (windows: readonly DesktopWindowSummary[]) => void): {
    dispose(): void;
  };
  requestNew(initialRoute: string | null): Promise<void>;
  requestFocus(windowId: string): Promise<void>;
  requestClose(windowId: string): Promise<void>;
  requestOpenEpicInNewWindow(
    epicId: string,
    title: string,
    tabId: string,
  ): Promise<DesktopOpenEpicInNewWindowResult>;
  ownership: {
    snapshot(): Promise<readonly DesktopOwnershipEntry[]>;
    claim(tabId: string, epicId: string): Promise<DesktopOwnershipClaimResult>;
    release(tabId: string): Promise<void>;
    onChange(handler: (entries: readonly DesktopOwnershipEntry[]) => void): {
      dispose(): void;
    };
  };
  perWindowState: {
    get(): Promise<DesktopPerWindowSnapshot>;
    capabilities?(): Promise<DesktopPerWindowStateCapabilities>;
    update(
      patch: DesktopPerWindowStatePatch,
    ): Promise<DesktopPerWindowStateUpdateAcknowledgement | void>;
    // Optional + capability-probed: a desktop shell built before the per-window
    // `clear` RPC was added has no `clear`. Keeping it optional lets the wipe
    // site probe `typeof clear === "function"` and degrade gracefully without
    // forcing an older preload to fail the `isDesktopWindowsBridge` guard.
    clear?(): Promise<void>;
    onChange(handler: (snapshot: DesktopPerWindowSnapshot) => void): {
      dispose(): void;
    };
  };
  authSession: {
    get(): Promise<DesktopAuthSessionSnapshot>;
    set(snapshot: DesktopAuthSessionSnapshot): Promise<void>;
    onChange(handler: (snapshot: DesktopAuthSessionSnapshot) => void): {
      dispose(): void;
    };
  };
}
