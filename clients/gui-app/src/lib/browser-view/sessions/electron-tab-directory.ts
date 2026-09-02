import { useSyncExternalStore } from "react";
import type {
  BrowserViewAttachSurface,
  BrowserViewBridge,
  BrowserViewElectronTabControlAction,
  BrowserViewNativeTabCapability,
} from "@traycer-clients/shared/platform/browser-view";
import { compositeKey } from "../tiles/browser-view-keys";
import { ignoreError } from "../ignore-error";

/**
 * Renderer-global registry of published Electron tab bindings.
 *
 * The LIFECYCLE is not here, and is no longer in this process at all: main
 * owns the `browser.sessions` stream, creates the native tab from the host's
 * `createElectronTab` frame (seed included) and tells this renderer only that
 * a tab exists, by identity (H10). What is left is the tile's half - the
 * directory a tile looks a binding up in, the control action, and the surface
 * attach/detach chain, none of which carries jar material.
 *
 * Bindings outlive any single stream incarnation, so every entry records the
 * `owner` symbol of the coordinator that published it and every mutation is
 * owner-filtered: a reconnecting stream must never retire a live successor's
 * bindings.
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

function subscribeDirectory(listener: () => void): () => void {
  directoryListeners.add(listener);
  return () => {
    directoryListeners.delete(listener);
  };
}

function notifyDirectoryListeners(): void {
  for (const listener of directoryListeners) listener();
}

/**
 * Publishes the tile-facing half of one native tab main just bound.
 *
 * The attach/detach chain is serialized PER TAB here, because a rebind is two
 * calls (detach the old surface, then attach the new) and they must not
 * interleave with another rebind of the same tab: main refuses an attach while
 * a different binding id is still live, so an unordered pair leaves the tile
 * blank. The old surface stays recorded until its detach actually resolves, so
 * a failed rebind leaves a retry able to detach it again.
 */
export function publishElectronTabBinding(
  owner: symbol,
  native: BrowserViewBridge,
  capability: BrowserViewNativeTabCapability,
): void {
  let activeSurface: {
    readonly token: symbol;
    readonly bindingId: string;
  } | null = null;
  let mutation: Promise<void> = Promise.resolve();

  const bindSurface = async (
    input: ElectronTabSurfaceBinding,
  ): Promise<ElectronTabSurfaceLease> => {
    const token = Symbol(input.bindingId);
    const attach = mutation.then(async () => {
      const previous = activeSurface;
      if (previous !== null) {
        await native.detachSurface({
          ...capability,
          bindingId: previous.bindingId,
        });
        activeSurface = null;
      }
      await native.attachSurface({ ...capability, ...input });
      activeSurface = { token, bindingId: input.bindingId };
    });
    mutation = attach.catch(ignoreError);
    await attach;
    let detached = false;
    return {
      detach: async () => {
        if (detached) return;
        detached = true;
        const detach = mutation.then(async () => {
          if (activeSurface?.token !== token) return;
          await native.detachSurface({
            ...capability,
            bindingId: input.bindingId,
          });
          activeSurface = null;
        });
        mutation = detach.catch(ignoreError);
        await detach;
      },
    };
  };

  directory.set(
    nativeTabKey(capability.hostId, capability.sessionId, capability.tabId),
    {
      owner,
      binding: {
        ...capability,
        control: (action) =>
          native.controlElectronTab({ ...capability, action }),
        bindSurface,
      },
    },
  );
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
