import { createContext, type Context } from "react";
import {
  createHostRuntime,
  type HostRuntimeBinding,
} from "@/providers/host-runtime-provider";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";

type HostRuntimeContext = Context<HostRuntimeBinding<HostRpcRegistry> | null>;

interface HostRuntimeDevGlobals {
  __TRAYCER_HOST_RUNTIME_CONTEXT__: HostRuntimeContext | undefined;
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function createStableHostRuntimeContext(): HostRuntimeContext {
  // A normal page load evaluates this module once. During Vite HMR, however,
  // React can briefly retain a provider from one module generation while a
  // refreshed consumer reads hooks from the next. Keep only the context
  // identity stable across those generations; a real reload resets globalThis.
  // Vitest also exposes an import.meta.hot stub, but without Vite's data object,
  // so tests continue to receive an isolated context.
  const hotData: unknown = import.meta.hot?.data;
  if (!isObject(hotData)) {
    return createContext<HostRuntimeBinding<HostRpcRegistry> | null>(null);
  }

  const devGlobals = globalThis as typeof globalThis & HostRuntimeDevGlobals;
  const existing = devGlobals.__TRAYCER_HOST_RUNTIME_CONTEXT__;
  if (existing !== undefined) {
    return existing;
  }

  const context = createContext<HostRuntimeBinding<HostRpcRegistry> | null>(
    null,
  );
  devGlobals.__TRAYCER_HOST_RUNTIME_CONTEXT__ = context;
  return context;
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
  createStableHostRuntimeContext(),
);

export const HostRuntimeProvider = runtime.HostRuntimeProvider;
export const HostRuntimeContext = runtime.HostRuntimeContext;
export const useHostClient = runtime.useHostClient;
export const useHostDirectory = runtime.useHostDirectory;
export const useAuthService = runtime.useAuthService;
export const useHostBinding = runtime.useHostBinding;
export const getHostBindingSnapshot = runtime.getBindingSnapshot;
