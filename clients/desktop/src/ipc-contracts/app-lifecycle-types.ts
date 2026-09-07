
export interface UnsyncedEditsSnapshotEntry {
  readonly epicId: string;
  readonly title: string;
  readonly queueSize: number;
  readonly isDirty: boolean;
  /**
   * Whether some part of this row can NEVER sync - a buffer retained across a host re-point, whose transport was detached and for which no local persistence exists.
   * Main is the only process that can answer the question across windows, so it must be told per row rather than inferring it.
   */
  readonly unsyncable: boolean;
}

export type UnsyncedEditsSnapshot = ReadonlyArray<UnsyncedEditsSnapshotEntry>;

/**
 * It exists because a modal offering only the first two has no non-destructive exit once waiting can no longer terminate: a dirty session retained across a host re-point (F10) has.
 * Adding a member here is a change of meaning at sites the compiler cannot point at. Two of them defaulted to quitting: `parseQuitDecision` fell back to `proceed` through an `if`.
 */
export type QuitDecision = "proceed" | "userConfirmedDiscard" | "userCancelled";

export interface QuitRequest {
  readonly requestId: string;
  readonly snapshot: UnsyncedEditsSnapshot;
}

export interface QuitDecisionResponse {
  readonly requestId: string;
  readonly decision: QuitDecision;
}

/** The renderer reads the live `OpenEpicSessionRegistry.getUnsyncedEdits()` synchronously and replies with the matching `requestId`. */
export interface FreshUnsyncedSnapshotResponse {
  readonly requestId: string;
  readonly snapshot: UnsyncedEditsSnapshot;
}

import type { Disposable } from "@traycer-clients/shared/platform/uri-callback";

export interface AppLifecycleBridge {
  quit(): Promise<void>;
  setUnsyncedEditsSnapshot(snapshot: UnsyncedEditsSnapshot): Promise<void>;
  onQuitRequested(handler: (request: QuitRequest) => void): Disposable;
  acknowledgeQuitRequest(requestId: string): Promise<void>;
  respondToQuitRequest(response: QuitDecisionResponse): Promise<void>;
  onGetFreshUnsyncedSnapshot(
    handler: (request: { readonly requestId: string }) => void,
  ): Disposable;
  respondFreshUnsyncedSnapshot(
    reply: FreshUnsyncedSnapshotResponse,
  ): Promise<void>;
  /**
   * Every Epic holding work that can never sync, across ALL windows.
   * The caller that needs it is the update install, which restarts the whole app.
   */
  unsyncableWorkAcrossWindows(): Promise<CrossWindowUnsyncableReport>;
}

/** The caller is deciding whether to destroy work, and for that decision "no window reported anything" and "a window did not answer" are opposite conclusions that a bare empty array. */
export interface CrossWindowUnsyncableReport {
  readonly epics: UnsyncedEditsSnapshot;
  readonly otherWindowsUnknown: boolean;
}
