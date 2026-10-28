import { useAuthStore } from "@/stores/auth/auth-store";
import type { BrowserCatalogIdentity } from "@traycer/protocol/host/browser/catalog-contracts";
import {
  acquireBrowserSessionsCoordinator,
  browserSessionsCoordinatorKey,
  browserSessionsCoordinatorState,
  subscribeToBrowserSessionsCoordinator,
  type BrowserSessionsCoordinatorRuntime,
  type BrowserSessionsOwner,
  type BrowserSessionsState,
} from "./browser-sessions-coordinator";

function readyOwner(key: string): Promise<BrowserSessionsState> {
  return new Promise((resolve, reject) => {
    let unsubscribe = (): void => undefined;
    const timer = window.setTimeout(() => {
      unsubscribe();
      reject(new Error("Couldn't connect to this device. Try again."));
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
      } else if (state.lifecycle === "live" && state.inventoryReady) {
        window.clearTimeout(timer);
        unsubscribe();
        resolve(state);
      }
    };
    unsubscribe = subscribeToBrowserSessionsCoordinator(key, read);
    read();
  });
}

function assertSignedIn(userId: string | null): void {
  if (
    userId === null ||
    useAuthStore.getState().contextMetadata?.userId !== userId
  )
    throw new Error("Sign in to use this browser tab.");
}

/** Action interest is independent of existing viewers and never opens a tab. */
export async function runBrowserCatalogOwnerAction<T>(args: {
  readonly epicId: string;
  readonly owner: BrowserSessionsOwner;
  readonly runtime: BrowserSessionsCoordinatorRuntime;
  readonly action: (state: BrowserSessionsState) => Promise<T>;
}): Promise<T> {
  assertSignedIn(args.runtime.userId);
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
  // The coordinator may be one another surface keeps mounted, whose stream
  // already ended. Nothing else re-asks a `closed` one, so every action on
  // this device would fail at once until that surface unmounted.
  const current = browserSessionsCoordinatorState(key);
  if (current?.lifecycle === "failed" || current?.lifecycle === "closed")
    current.retry();
  try {
    const state = await readyOwner(key);
    assertSignedIn(args.runtime.userId);
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
    action: (state) => state.closeTab(args.identity.sessionId, args.tabId),
  });
}
