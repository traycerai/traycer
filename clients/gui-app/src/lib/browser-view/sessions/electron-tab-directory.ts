import { useSyncExternalStore } from "react";
import type {
  BrowserViewAttachSurface,
  BrowserViewElectronTabControlAction,
  BrowserViewNativeTabCapability,
} from "@traycer-clients/shared/platform/browser-view";
import { compositeKey } from "../tiles/browser-view-keys";

/**
 * Renderer-global registry of published Electron tab bindings. Bindings
 * outlive any single `browser.sessions` lifecycle, so every entry records the
 * `owner` symbol of the `createElectronTabs` instance that produced it and
 * every mutation is owner-filtered - a reconnecting lifecycle must never
 * retire a live successor's bindings. The lifecycle itself lives in
 * `electron-tabs.ts`.
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

const directory = new Map<string, ElectronTabDirectoryEntry>();
const directoryListeners = new Set<() => void>();

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

/**
 * Non-reactive lookup of a published Electron tab binding, for callers that
 * act on a tab once (navigating a deduped link's tab to a new hash) rather
 * than rendering it. Returns `null` for a tab this renderer does not own -
 * a headless session, or a tab living on another machine's shell.
 */
export function electronTabBinding(
  hostId: string,
  sessionId: string,
  tabId: string,
): ElectronTabBinding | null {
  return directory.get(nativeTabKey(hostId, sessionId, tabId))?.binding ?? null;
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
