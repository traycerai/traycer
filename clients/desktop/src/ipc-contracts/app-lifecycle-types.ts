/**
 * Shared type definitions for the desktop-only `appLifecycle` namespace
 * exposed on `window.runnerHost.appLifecycle`. The renderer side feature-
 * detects this namespace at runtime (it is absent on mobile / gui-app-dev
 * where there is no Electron preload), so the types are expressed
 * structurally and are not part of the cross-shell `IRunnerHost` contract.
 */

export interface UnsyncedEditsSnapshotEntry {
  readonly epicId: string;
  readonly title: string;
  readonly queueSize: number;
  readonly isDirty: boolean;
  /**
   * Whether some part of this row can NEVER sync - a buffer retained across a
   * host re-point, whose transport was detached and for which no local
   * persistence exists.
   *
   * Distinct from `isDirty`, and the difference is the whole reason it is on
   * the wire: dirty work DRAINS on the update-install quit, unsyncable work is
   * DESTROYED by it. Main is the only process that can answer the question
   * across windows, so it must be told per row rather than inferring it.
   */
  readonly unsyncable: boolean;
}

export type UnsyncedEditsSnapshot = ReadonlyArray<UnsyncedEditsSnapshotEntry>;

/**
 * How the renderer answered the quit intercept.
 *
 * `proceed` and `userConfirmedDiscard` both quit; `userCancelled` does not - it
 * is the user declining the quit, and main answers it by staying alive with
 * every unsynced edit untouched. It exists because a modal offering only the
 * first two has no non-destructive exit once waiting can no longer terminate:
 * a dirty session retained across a host re-point (F10) has no transport, so
 * its row never clears and "Quit and discard" was the only working control.
 *
 * **Adding a member here is a change of meaning at sites the compiler cannot
 * point at.** Two of them defaulted to quitting: `parseQuitDecision` fell back
 * to `proceed` through an `if`, and the `before-quit` consumer authorized the
 * quit without reading the decision at all. Both are exhaustive `switch`es now,
 * so the NEXT member fails to compile rather than silently meaning "quit".
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

/**
 * Main-to-renderer request for a fresh registry snapshot. The renderer reads
 * the live `OpenEpicSessionRegistry.getUnsyncedEdits()` synchronously and
 * replies via `respondFreshUnsyncedSnapshot` with the matching `requestId`.
 * Correlation by `requestId` lets the in-flight `requestFreshUnsyncedSnapshot`
 * promise ignore concurrent ambient `setUnsyncedEditsSnapshot` pushes.
 */
export interface FreshUnsyncedSnapshotRequest {
  readonly requestId: string;
}

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
    handler: (request: FreshUnsyncedSnapshotRequest) => void,
  ): Disposable;
  respondFreshUnsyncedSnapshot(
    reply: FreshUnsyncedSnapshotResponse,
  ): Promise<void>;
  /**
   * Every Epic holding work that can never sync, across ALL windows.
   *
   * On `appLifecycle` rather than on the app-update bridge because the fact is
   * a lifecycle fact - it is the same per-window map the quit intercept reads,
   * asked a different question. The caller that needs it is the update
   * install, which restarts the whole app.
   */
  unsyncableWorkAcrossWindows(): Promise<CrossWindowUnsyncableReport>;
}

/**
 * The cross-window unsyncable answer, WITH its own fidelity.
 *
 * Deliberately not a bare array. The caller is deciding whether to destroy
 * work, and for that decision "no window reported anything" and "a window did
 * not answer" are opposite conclusions that a bare empty array renders
 * identical. Main can only ever fall back to a cached row for a window that
 * missed its deadline, so the fallback is named here and travels with the
 * data rather than being resolved silently at the boundary.
 */
export interface CrossWindowUnsyncableReport {
  readonly epics: UnsyncedEditsSnapshot;
  /**
   * At least one window did not answer this round and its cached row stood in.
   * Whatever `epics` names is then only a LOWER BOUND on the work at risk.
   */
  readonly otherWindowsUnknown: boolean;
}
