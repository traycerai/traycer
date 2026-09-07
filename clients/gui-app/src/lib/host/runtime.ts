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
  // A normal page load evaluates this module once.
  // During Vite HMR, however, React can briefly retain a provider from one module generation while a refreshed consumer reads hooks from the next.
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

/** Typed host-runtime hook bundle bound to the host's published registry. */
const runtime = createHostRuntime<HostRpcRegistry>(
  hostRpcSchedulingPolicy,
  createStableHostRuntimeState(),
);

export const HostRuntimeProvider = runtime.HostRuntimeProvider;
export const HostRuntimeContext = runtime.HostRuntimeContext;

/**
 * The window's ONE `HostClient` instance - the transport spine that owns the messenger, the request coordinator, the binding-authority registry and the request context.
 */
export const useHostRuntimeClient = runtime.useHostClient;

/**
 * Host client for this subtree: the binding's host when named, otherwise pinned `effectiveHostId`.
 * Empty selection resolves to a requester that addresses no host; in-flight calls complete against the outgoing host.
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
 * {@link useHostClient} for a caller that has no render to hang a hook on - router context, a command action, anything reading the app-wide host once at an event edge.
 */
export function getAppHostClientSnapshot(): HostClient<HostRpcRegistry> | null {
  // App-wide by construction, not by choice: `getBindingSnapshot()` is the PROVIDER's binding, which a `HostRuntimeContext` re-provide cannot reach - context is a render-tree fact and this has no render tree.
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
 * The app-wide effective host id, imperatively, for callers outside React (the command palette's actions, tab navigation, the landing draft store).
 * `null` when nothing is usable yet - the same "follow the app-wide default, and there isn't one" case the host-scoped stores treat as a no-op.
 */
export function activeHostIdOrNull(): string | null {
  return readEffectiveHostIdSnapshot();
}
