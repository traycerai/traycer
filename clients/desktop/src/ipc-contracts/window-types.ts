/**
 * Plain-data mirrors for desktop-only multi-window bridges. These types are
 * intentionally kept out of the shared `IRunnerHost` contract; desktop
 * renderers feature-detect `window.runnerHost.windows` before using them.
 */

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
  readonly epicTabs: readonly PerWindowEpicViewTab[];
  readonly activeTabId: string | null;
  readonly canvasByTabId: Readonly<Record<string, JsonValue>>;
  readonly landingDrafts: readonly PerWindowLandingDraft[];
  readonly activeLandingDraftId: string | null;
}

export interface PerWindowStatePatch {
  readonly epicTabs?: readonly PerWindowEpicViewTab[];
  readonly activeTabId?: string | null;
  readonly canvasByTabId?: Readonly<Record<string, JsonValue>>;
  readonly landingDrafts?: readonly PerWindowLandingDraft[];
  readonly activeLandingDraftId?: string | null;
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

export interface SupportHostSnapshot {
  readonly status: "ready" | "starting";
  readonly version: string | null;
  readonly pid: number | null;
  readonly hostId: string | null;
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
}

export interface SupportRevealLogResult {
  readonly target: SupportLogTarget;
  readonly path: string;
}

export interface SupportSubmitReportRequest {
  readonly title: string;
  readonly whatHappened: string;
  readonly stepsToReproduce: string;
  readonly expectedBehavior: string;
  readonly actualBehavior: string;
}

export interface SupportSubmitReportResult {
  readonly reportId: string;
}

export interface SupportLogTailResult {
  readonly target: SupportLogTarget;
  readonly path: string;
  readonly lines: readonly string[];
  readonly truncated: boolean;
}
