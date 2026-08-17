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
 * NOT a host. It is what a host id is resolved AGAINST, which is why its only
 * callers are the resolution hooks below and in `hooks/host/`: everything
 * else wants a client for a named host and must say which one. It answers no
 * host identity at all: the active slot it used to answer from is gone
 * (redesign D17 / P4.2), so `getActiveHostId()` here is a constant `null`.
 */
export const useHostRuntimeClient = runtime.useHostClient;

/**
 * The app-wide host client: the selection layer's `effectiveHostId`, resolved
 * through the same pinned-requester mechanism a surface pin resolves its own
 * host through (redesign D17 / P2.1).
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
  const spine = useHostRuntimeClient();
  const effectiveHostId = useEffectiveHostId();
  return useMemo(
    () => spine.createRequesterForHostId(effectiveHostId),
    [spine, effectiveHostId],
  );
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
  const spine = runtime.getBindingSnapshot()?.hostClient ?? null;
  if (spine === null) {
    return null;
  }
  return spine.createRequesterForHostId(readEffectiveHostIdSnapshot());
}

export const useHostDirectory = runtime.useHostDirectory;
export const useAuthService = runtime.useAuthService;
export const useHostBinding = runtime.useHostBinding;
export const getHostBindingSnapshot = runtime.getBindingSnapshot;

/**
 * The app-wide active host id, imperatively, for callers outside React (the
 * command palette's actions, tab navigation). `null` when nothing is bound
 * yet - the same "follow the app-wide default, and there isn't one" case the
 * host-scoped stores treat as a no-op. Lives here so the binding-snapshot
 * guard has ONE home: the per-host stores are read from several non-hook
 * call sites, and a later fix to this chain must not land in only some.
 */
export function activeHostIdOrNull(): string | null {
  return getHostBindingSnapshot()?.hostClient.getActiveHostId() ?? null;
}
