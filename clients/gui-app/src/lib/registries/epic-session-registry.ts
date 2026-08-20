import {
  createContext,
  useCallback,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import {
  DEFAULT_MAX_LIVE_EPICS,
  OpenEpicSessionRegistry,
  type RetainedHandleIdentity,
  type UnsyncedEditsEntry,
} from "@/stores/epics/open-epic/session-registry";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type {
  EpicStreamClientFactory,
  OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { releaseDesktopEpicOwnershipForEpic } from "@/lib/windows/desktop-epic-ownership";

export const EpicSessionContext = createContext<OpenEpicStoreHandle | null>(
  null,
);

type EpicSessionPresentationState =
  | {
      readonly kind: "ready";
      readonly targetHostId: string | null;
      readonly originalHostId: string | null;
    }
  | {
      readonly kind: "establishing";
      readonly targetHostId: string | null;
      readonly originalHostId: string | null;
    }
  | {
      readonly kind: "failed";
      readonly targetHostId: string | null;
      readonly originalHostId: string | null;
    };

export type EpicSessionPresentation = EpicSessionPresentationState & {
  readonly retry: () => void;
  readonly openOnOriginalHost: () => void;
};

/**
 * Separates an established Y.Doc session from a host re-point in flight. The
 * old handle remains in `EpicSessionContext` until the replacement has a
 * complete snapshot; consumers use this presentation state to show a bounded
 * recovery result instead of treating a missing effective host as silence.
 */
export const EpicSessionPresentationContext =
  createContext<EpicSessionPresentation | null>(null);

/**
 * The RPC client resolved for the same host that owns `EpicSessionContext`.
 * Session-level provisioning prevents sidebar rows from independently mounting
 * host-directory subscriptions just to address the same Epic host.
 */
export const EpicSessionHostClientContext =
  createContext<HostClient<HostRpcRegistry> | null>(null);

export const handleHostIds = new WeakMap<OpenEpicStoreHandle, string | null>();
// The R-1 rotation rationale that used to live here now lives at the acquire
// effect's comparison in `epic-session-provider.tsx` (`readOwnerIdentityVerdict`)
// - the mechanism that actually enforces it. The `handleOwnerIdentityKeys` map
// that used to sit here was written twice, read never, and exported: a future
// consumer would have imported it and silently received a PRE-MOVE key, which
// is the defect the comparison was fixed to exclude. Deleted rather than
// corrected; read the tuple.

export function getEpicSessionHandleHostId(
  handle: OpenEpicStoreHandle,
): string | null {
  return handleHostIds.get(handle) ?? null;
}

/**
 * Registry is module-scoped so background Epic tabs survive route transitions
 * - a tab that is navigated away from but kept open in the tab strip stays
 * live (within the MRU cap) so re-entering the route is instant.
 */
export const registry = new OpenEpicSessionRegistry({
  maxLive: DEFAULT_MAX_LIVE_EPICS,
});
registry.setReleaseListener((epicId) => {
  void releaseDesktopEpicOwnershipForEpic(epicId);
});

/**
 * The distinct hosts the user's OPEN epics are bound to, sorted for a stable
 * identity.
 *
 * This is the producer set for agent activity (`s5-parity-gaps` gap 1).
 * Production used to read activity from the local host and nothing else, so a
 * cloud-homed epic being worked from a remote host rendered as idle. Fanning
 * out over every host in the directory would be the other extreme - a relay
 * connection per machine the account has ever registered - and it is not what
 * the defect asks for. The hosts a person can actually observe activity on are
 * the ones their open epics are bound to, and those hosts are already dialed.
 */
export function openEpicHostIds(): readonly string[] {
  const hostIds = new Set<string>();
  for (const handle of registry.liveHandles()) {
    const hostId = getEpicSessionHandleHostId(handle);
    if (hostId !== null) hostIds.add(hostId);
  }
  return [...hostIds].sort((left, right) => left.localeCompare(right));
}

/**
 * Test / production seam. Defaults to real `EpicStreamClient`; tests swap
 * via `__setEpicStreamClientFactoryForTests(...)` so the provider can be
 * mounted in jsdom without a live host.
 */
let streamClientFactoryOverride: EpicStreamClientFactory | null = null;

export function __setEpicStreamClientFactoryForTests(
  factory: EpicStreamClientFactory | null,
): void {
  streamClientFactoryOverride = factory;
}

export function getEpicStreamClientFactoryOverride(): EpicStreamClientFactory | null {
  return streamClientFactoryOverride;
}

export function __getOpenEpicRegistryForTests(): OpenEpicSessionRegistry {
  return registry;
}

/**
 * Accessor for the module-scoped live-Epic registry. T8 (desktop
 * app-quit intercept) subscribes to this so it can read the aggregated
 * unsynced-edits map without reaching into provider-local state.
 */
export function getOpenEpicRegistry(): OpenEpicSessionRegistry {
  return registry;
}

const EMPTY_LIVE_CHAT_EPIC_IDS: Readonly<Record<string, string>> = {};

/**
 * The chat ids that still exist in the currently-live sessions for a set of
 * task tabs, each mapped to its OWNING epic. Notification task rollups use
 * the key set as a whitelist: deleting a chat removes its id here
 * immediately, so its historical notification can stay in the bell without
 * continuing to bubble up to the task tab. The epic mapping rides along
 * because mixed mode's `home: local` indicator partition can only classify a
 * chat id by durable home through its parent epic - ids alone are host-minted
 * and encode nothing.
 */
export function useLiveChatEpicIdsForEpics(
  epicIds: ReadonlyArray<string>,
): Readonly<Record<string, string>> {
  const canonicalEpicIds = useMemo(
    () =>
      [...new Set(epicIds)].sort((left, right) => left.localeCompare(right)),
    [epicIds],
  );
  const snapshotCache = useRef<{
    readonly signature: string;
    readonly chatEpicIds: Readonly<Record<string, string>>;
  } | null>(null);
  const subscribe = useCallback(
    (listener: () => void): (() => void) => {
      let storeUnsubscribers: Array<() => void> = [];
      const bindStores = (): void => {
        for (const unsubscribe of storeUnsubscribers) unsubscribe();
        storeUnsubscribers = canonicalEpicIds.flatMap((epicId) => {
          const handle = registry.peek(epicId);
          return handle === null ? [] : [handle.store.subscribe(listener)];
        });
      };
      bindStores();
      const unsubscribeRegistry = registry.subscribe(() => {
        bindStores();
        listener();
      });
      return () => {
        unsubscribeRegistry();
        for (const unsubscribe of storeUnsubscribers) unsubscribe();
      };
    },
    [canonicalEpicIds],
  );
  const getSnapshot = useCallback((): Readonly<Record<string, string>> => {
    const entries = canonicalEpicIds.flatMap((epicId) =>
      (registry.peek(epicId)?.store.getState().chats.allIds ?? []).map(
        (chatId): readonly [string, string] => [chatId, epicId],
      ),
    );
    entries.sort(([left], [right]) => left.localeCompare(right));
    const snapshot: Readonly<Record<string, string>> =
      Object.fromEntries(entries);
    const signature = JSON.stringify(entries);
    const cached = snapshotCache.current;
    if (cached?.signature === signature) return cached.chatEpicIds;
    snapshotCache.current = { signature, chatEpicIds: snapshot };
    return snapshot;
  }, [canonicalEpicIds]);
  return useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => EMPTY_LIVE_CHAT_EPIC_IDS,
  );
}

/**
 * True when the Epic session for `epicId` currently has unsynced edits
 * that the host has not yet proven coverage for. Called synchronously
 * from the tab-close handler to decide whether to pop the discard-
 * confirmation dialog.
 */
export function epicHasUnsyncedEdits(epicId: string): boolean {
  return registry.hasUnsyncedEdits(epicId);
}

/**
 * The epics holding work that can NEVER reach a server.
 *
 * Distinct from {@link epicHasUnsyncedEdits}, which asks whether there is
 * unsynced work at all. This asks whether that work is still SAVEABLE, and it
 * is the only honest basis for destroying it without asking: a dirty live
 * session drains through its transport, a buffer retained across a host
 * re-point had `detachTransport()` called on it and no epic `Y.Doc` has local
 * persistence anywhere, so the transport was its only route out.
 */
export function unsyncableWork(): ReadonlyArray<UnsyncedEditsEntry> {
  return registry.unsyncableWork();
}

/**
 * Discard every unsynced edit for an epic, live and retained.
 *
 * The action counterpart to the per-epic row in the unsynced sheet. Callers
 * must not reach for `registry.get(epicId)` and drain that handle instead:
 * that reaches only the live session, and a retained buffer would survive a
 * Discard the user believes covered everything.
 */
export function drainEpicUnsyncedEdits(epicId: string): void {
  registry.drainUnsyncedEdits(epicId);
}

/**
 * Release (forcibly dispose) the Epic session for `epicId`. Called when the
 * user closes a tab in the strip.
 */
export function releaseOpenEpicSession(epicId: string): void {
  // Tab close is the one release path where a decision was offered: the close
  // confirmation reads `epicHasUnsyncedEdits`, which covers retained buffers,
  // so reaching here means the user has already answered for them too.
  // The user was ASKED about these edits, so the live handle goes with them:
  // "discard" is the answer to a question, not an involuntary teardown.
  registry.release(epicId, "discard", null);
}

/**
 * Release an epic's session only if no tab in THIS window still shows it.
 *
 * `registry.release` keys on `epicId` and disposes unconditionally, but a
 * window can legitimately hold the same epic in two tabs - so any path that
 * has finished with ONE tab has to ask this question first, or it disposes the
 * live session out from under the other one. That is the whole reason this
 * wrapper exists, and it is the only thing standing between an epic-keyed
 * registry and a tab-keyed UI.
 *
 * `retainedBuffers` is explicit at every call because the two answers are not
 * interchangeable. `"discard"` belongs to paths where the user was ASKED - the
 * close confirmation reads `epicHasUnsyncedEdits`, which covers retentions, so
 * arriving there means they answered for them. `"keep"` belongs to involuntary
 * paths, where nothing was shown and dropping the buffer would be a silent
 * loss.
 */
export function releaseOpenEpicSessionIfUnused(
  epicId: string,
  retainedBuffers: "discard" | "keep",
  dirtyLiveHandle: RetainedHandleIdentity | null,
): void {
  const state = useEpicCanvasStore.getState();
  const stillOpen = state.openTabOrder.some(
    (tabId) => state.tabsById[tabId]?.epicId === epicId,
  );
  if (stillOpen) return;
  registry.release(epicId, retainedBuffers, dirtyLiveHandle);
}

/**
 * Forcibly dispose every live Epic session. Wired into the auth lifecycle so
 * sign-out, user-switch, or token expiry cannot leave a prior identity's
 * Y.Doc / queue / focus state behind in the registry - the next sign-in
 * starts fresh from a host snapshot.
 */
export function disposeAllOpenEpicSessions(): void {
  registry.disposeAll();
}
