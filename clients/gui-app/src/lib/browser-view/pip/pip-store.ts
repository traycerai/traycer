import { useEffect } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { BrowserViewNativeTabKey } from "@traycer-clients/shared/platform/browser-view";
import type { BrowserSessionsLifecycle } from "../sessions/browser-sessions-stream";
import {
  isBrowserTileVisible,
  subscribeVisibleBrowserTiles,
} from "../tiles/visible-tile-registry";

export const PIP_CAPTION_HOLD_MS = 3_500;
export const PIP_CAPTION_FADE_MS = 300;

export type PipStreamHealth = "live" | "stale" | "disconnected";

export interface PipTarget extends BrowserViewNativeTabKey {
  readonly selectionId: string;
  /**
   * Who asked for this PiP. The agent-surfacing pipeline never replaces a
   * `manual` target (explicit user intent) but freely replaces `agent`
   * targets latest-wins; see `decideAgentTabDisposition`.
   */
  readonly origin: "manual" | "agent";
}

export interface PipCaption {
  readonly sessionId: string;
  readonly tabId: string;
  readonly cellTitle: string;
  readonly arrivedAt: number;
}

export interface PipSnapshot {
  readonly target: PipTarget | null;
  readonly pendingTarget: PipTarget | null;
  readonly streamHealth: PipStreamHealth;
  readonly caption: PipCaption | null;
}

export const HIDDEN_PIP_SNAPSHOT: PipSnapshot = {
  target: null,
  pendingTarget: null,
  streamHealth: "live",
  caption: null,
};

interface PipConversion {
  readonly onReady: () => void;
  readonly onError: (message: string) => void;
}

interface PipStoreState {
  readonly snapshotByEpicId: Partial<Record<string, PipSnapshot>>;
}

export const pipStore = createStore<PipStoreState>()(() => ({
  snapshotByEpicId: {},
}));

const conversions = new Map<string, PipConversion>();
let selectionSequence = 0;

export function convertBrowserTabToPip(input: {
  readonly epicId: string;
  readonly hostId: string;
  readonly sessionId: string;
  readonly tabId: string;
  readonly origin: "manual" | "agent";
  readonly onReady: () => void;
  readonly onError: (message: string) => void;
}): void {
  const previous = getPipSnapshot(input.epicId);
  cancelPendingConversion(previous.pendingTarget);
  selectionSequence += 1;
  const target: PipTarget = {
    hostId: input.hostId,
    sessionId: input.sessionId,
    tabId: input.tabId,
    selectionId: `pip-${String(selectionSequence)}`,
    origin: input.origin,
  };
  conversions.set(target.selectionId, {
    onReady: input.onReady,
    onError: input.onError,
  });
  setPipSnapshot(input.epicId, {
    ...previous,
    pendingTarget: target,
    streamHealth: "live",
    caption: targetMatches(previous.target, target) ? previous.caption : null,
  });
}

export function completePipConversion(
  epicId: string,
  selectionId: string,
): void {
  const current = getPipSnapshot(epicId);
  const pending = current.pendingTarget;
  if (pending === null || pending.selectionId !== selectionId) return;
  const conversion = conversions.get(selectionId);
  if (conversion === undefined) return;
  conversions.delete(selectionId);
  setPipSnapshot(epicId, {
    target: pending,
    pendingTarget: null,
    streamHealth: "live",
    caption: current.caption,
  });
  conversion.onReady();
}

export function failPipConversion(
  epicId: string,
  selectionId: string,
  message: string,
): void {
  const current = getPipSnapshot(epicId);
  if (current.pendingTarget?.selectionId !== selectionId) return;
  const conversion = conversions.get(selectionId);
  conversions.delete(selectionId);
  setPipSnapshot(epicId, {
    ...current,
    pendingTarget: null,
    streamHealth: current.target === null ? "live" : current.streamHealth,
  });
  conversion?.onError(message);
}

export function dismissPip(epicId: string): void {
  const current = getPipSnapshot(epicId);
  cancelPendingConversion(current.pendingTarget);
  if (current.target === null && current.pendingTarget === null) return;
  setPipSnapshot(epicId, HIDDEN_PIP_SNAPSHOT);
}

