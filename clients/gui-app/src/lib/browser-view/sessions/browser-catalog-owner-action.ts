import { useAuthStore } from "@/stores/auth/auth-store";
import { browserCatalogInventory } from "./browser-catalog-inventory";
import type { BrowserCatalogIdentity } from "@traycer/protocol/host/browser/catalog-contracts";
import {
  acquireBrowserSessionsCoordinator,
  browserSessionsCoordinatorKey,
  browserSessionsCoordinatorState,
  browserSessionsOwnerSupportsInventory,
  subscribeToBrowserSessionsCoordinator,
  type BrowserSessionsCoordinatorRuntime,
  type BrowserSessionsOwner,
  type BrowserSessionsState,
} from "./browser-sessions-coordinator";

function readyOwner(
  key: string,
  requireDurable: boolean,
): Promise<BrowserSessionsState> {
  return new Promise((resolve, reject) => {
    let unsubscribe = (): void => undefined;
    const timer = window.setTimeout(() => {
      unsubscribe();
      reject(
        new Error(
          requireDurable
            ? "Couldn't read this device's saved browser tabs. Try again."
            : "Couldn't connect to this device. Try again.",
        ),
      );
    }, 10_000);
    const read = (): void => {
      const state = browserSessionsCoordinatorState(key);
      if (state === null) return;
      if (state.lifecycle === "failed" || state.lifecycle === "closed") {
        window.clearTimeout(timer);
        unsubscribe();
        reject(
          new Error(
            state.errorMessage ?? "Couldn't connect to this device. Try again.",
          ),
        );
      } else if (
        state.lifecycle === "live" &&
        state.inventoryReady &&
        (!requireDurable || browserSessionsOwnerSupportsInventory(key))
      ) {
        window.clearTimeout(timer);
        unsubscribe();
        resolve(state);
      }
    };
    unsubscribe = subscribeToBrowserSessionsCoordinator(key, read);
    read();
  });
}

async function assertOwnerAccess(
  userId: string | null,
  epicId: string,
  hostId: string,
): Promise<void> {
  if (
    userId === null ||
    useAuthStore.getState().contextMetadata?.userId !== userId
  )
    throw new Error("Sign in to use this browser tab.");
  const scope = { userId, epicId };
  await browserCatalogInventory.load(scope);
  if (useAuthStore.getState().contextMetadata?.userId !== userId)
    throw new Error("Sign in to use this browser tab.");
  const inventory = browserCatalogInventory.read(scope);
  if (inventory.status === "inaccessible")
    throw new Error("Browser access is unavailable for this task.");
  if (inventory.revokedHostIds.includes(hostId))
    throw new Error("Browser access is unavailable for this device.");
}

/** Action interest is independent of any existing viewers and never opens a tab. */
export async function runBrowserCatalogOwnerAction<T>(args: {
  readonly epicId: string;
  readonly owner: BrowserSessionsOwner;
  readonly runtime: BrowserSessionsCoordinatorRuntime;
  readonly requireDurable: boolean;
  readonly action: (state: BrowserSessionsState) => Promise<T>;
}): Promise<T> {
  await assertOwnerAccess(args.runtime.userId, args.epicId, args.owner.hostId);
  const scope = { kind: "epic", epicId: args.epicId } as const;
  const key = browserSessionsCoordinatorKey(scope, args.owner);
  const release = acquireBrowserSessionsCoordinator({
    key,
    consumerId: Symbol("browser-owner-action"),
    scope,
    owner: args.owner,
    runtime: args.runtime,
    createIfMissing: true,
  });
  try {
    const state = await readyOwner(key, args.requireDurable);
    await assertOwnerAccess(
      args.runtime.userId,
      args.epicId,
      args.owner.hostId,
    );
    return await args.action(state);
  } finally {
    release();
  }
}

export async function closeBrowserCatalogTab(args: {
  readonly identity: BrowserCatalogIdentity;
  readonly tabId: string;
  readonly owner: BrowserSessionsOwner;
  readonly runtime: BrowserSessionsCoordinatorRuntime;
}): Promise<void> {
  if (args.identity.hostId !== args.owner.hostId)
    throw new Error("Browser tab owner does not match.");
  await runBrowserCatalogOwnerAction({
    epicId: args.identity.epicId,
    owner: args.owner,
    runtime: args.runtime,
    requireDurable: true,
    action: async (state) => {
      try {
        await state.closeTab(args.identity.sessionId, args.tabId);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "Browser sessions request timed out."
        ) {
          state.retry();
          // Re-read the owner's inventory while action interest is still held.
          // Snapshot absence does not change the unknown mutation into success.
          const key = browserSessionsCoordinatorKey(
            { kind: "epic", epicId: args.identity.epicId },
            args.owner,
          );
          await readyOwner(key, true).catch(() => undefined);
        }
        throw error;
      }
    },
  });
}
