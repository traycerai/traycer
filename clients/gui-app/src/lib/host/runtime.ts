import { useMemo } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  createHostRuntime,
  createHostRuntimeState,
  type HostRuntimeState,
} from "@/providers/host-runtime-provider";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { useEffectiveHostId } from "@/hooks/host/use-effective-host-id";
import { readEffectiveHostIdSnapshot } from "@/stores/host/selection-authority-store";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import {
  resolveAppWideHostClient,
  resolveSubtreeHostClient,
} from "@/lib/host/binding-host-client";

type AppHostRuntimeState = HostRuntimeState<HostRpcRegistry>;

interface HostRuntimeDevGlobals {
  __TRAYCER_HOST_RUNTIME_STATE__: AppHostRuntimeState | undefined;
}

function createStableHostRuntimeState(): AppHostRuntimeState {
  // A normal page load evaluates this module once. During Vite HMR, however,
  // React can briefly retain a provider from one module generation while a
  // refreshed consumer reads hooks from the next. Keep the whole runtime
  // state stable across those generations; a real reload resets globalThis.
  // Vitest's import.meta.hot stub exercises this same module-reimport path.
  if (import.meta.hot === undefined) {
    return createHostRuntimeState<HostRpcRegistry>();
  }

  const devGlobals = globalThis as typeof globalThis & HostRuntimeDevGlobals;
  const existing = devGlobals.__TRAYCER_HOST_RUNTIME_STATE__;
  if (existing !== undefined) {
    return existing;
  }

  const state = createHostRuntimeState<HostRpcRegistry>();
  devGlobals.__TRAYCER_HOST_RUNTIME_STATE__ = state;
  return state;
}

/**
 * Typed host-runtime hook bundle bound to the host's published
 * registry.
 *
 * Every consumer that needs to call `host.*` methods, observe the active
 * binding, reach the GUI-owned `AuthService`, or inspect the directory
 * reads from this bundle so the typing flows from one declared registry
 * instead of being widened back to `VersionedRpcRegistry`.
 */
const runtime = createHostRuntime<HostRpcRegistry>(
  hostRpcSchedulingPolicy,
  createStableHostRuntimeState(),
);

export const HostRuntimeProvider = runtime.HostRuntimeProvider;
export const HostRuntimeContext = runtime.HostRuntimeContext;

/**
 * The window's ONE `HostClient` instance - the transport spine that owns the
 * messenger, the request coordinator, the binding-authority registry and the
 * request context.
 *
 * NOT a host. It is what a host id is resolved AGAINST. It answers no host
 * identity at all: the active slot it used to answer from is gone (redesign
 * D17 / P4.2), so `getActiveHostId()` here is a constant `null`.
 *
 * Its callers are the two EXPLICIT-host hooks in `hooks/host/`
 * (`use-host-client-for`, `use-host-client-for-host-id`), which name the host
 * they want.
 *
 * This docstring used to claim the spine had no OTHER reachable form -
 * "everything else wants a client for a named host and must say which one" -
 * and that was already false when it was written, which is part of why the
 * pinning defect stayed invisible. The same object is also `binding.hostClient`,
 * and ten sites took it from there and resolved a name against it inline. The
 * inline idiom is gone (`lib/host/binding-host-client.ts` is its one home) but
 * the object is still reachable that way, so the rule is "resolve through a
 * resolver", not "you cannot get here".
 */
export const useHostRuntimeClient = runtime.useHostClient;

