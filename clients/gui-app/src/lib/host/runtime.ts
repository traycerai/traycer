import {
  createHostRuntime,
  createHostRuntimeState,
  type HostRuntimeState,
} from "@/providers/host-runtime-provider";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
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
export const useHostClient = runtime.useHostClient;
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
