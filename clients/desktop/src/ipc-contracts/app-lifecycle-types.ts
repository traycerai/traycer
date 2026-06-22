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
}

export type UnsyncedEditsSnapshot = ReadonlyArray<UnsyncedEditsSnapshotEntry>;

export type QuitDecision = "proceed" | "userConfirmedDiscard";

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
}
