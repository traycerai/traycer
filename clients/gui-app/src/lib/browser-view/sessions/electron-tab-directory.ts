import { useSyncExternalStore } from "react";
import type {
  BrowserViewAttachSurface,
  BrowserViewBridge,
  BrowserViewElectronTabControlAction,
  BrowserViewNativeTabCapability,
} from "@traycer-clients/shared/platform/browser-view";
import { compositeKey } from "../tiles/browser-view-keys";
import { ignoreError } from "../ignore-error";

/** Renderer-global registry of published Electron tab bindings. */

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

interface ElectronTabSurfaceState {
  activeSurface: { readonly token: symbol; readonly bindingId: string } | null;
  mutation: Promise<void>;
}

const directory = new Map<string, ElectronTabDirectoryEntry>();
const directoryListeners = new Set<() => void>();
/**
 * The attach/detach chain, keyed by TAB rather than held per published binding: a second `tabBound` for the same tab republishes it without a removal in between, and two chains for one tab can interleave the old lease's detach with the new one's attach -.
 */
const surfaceStates = new Map<string, ElectronTabSurfaceState>();

function surfaceStateFor(key: string): ElectronTabSurfaceState {
  const existing = surfaceStates.get(key);
  if (existing !== undefined) return existing;
  const created: ElectronTabSurfaceState = {
    activeSurface: null,
    mutation: Promise.resolve(),
  };
  surfaceStates.set(key, created);
  return created;
}

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
 * Non-reactive lookup of a published Electron tab binding, for callers that act on a tab once (navigating a deduped link's tab to a new hash) rather than rendering it.
 * Returns `null` for a tab this renderer does not own - a headless session, or a tab living on another machine's shell.
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

/** Publishes the tile-facing half of one native tab main just bound. */
export function publishElectronTabBinding(
  owner: symbol,
  native: BrowserViewBridge,
  capability: BrowserViewNativeTabCapability,
): void {
  const key = nativeTabKey(
    capability.hostId,
    capability.sessionId,
    capability.tabId,
  );
  const state = surfaceStateFor(key);

  const bindSurface = async (
    input: ElectronTabSurfaceBinding,
  ): Promise<ElectronTabSurfaceLease> => {
    const token = Symbol(input.bindingId);
    const attach = state.mutation.then(async () => {
      const previous = state.activeSurface;
      if (previous !== null) {
        await native.detachSurface({
          ...capability,
          bindingId: previous.bindingId,
        });
        state.activeSurface = null;
      }
      await native.attachSurface({ ...capability, ...input });
      state.activeSurface = { token, bindingId: input.bindingId };
    });
    state.mutation = attach.catch(ignoreError);
    await attach;
    let detached = false;
    return {
      detach: async () => {
        if (detached) return;
        detached = true;
        const detach = state.mutation.then(async () => {
          if (state.activeSurface?.token !== token) return;
          await native.detachSurface({
            ...capability,
            bindingId: input.bindingId,
          });
          state.activeSurface = null;
        });
        state.mutation = detach.catch(ignoreError);
        await detach;
      },
    };
  };

  directory.set(key, {
    owner,
    binding: {
      ...capability,
      control: (action) => native.controlElectronTab({ ...capability, action }),
      bindSurface,
    },
  });
  notifyDirectoryListeners();
}

export function removeOwnedElectronTabBinding(
  owner: symbol,
  capability: BrowserViewNativeTabCapability,
): void {
  const key = nativeTabKey(
    capability.hostId,
    capability.sessionId,
    capability.tabId,
  );
  const entry = directory.get(key);
  if (
    entry?.owner !== owner ||
    entry.binding.registrationId !== capability.registrationId
  ) {
    return;
  }
  directory.delete(key);
  // A genuine release: main has already dropped the native entry, so the recorded surface names something that no longer exists and the next incarnation of this tab must start from a clean chain.
  surfaceStates.delete(key);
  notifyDirectoryListeners();
}

/** Retires every binding this coordinator published - a stream that stopped being live, or a restart. */
export function removeOwnedElectronTabBindings(owner: symbol): void {
  let removed = false;
  for (const [key, entry] of directory) {
    if (entry.owner !== owner) continue;
    directory.delete(key);
    removed = true;
  }
  if (removed) notifyDirectoryListeners();
}
