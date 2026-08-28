import { useSyncExternalStore } from "react";
import type {
  BrowserViewAttachSurface,
  BrowserViewElectronTabControlAction,
  BrowserViewNativeTabCapability,
} from "@traycer-clients/shared/platform/browser-view";
import { compositeKey } from "../tiles/browser-view-keys";
import { ignoreError } from "../ignore-error";

/**
 * Renderer-global registry of published Electron tab bindings, plus the
 * handoff ACKs a quit drain waits on. Both outlive any single
 * `browser.sessions` lifecycle, so every entry records the `owner` symbol of
 * the `createElectronTabs` instance that produced it and every mutation is
 * owner-filtered - a reconnecting lifecycle must never retire a live
 * successor's bindings. The lifecycle itself lives in `electron-tabs.ts`.
 */

type ElectronTabSurfaceBinding = Omit<
  BrowserViewAttachSurface,
  keyof BrowserViewNativeTabCapability
>;

export interface ElectronTabSurfaceLease {
  detach(): Promise<void>;
}

export interface ElectronTabBinding extends BrowserViewNativeTabCapability {
  readonly control: (
    action: BrowserViewElectronTabControlAction,
  ) => Promise<void>;
  readonly bindSurface: (
    input: ElectronTabSurfaceBinding,
  ) => Promise<ElectronTabSurfaceLease>;
}

interface ElectronTabDirectoryEntry {
  readonly owner: symbol;
  readonly binding: ElectronTabBinding;
}

interface PendingHandoffAck {
  readonly owner: symbol;
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (cause: Error) => void;
}

const directory = new Map<string, ElectronTabDirectoryEntry>();
const directoryListeners = new Set<() => void>();
const pendingHandoffAcks = new Map<string, PendingHandoffAck>();

export function nativeTabKey(
  hostId: string,
  sessionId: string,
  tabId: string,
): string {
  return compositeKey(hostId, sessionId, tabId);
}

export function useElectronTabBindingOnHost(
  sessionId: string,
  tabId: string,
  hostId: string,
): ElectronTabBinding | null {
  return useSyncExternalStore(
    subscribeDirectory,
    () =>
      directory.get(nativeTabKey(hostId, sessionId, tabId))?.binding ?? null,
    () => null,
  );
}

function subscribeDirectory(listener: () => void): () => void {
  directoryListeners.add(listener);
  return () => {
    directoryListeners.delete(listener);
  };
}

function notifyDirectoryListeners(): void {
  for (const listener of directoryListeners) listener();
}

export function publishElectronTabBinding(
  owner: symbol,
  binding: ElectronTabBinding,
): void {
  directory.set(
    nativeTabKey(binding.hostId, binding.sessionId, binding.tabId),
    { owner, binding },
  );
  notifyDirectoryListeners();
}

export function removeOwnedElectronTabBinding(
  owner: symbol,
  key: string,
  registrationId: string,
): void {
  const entry = directory.get(key);
  if (
    entry?.owner !== owner ||
    entry.binding.registrationId !== registrationId
  ) {
    return;
  }
  directory.delete(key);
  notifyDirectoryListeners();
}

export function removeOwnedElectronTabBindings(owner: symbol): void {
  let removed = false;
  for (const [key, entry] of directory) {
    if (entry.owner !== owner) continue;
    directory.delete(key);
    removed = true;
  }
  if (removed) notifyDirectoryListeners();
}

export async function drainElectronTabHandoffs(): Promise<void> {
  await Promise.all(
    Array.from(pendingHandoffAcks.values(), (pending) => pending.promise),
  );
}

export function registerElectronTabHandoffAck(
  requestId: string,
  owner: symbol,
): void {
  let settle: (() => void) | null = null;
  let fail: ((cause: Error) => void) | null = null;
  const promise = new Promise<void>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  // ACKs can arrive when no quit drain is observing. Keep the original
  // promise rejectable for active drains without leaking globally.
  void promise.catch(ignoreError);
  pendingHandoffAcks.set(requestId, {
    owner,
    promise,
    resolve: () => settle?.(),
    reject: (cause: Error) => fail?.(cause),
  });
}

/**
 * Settles one owned ACK. Returns `false` when the request id is unknown or
 * belongs to another lifecycle, which is the caller's cue to keep routing the
 * frame (close ACKs share the `actionAck` kind).
 */
export function settleElectronTabHandoffAck(
  requestId: string,
  owner: symbol,
  failure: Error | null,
): boolean {
  const pending = pendingHandoffAcks.get(requestId);
  if (pending?.owner !== owner) return false;
  pendingHandoffAcks.delete(requestId);
  if (failure === null) pending.resolve();
  else pending.reject(failure);
  return true;
}

export function rejectOwnedElectronTabHandoffAcks(
  owner: symbol,
  message: string,
): void {
  for (const [requestId, pending] of pendingHandoffAcks) {
    if (pending.owner !== owner) continue;
    pendingHandoffAcks.delete(requestId);
    pending.reject(new Error(message));
  }
}
