import {
  createEpicRuntimeWorker,
  type RuntimeWorkerLike,
} from "@/stores/epics/open-epic/runtime/worker/spawn-epic-runtime-worker";
import {
  createContext,
  useCallback,
  useMemo,
  useRef,
  useSyncExternalStore,
  type Context,
} from "react";
import { getEpicRuntimeWorkerFactoryOverride } from "./epic-runtime-worker-factory-slot";
import {
  DEFAULT_MAX_LIVE_EPICS,
  OpenEpicSessionRegistry,
  type RetainedHandleIdentity,
  type UnsyncedEditsEntry,
} from "@/stores/epics/open-epic/session-registry";
// RE-EXPORTED, not re-declared. The liveness cell moved to the module that owns
// `acquireMounted`, because that seam is what has to consult it - and this
// module imports THAT one, so a map declared here could not be read there
// without a cycle. The provider's import path is unchanged.
export {
  isEpicSessionHandleDead,
  trackEpicSessionHandleLiveness,
} from "@/stores/epics/open-epic/session-registry";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { releaseDesktopEpicOwnershipForEpic } from "@/lib/windows/desktop-epic-ownership";

export const EpicSessionContext = createStableDevContext(
  "__TRAYCER_EPIC_SESSION_CONTEXT__",
  () => createContext<OpenEpicStoreHandle | null>(null),
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
export const EpicSessionPresentationContext = createStableDevContext(
  "__TRAYCER_EPIC_SESSION_PRESENTATION_CONTEXT__",
  () => createContext<EpicSessionPresentation | null>(null),
);

/**
 * The three epic-session contexts are pinned on `globalThis` in Vite's hot
 * runtime, exactly as `HostCompatibilityContext` and the host runtime state are
 * (`lib/host/compatibility-state.ts`, `lib/host/runtime.ts`): Fast Refresh can
 * keep a provider from one module generation mounted while a refreshed
 * consumer reads hooks from the next, and a context object created per
 * generation makes those two sides address DIFFERENT contexts - the consumer
 * reads the default `null` and the throwing `useOpenEpicHandle()` blanks the
 * window with "must be called inside <EpicSessionProvider>" (observed during a
 * dev-slot live pass, 2026-08-30). Reusing one object per page removes the only
 * way two epic-session contexts can coexist. A production build has no
 * `import.meta.hot` and gets ordinary page-local contexts; a real reload resets
 * `globalThis`. Vitest's `import.meta.hot` stub exercises the same
 * module-reimport path.
 *
 * All three are pinned, not just the handle context: the provider writes them
 * as one tuple (`epic-session-provider.tsx`), and a split on any one of them
 * leaves a consumer reading a stale presentation or host client.
 */
interface EpicSessionDevGlobals {
  __TRAYCER_EPIC_SESSION_CONTEXT__:
    Context<OpenEpicStoreHandle | null> | undefined;
  __TRAYCER_EPIC_SESSION_PRESENTATION_CONTEXT__:
    Context<EpicSessionPresentation | null> | undefined;
  __TRAYCER_EPIC_SESSION_HOST_CLIENT_CONTEXT__:
    Context<HostClient<HostRpcRegistry> | null> | undefined;
}

function createStableDevContext<K extends keyof EpicSessionDevGlobals>(
  key: K,
  create: () => NonNullable<EpicSessionDevGlobals[K]>,
): NonNullable<EpicSessionDevGlobals[K]> {
  if (import.meta.hot === undefined) {
    return create();
  }
  // Typed as the dev-globals record alone (not the `typeof globalThis`
  // intersection) so the keyed write below type-checks against the one
  // property this function is generic over.
  const devGlobals: EpicSessionDevGlobals = globalThis as typeof globalThis &
    EpicSessionDevGlobals;
  const existing = devGlobals[key];
  if (existing !== undefined) {
    return existing;
  }
  const context = create();
  devGlobals[key] = context;
  return context;
}

/**
 * The RPC client resolved for the same host that owns `EpicSessionContext`.
 * Session-level provisioning prevents sidebar rows from independently mounting
 * host-directory subscriptions just to address the same Epic host.
 */
export const EpicSessionHostClientContext = createStableDevContext(
  "__TRAYCER_EPIC_SESSION_HOST_CLIENT_CONTEXT__",
  () => createContext<HostClient<HostRpcRegistry> | null>(null),
);

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
 * The session's host client, stamped by `epic-session-provider.tsx` from the
 * same value it provides through {@link EpicSessionHostClientContext} - for
 * the imperative callers (DnD commits) that run outside that subtree and
 * address the host the session's records live on. A `null` entry means the
 * session has no serving client right now; an absent entry, a handle the
 * provider never saw (tests).
 */
export const handleHostClients = new WeakMap<
  OpenEpicStoreHandle,
  HostClient<HostRpcRegistry> | null
>();

export function getEpicSessionHandleHostClient(
  handle: OpenEpicStoreHandle,
): HostClient<HostRpcRegistry> | null {
  return handleHostClients.get(handle) ?? null;
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

// `openEpicHostIds()` used to sit here - the per-open-epic producer set for
// agent activity (`s5-parity-gaps` gap 1), consumed by an
// `EpicHostActivityStreams` provider. Host-selected activity planes (#906)
// deleted both: there is now ONE `agent.activity.subscribe` stream on the
// SERVING transport, the host picks the view behind it, and
// `notifications-session-provider.tsx` states outright that opening a
// transport per host would be the renderer rebuilding the cross-host union the
// subsystem reserves to the host. The function outlived its only caller.
//
// Deleted rather than left dead, because its doc comment asserted a design
// that no longer exists and had already been read as current twice - it is
// what a review finding asking to "derive the producer set from open tabs'
// lifetime host bindings" was written against, which at HEAD would rebuild
// exactly the fan-out #906 removed. A dead function is harmless; a dead
// function whose comment describes a removed design is a source of false
// premises. Read `:741-756` of the notifications provider for the live rule.

/**
 * Test / production seam for the runtime WORKER - now the ONLY one.
 *
 * jsdom has no `Worker`, so every suite that mounts a session needs a
 * constructor it can supply. This sat "beside the stream one above" until that
 * one was deleted: a stream factory built on MAIN cannot cross `postMessage`
 * to a runtime that lives in the worker, so overriding it could not do what its
 * name promised, and the provider's own branch for it could only ever throw.
 *
 * A suite drives this session's stream by supplying a fake TRANSPORT at the
 * opener instead, and its own composition - if it wants a live replica - with
 * `createInProcessEpicRuntimeWorker` at this seam. Both reach the real host,
 * the real core and the real composition on their own thread.
 *
 * `null` uses the production constructor, which is the only path that calls
 * `new Worker(new URL(...))` - a form Vite must see literally, and which jsdom
 * cannot execute.
 */
export function getEpicRuntimeWorkerFactory(): () => RuntimeWorkerLike {
  return getEpicRuntimeWorkerFactoryOverride() ?? createEpicRuntimeWorker;
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
const EMPTY_LOCAL_HOMED_EPIC_IDS: ReadonlySet<string> = new Set();

interface LiveSessionSnapshotCache<T> {
  readonly signature: string;
  readonly snapshot: T;
}

/**
 * Subscribe to the live sessions for `epicIds` and project a cached snapshot.
 *
 * Both public live-session readers share this: canonicalize, bind a store
 * listener per `registry.peek(epicId)`, rebind on every registry emission,
 * then cache the projection on a `JSON.stringify` signature. Only the
 * projection differs.
 */
function useEpicReadLiveSessionSnapshot<T>(
  epicIds: ReadonlyArray<string>,
  project: (
    canonicalEpicIds: ReadonlyArray<string>,
  ) => LiveSessionSnapshotCache<T>,
  getServerSnapshot: () => T,
): T {
  // Keyed on the ids' CONTENTS, not the array's identity. Callers rebuild the
  // array on every render, and a memo keyed on it produced a new
  // `canonicalEpicIds` each time - then a new `subscribe`, so
  // `useSyncExternalStore` tore down and rebound every per-epic store listener
  // plus the registry listener on every commit. The signature cache below
  // already kept the renders stable; this keeps the subscriptions stable too.
  const epicIdsSignature = [...new Set(epicIds)]
    .sort((left, right) => left.localeCompare(right))
    .join("\u0000");
  const canonicalEpicIds = useMemo(
    (): ReadonlyArray<string> =>
      epicIdsSignature.length === 0 ? [] : epicIdsSignature.split("\u0000"),
    [epicIdsSignature],
  );
  const snapshotCache = useRef<LiveSessionSnapshotCache<T> | null>(null);
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
      // Rebound through the registry as well as each store: a session that is
      // acquired, re-pointed, or pruned changes the answer without any store
      // this closure is currently holding ever emitting.
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
  const getSnapshot = useCallback((): T => {
    const next = project(canonicalEpicIds);
    const cached = snapshotCache.current;
    if (cached?.signature === next.signature) return cached.snapshot;
    snapshotCache.current = next;
    return next.snapshot;
  }, [canonicalEpicIds, project]);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

function projectLiveChatEpicIds(
  canonicalEpicIds: ReadonlyArray<string>,
): LiveSessionSnapshotCache<Readonly<Record<string, string>>> {
  const entries = canonicalEpicIds.flatMap((epicId) =>
    (registry.peek(epicId)?.store.getState().chats.allIds ?? []).map(
      (chatId): readonly [string, string] => [chatId, epicId],
    ),
  );
  entries.sort(([left], [right]) => left.localeCompare(right));
  const snapshot: Readonly<Record<string, string>> =
    Object.fromEntries(entries);
  return { signature: JSON.stringify(entries), snapshot };
}

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
  return useEpicReadLiveSessionSnapshot(
    epicIds,
    projectLiveChatEpicIds,
    () => EMPTY_LIVE_CHAT_EPIC_IDS,
  );
}

/**
 * Whether a LIVE session says this epic is still local-homed.
 *
 * Reads the retained status beside the cycle's own, exactly as the pin gate's
 * sibling in `tab-strip-context-menu.tsx` reads both pause reasons. The store
 * documents why: `durabilityStatus` is cleared by a reconnect because last
 * cycle's answer is no evidence about this one, but where an epic is durable
 * is a property of the EPIC - a local-homed epic does not acquire a cloud room
 * by reconnecting - so a gate that fails dangerous on silence needs the
 * retained fact. This gate fails dangerous on silence: reading a local epic as
 * cloud offers a Pin the host can only refuse.
 *
 * Both fields are written only by a POSITIVE statement from the host, so no
 * separate `hasFreshCloudSyncStatus` gate is needed here - a non-null value is
 * already something the host said, never a pre-connect default.
 *
 * `promoting` counts as local for the same reason it does in
 * `useEpicHomeCacheSync`: the epic has no cloud row to carry a preference yet.
 * Matching that classifier rather than reasoning independently is deliberate -
 * two answers to "is this epic local-homed" that can disagree is the defect
 * shape, not the fix.
 *
 * FUTURE HOME: `currentOrRetainedDurabilityStatement` in `lib/epic-selectors.ts`
 * expresses this same current-then-retained ordering for the comment-room and
 * chat-backup gates. This gate should adopt it rather than stay a fourth
 * implementation - four copies of one ordering is the next divergence waiting
 * to happen, and the ordering is exactly what a reconnect exposes. Not adopted
 * today for two mechanical reasons, both cheap to remove: the helper is
 * module-private, and it returns a `pauseReason` alongside the status that
 * this gate has no use for (the pause-reason half is `usePreservedOrphanSession`'s
 * question, on the adjacent menu item). Whoever exports it should bring this
 * call site with it.
 */
function isLocalHomedLiveEpic(epicId: string): boolean {
  const state = registry.peek(epicId)?.store.getState();
  if (state === undefined) return false;
  const status =
    state.durabilityStatus ?? state.retainedDurabilityStatus ?? null;
  return status === "local" || status === "promoting";
}

function projectLocalHomedEpicIds(
  canonicalEpicIds: ReadonlyArray<string>,
): LiveSessionSnapshotCache<ReadonlySet<string>> {
  const matches = canonicalEpicIds.filter(isLocalHomedLiveEpic);
  const snapshot: ReadonlySet<string> = new Set(matches);
  return { signature: JSON.stringify(matches), snapshot };
}

/**
 * Which of `epicIds` a live session reports as local-homed.
 *
 * The tab strip learns about its epics through `epic.getTaskContexts` alone,
 * sent to the app-wide host. For `pinned` that is correct at any host - pin is
 * a cloud-only preference and every host proxies it to the cloud. Local-homed
 * ness is the one fact the wrong host cannot supply: the resolver overlays
 * OWNED local-home rows (`getTaskContextsResponseSchema@1.3`), so a host that
 * does not own the epic does not resolve the row at all, the id never reaches
 * the pinned-state map, and the Pin item sits disabled behind a spinner
 * forever instead of explaining that the epic is stored on this device.
 *
 * The epic's own session already holds that fact, so this asks it directly
 * rather than routing the RPC by a per-tab host binding. Same shape as
 * {@link useLiveChatEpicIdsForEpics} above and the same authority the pin
 * menu's orphan gate already uses - a live session's own state, not a second
 * answer derived somewhere else.
 *
 * LIVE SESSIONS ONLY, and that bound is real: an open epic tab with no session
 * (never mounted since reload, or pruned past the five-live MRU cap) is absent
 * from this set and keeps the spinner. Closing that residual needs a host
 * binding that outlives the session - a persisted `hostId` on the epic tab
 * record, the way `EpicNodeRecord.hostId` already binds chat/terminal tiles -
 * plus per-request clients in `useHostQueries`, which takes exactly one. That
 * is a deliberate design change against the rule in `stores/tabs/types.ts`
 * that persisting a host on the tab record creates a second authority, and it
 * is tracked separately rather than smuggled in here.
 */
export function useLocalHomedOpenEpicIds(
  epicIds: ReadonlyArray<string>,
): ReadonlySet<string> {
  return useEpicReadLiveSessionSnapshot(
    epicIds,
    projectLocalHomedEpicIds,
    () => EMPTY_LOCAL_HOMED_EPIC_IDS,
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
