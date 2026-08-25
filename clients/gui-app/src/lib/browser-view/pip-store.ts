import { useSyncExternalStore } from "react";
import {
  isBrowserTileVisible,
  subscribeVisibleBrowserTiles,
} from "./visible-tile-registry";

export const PIP_CAPTION_HOLD_MS = 3_500;
export const PIP_CAPTION_FADE_MS = 300;

export type PipStreamHealth = "live" | "stale" | "disconnected";

export type PipHostLifecycle =
  "connecting" | "live" | "reconnecting" | "closed" | "failed";

export interface PipTarget {
  readonly hostId: string;
  readonly sessionId: string;
  readonly tabId: string;
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

const snapshots = new Map<string, PipSnapshot>();
const conversions = new Map<string, PipConversion>();
const listeners = new Set<() => void>();
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
  snapshots.set(input.epicId, {
    ...previous,
    pendingTarget: target,
    streamHealth: "live",
    caption: targetMatches(previous.target, target) ? previous.caption : null,
  });
  emit();
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
  snapshots.set(epicId, {
    target: pending,
    pendingTarget: null,
    streamHealth: "live",
    caption: current.caption,
  });
  emit();
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
  snapshots.set(epicId, {
    ...current,
    pendingTarget: null,
    streamHealth: current.target === null ? "live" : current.streamHealth,
  });
  emit();
  conversion?.onError(message);
}

export function dismissPip(epicId: string): void {
  const current = getPipSnapshot(epicId);
  cancelPendingConversion(current.pendingTarget);
  if (current.target === null && current.pendingTarget === null) return;
  snapshots.set(epicId, HIDDEN_PIP_SNAPSHOT);
  emit();
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
  snapshots.set(input.epicId, {
    ...current,
    caption: {
      sessionId: input.sessionId,
      tabId: input.tabId,
      cellTitle: input.cellTitle,
      arrivedAt: Date.now(),
    },
  });
  emit();
}

export function applyPipHostLifecycle(
  epicId: string,
  hostId: string,
  lifecycle: PipHostLifecycle,
): void {
  const current = getPipSnapshot(epicId);
  const captureTarget = current.pendingTarget ?? current.target;
  if (captureTarget?.hostId !== hostId) return;
  const streamHealth = streamHealthForLifecycle(lifecycle);
  if (current.streamHealth === streamHealth) return;
  snapshots.set(epicId, { ...current, streamHealth });
  emit();
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
  snapshots.set(epicId, { ...current, streamHealth });
  emit();
}

function applyPipVisibilityChanged(): void {
  for (const [epicId, snapshot] of snapshots) {
    const target = snapshot.target;
    if (target === null || !tileIsVisible(target)) continue;
    dismissPip(epicId);
  }
}

export function markPipHostUnavailable(epicId: string, hostId: string): void {
  applyPipHostLifecycle(epicId, hostId, "closed");
}

export function getPipSnapshot(epicId: string): PipSnapshot {
  return snapshots.get(epicId) ?? HIDDEN_PIP_SNAPSHOT;
}

export function subscribePipStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePipSnapshot(epicId: string): PipSnapshot {
  return useSyncExternalStore(
    subscribePipStore,
    () => getPipSnapshot(epicId),
    () => getPipSnapshot(epicId),
  );
}

export type PipCaptionFreshness = "fresh" | "fading" | "expired";

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
  lifecycle: PipHostLifecycle,
): PipStreamHealth {
  if (lifecycle === "live") return "live";
  if (lifecycle === "connecting" || lifecycle === "reconnecting") {
    return "stale";
  }
  return "disconnected";
}

function tileIsVisible(target: PipTarget): boolean {
  return isBrowserTileVisible({
    hostId: target.hostId,
    sessionId: target.sessionId,
    tabId: target.tabId,
  });
}

function cancelPendingConversion(target: PipTarget | null): void {
  if (target === null) return;
  conversions.delete(target.selectionId);
}

function emit(): void {
  for (const listener of listeners) listener();
}

subscribeVisibleBrowserTiles(applyPipVisibilityChanged);