export function applyPipCaption(input: {
  readonly epicId: string;
  readonly hostId: string;
  readonly sessionId: string;
  readonly tabId: string;
  readonly cellTitle: string;
}): void {
  const current = getPipSnapshot(input.epicId);
  const target = current.pendingTarget ?? current.target;
  if (
    target === null ||
    target.hostId !== input.hostId ||
    target.sessionId !== input.sessionId ||
    target.tabId !== input.tabId
  ) {
    return;
  }
  setPipSnapshot(input.epicId, {
    ...current,
    caption: {
      sessionId: input.sessionId,
      tabId: input.tabId,
      cellTitle: input.cellTitle,
      arrivedAt: Date.now(),
    },
  });
}

export function applyPipHostLifecycle(
  epicId: string,
  hostId: string,
  lifecycle: BrowserSessionsLifecycle,
): void {
  const current = getPipSnapshot(epicId);
  const captureTarget = current.pendingTarget ?? current.target;
  if (captureTarget?.hostId !== hostId) return;
  const streamHealth = streamHealthForLifecycle(lifecycle);
  if (current.streamHealth === streamHealth) return;
  setPipSnapshot(epicId, { ...current, streamHealth });
}

export function applyPipStreamHealth(
  epicId: string,
  selectionId: string,
  streamHealth: PipStreamHealth,
): void {
  const current = getPipSnapshot(epicId);
  const captureTarget = current.pendingTarget ?? current.target;
  if (captureTarget?.selectionId !== selectionId) return;
  if (current.streamHealth === streamHealth) return;
  setPipSnapshot(epicId, { ...current, streamHealth });
}

function applyPipVisibilityChanged(): void {
  for (const [epicId, snapshot] of Object.entries(
    pipStore.getState().snapshotByEpicId,
  )) {
    const target = snapshot?.target ?? null;
    if (target === null || !isBrowserTileVisible(target)) continue;
    dismissPip(epicId);
  }
}

export function getPipSnapshot(epicId: string): PipSnapshot {
  return pipStore.getState().snapshotByEpicId[epicId] ?? HIDDEN_PIP_SNAPSHOT;
}

let visibilityBridgeRegistered = false;

/**
 * Wires the "tile became visible again -> dismiss its PiP" bridge. Idempotent
 * and never unsubscribed (the registry outlives every PiP), but registered
 * from the PiP surface's mount rather than at import, so merely importing the
 * store leaves no global listener behind for a test to trip over.
 */
export function initPipStore(): void {
  if (visibilityBridgeRegistered) return;
  visibilityBridgeRegistered = true;
  subscribeVisibleBrowserTiles(applyPipVisibilityChanged);
}

export function usePipSnapshot(epicId: string): PipSnapshot {
  useEffect(initPipStore, []);
  return useStore(
    pipStore,
    (state) => state.snapshotByEpicId[epicId] ?? HIDDEN_PIP_SNAPSHOT,
  );
}

type PipCaptionFreshness = "fresh" | "fading" | "expired";

export function captionFreshness(
  caption: PipCaption,
  now: number,
): PipCaptionFreshness {
  const age = now - caption.arrivedAt;
  if (age < PIP_CAPTION_HOLD_MS) return "fresh";
  if (age < PIP_CAPTION_HOLD_MS + PIP_CAPTION_FADE_MS) return "fading";
  return "expired";
}

function targetMatches(left: PipTarget | null, right: PipTarget): boolean {
  return (
    left !== null &&
    left.hostId === right.hostId &&
    left.sessionId === right.sessionId &&
    left.tabId === right.tabId
  );
}

function streamHealthForLifecycle(
  lifecycle: BrowserSessionsLifecycle,
): PipStreamHealth {
  if (lifecycle === "live") return "live";
  if (lifecycle === "connecting" || lifecycle === "reconnecting") {
    return "stale";
  }
  return "disconnected";
}

function cancelPendingConversion(target: PipTarget | null): void {
  if (target === null) return;
  conversions.delete(target.selectionId);
}

function setPipSnapshot(epicId: string, snapshot: PipSnapshot): void {
  pipStore.setState((state) => ({
    snapshotByEpicId: { ...state.snapshotByEpicId, [epicId]: snapshot },
  }));
}
