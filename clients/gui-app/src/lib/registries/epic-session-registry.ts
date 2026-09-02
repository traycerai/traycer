import {
  createEpicRuntimeWorker,
  type RuntimeWorkerLike,
} from "@/stores/epics/open-epic/runtime/worker/spawn-epic-runtime-worker";
import { createContext, type Context } from "react";
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
  attributeEpicSessionTransportClose,
  isEpicSessionHandleDead,
  trackEpicSessionHandleLiveness,
  trackEpicSessionTransportCloseAttribution,
} from "@/stores/epics/open-epic/session-registry";
export type { EpicSessionTransportCloseTrigger } from "@/stores/epics/open-epic/session-registry";
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
    | Context<OpenEpicStoreHandle | null>
    | undefined;
  __TRAYCER_EPIC_SESSION_PRESENTATION_CONTEXT__:
    | Context<EpicSessionPresentation | null>
    | undefined;
  __TRAYCER_EPIC_SESSION_HOST_CLIENT_CONTEXT__:
    | Context<HostClient<HostRpcRegistry> | null>
    | undefined;
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
