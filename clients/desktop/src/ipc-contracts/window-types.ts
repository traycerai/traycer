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

export interface SupportSubmitReportRequest {
  // Keys the frozen evidence (both log tails + the report id minted at
  // report-open) that `submitReport` and every retry must reuse.
  readonly draftId: number;
  readonly title: string;
  readonly whatHappened: string;
  readonly stepsToReproduce: string;
  readonly expectedBehavior: string;
  readonly actualBehavior: string;
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

export interface SupportFreezeEvidenceResult {
  // Minted once per draft, at freeze time - not per submit call. Every retry
  // (T2) and the GitHub fallback prefill reuse this same id.
  readonly reportId: string;
}

export interface SupportReadFrozenLogTailInput {
  readonly draftId: number;
  readonly target: SupportLogTarget;
}

export interface SupportSaveDiagnosticBundleResult {
  readonly path: string;
}
