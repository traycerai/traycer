import type {
  HostOperationStatus,
  HostRegistryUpdateState,
} from "@traycer-clients/shared/platform/runner-host";

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
  readonly epicTabs: readonly DesktopPerWindowEpicViewTab[];
  readonly activeTabId: string | null;
  readonly canvasByTabId: Readonly<Record<string, DesktopJsonValue>>;
  readonly landingDrafts: readonly DesktopPerWindowLandingDraft[];
  readonly activeLandingDraftId: string | null;
}

export interface DesktopPerWindowStatePatch {
  readonly epicTabs?: readonly DesktopPerWindowEpicViewTab[];
  readonly activeTabId?: string | null;
  readonly canvasByTabId?: Readonly<Record<string, DesktopJsonValue>>;
  readonly landingDrafts?: readonly DesktopPerWindowLandingDraft[];
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
  // Only meaningful for `host.installUpdate`: the exact host version the
  // native menu/tray row displayed. Echoed back as the update's
  // `expectedVersion` so the shell refuses to install a target the user never
  // confirmed (e.g. after a release-channel switch). `null` otherwise.
  readonly hostUpdateVersion: string | null;
}

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

export interface DesktopMenuBridge {
  onCommand(handler: (payload: DesktopMenuCommandPayload) => void): {
    dispose(): void;
  };
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

export interface DesktopHostRegistryUpdatesBridge {
  onChange(handler: (state: HostRegistryUpdateState) => void): {
    dispose(): void;
  };
}

export interface DesktopHostOperationStatusBridge {
  onChange(handler: (status: HostOperationStatus | null) => void): {
    dispose(): void;
  };
}

export interface DesktopReportIssueForm {
  readonly title: string;
  readonly whatHappened: string;
  readonly stepsToReproduce: string;
  readonly expectedBehavior: string;
  readonly actualBehavior: string;
}

export interface DesktopSubmitReportResult {
  readonly reportId: string;
}

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
    update(patch: DesktopPerWindowStatePatch): Promise<void>;
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