/**
 * The host client for THIS SUBTREE: the binding's own host when it names one,
 * and otherwise the selection layer's `effectiveHostId`, resolved through the
 * same pinned-requester mechanism a surface pin resolves its own host through
 * (redesign D17 / P2.1).
 *
 * "This subtree" and "the app" are the same host everywhere except beneath a
 * re-provided `HostRuntimeContext` — the seven host-scoped surfaces listed on
 * `useScopedHostBinding`. Beneath one, this is the host the page is SHOWING,
 * which is what those surfaces have always claimed and, until `hostId` existed,
 * never got.
 *
 * Before this, a window-global consumer held the spine itself and every call
 * it made read whatever host happened to be bound at that instant. That is
 * the privileged bound identity D17 removes: it made "which host am I talking
 * to" a property of app-wide state rather than of the caller, so an
 * activation elsewhere in the app re-aimed calls already in flight and every
 * consumer had to be defended against a move it never asked about.
 *
 * Now the id comes from the selection layer and the client is pinned to it
 * for as long as it IS the effective host. A consumer re-renders with a new
 * client when the effective host moves - which is the point at which it
 * should re-point - and a call already aimed at the outgoing host completes
 * against the outgoing host.
 *
 * `null` (∅ - nothing usable) resolves to a requester that addresses no host:
 * `getActiveHostId()` is `null` and requests reject with the preflight error,
 * exactly as an unbound client always did, so every readiness gate keeps
 * reading the value it read before.
 */
export function useHostClient(): HostClient<HostRpcRegistry> {
  const binding = useHostBinding();
  const effectiveHostId = useEffectiveHostId();
  const client = useMemo(
    () => resolveSubtreeHostClient(binding, effectiveHostId),
    [binding, effectiveHostId],
  );
  // AFTER every hook, never before one: this is the no-provider case, and an
  // early return above a hook call would make the hook order conditional.
  if (client === null) {
    throw new Error(
      "Host runtime hooks must be used inside a <HostRuntimeProvider>.",
    );
  }
  return client;
}

/**
 * {@link useHostClient} for a caller that has no render to hang a hook on -
 * router context, a command action, anything reading the app-wide host once at
 * an event edge.
 *
 * Resolves the effective host id and the client to address it in ONE read, so
 * a caller that needs both cannot be handed a client for a host whose id it
 * read a moment earlier (`client.getActiveHostId()` is the id, and it answers
 * `null` on the same conditions the id-pinned requester always has). Before
 * P4.2 these callers took the spine and asked it which host was bound; the
 * spine no longer holds an identity, so asking it would return `null` forever.
 */
export function getAppHostClientSnapshot(): HostClient<HostRpcRegistry> | null {
  // App-wide by construction, not by choice: `getBindingSnapshot()` is the
  // PROVIDER's binding, which a `HostRuntimeContext` re-provide cannot reach —
  // context is a render-tree fact and this has no render tree. Stated through
  // the app-wide resolver so the one raw `createRequesterForHostId` idiom this
  // file used to spell nine ways has exactly one home left.
  return resolveAppWideHostClient(
    runtime.getBindingSnapshot(),
    readEffectiveHostIdSnapshot(),
  );
}

export const useHostDirectory = runtime.useHostDirectory;
export const useAuthService = runtime.useAuthService;
export const useHostBinding = runtime.useHostBinding;
export const getHostBindingSnapshot = runtime.getBindingSnapshot;

/**
 * The app-wide effective host id, imperatively, for callers outside React (the
 * command palette's actions, tab navigation, the landing draft store). `null`
 * when nothing is usable yet - the same "follow the app-wide default, and
 * there isn't one" case the host-scoped stores treat as a no-op. Lives here so
 * the read has ONE home: the per-host stores are read from several non-hook
 * call sites, and a later fix to this chain must not land in only some.
 *
 * Reads the AUTHORITY's projection, not the spine. Asking the spine was the
 * original shape and it is now a permanent `null`: P4.2/D17 removed the active
 * slot, so `getActiveHostId()` answers ∅ for every host by design (see
 * `HostClient`). Every one of these callers keys a per-host bucket - global run
 * settings, workspace folders - so a silent `null` did not fail loudly; it
 * selected the UNRESOLVED-host bucket and quietly lost the real host's saved
 * settings and folders. Same source as {@link getAppHostClientSnapshot}.
 */
export function activeHostIdOrNull(): string | null {
  return readEffectiveHostIdSnapshot();
}
