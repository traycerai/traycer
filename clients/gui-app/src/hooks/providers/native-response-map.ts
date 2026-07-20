import type {
  NativeAuthResult,
  NativeListResult,
  NativeMutationResult,
  ProviderMcpServer,
  ProviderNativeErrorCode,
  ProviderNativeErrorResult,
  ProviderPlugin,
  ProviderSkill,
} from "@traycer/protocol/host/provider-native-schemas";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";

export type ProvidersListWireResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.list"
>;
export type ProvidersSetEnabledWireResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.setEnabled"
>;
export type ProvidersStartLoginWireResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.startLogin"
>;

/** External list shapes preserved for tab consumers. */
export type McpListData = { readonly servers: readonly ProviderMcpServer[] };
export type PluginsListData = { readonly plugins: readonly ProviderPlugin[] };
export type SkillsListData = { readonly skills: readonly ProviderSkill[] };
export type McpDiscoverData = { readonly server: ProviderMcpServer };

/** External mutate success shapes (response-equals-state). */
export type McpMutateData = McpListData;
export type PluginsMutateData = PluginsListData;
export type SkillsMutateData = SkillsListData;

/** External auth result shape (unwraps `mcpAuth` from startLogin). */
export type McpAuthData = { readonly result: NativeAuthResult };

export class ProviderNativeRpcError extends HostRpcError {
  readonly nativeCode: ProviderNativeErrorCode;
  readonly nativeDetail: string | null;

  constructor(args: {
    readonly code: ProviderNativeErrorCode;
    readonly detail: string | null;
    readonly method: string;
  }) {
    super({
      code: "RPC_ERROR",
      message: args.detail ?? `Native provider error: ${args.code}`,
      requestId: "native-error",
      method: args.method,
      fatalDetails: null,
    });
    this.name = "ProviderNativeRpcError";
    this.nativeCode = args.code;
    this.nativeDetail = args.detail;
  }
}

export function isProviderNativeRpcError(
  error: unknown,
): error is ProviderNativeRpcError {
  return error instanceof ProviderNativeRpcError;
}

function throwIfNativeError(
  result: NativeListResult | NativeMutationResult | null,
  method: string,
): asserts result is Exclude<
  NativeListResult | NativeMutationResult,
  ProviderNativeErrorResult
> | null {
  if (result !== null && !result.ok) {
    throw new ProviderNativeRpcError({
      code: result.code,
      detail: result.detail,
      method,
    });
  }
}

export function mapProvidersListToMcpServers(args: {
  readonly response: ProvidersListWireResponse;
}): McpListData {
  const native = args.response.native;
  throwIfNativeError(native, "providers.list");
  if (native === null || native.kind !== "mcp") {
    return { servers: [] };
  }
  return { servers: native.servers };
}

export function mapProvidersListToPlugins(args: {
  readonly response: ProvidersListWireResponse;
}): PluginsListData {
  const native = args.response.native;
  throwIfNativeError(native, "providers.list");
  if (native === null || native.kind !== "plugins") {
    return { plugins: [] };
  }
  return { plugins: native.plugins };
}

export function mapProvidersListToSkills(args: {
  readonly response: ProvidersListWireResponse;
}): SkillsListData {
  const native = args.response.native;
  throwIfNativeError(native, "providers.list");
  if (native === null || native.kind !== "skills") {
    return { skills: [] };
  }
  return { skills: native.skills };
}

export function mapProvidersListToMcpDiscover(args: {
  readonly response: ProvidersListWireResponse;
}): McpDiscoverData {
  const native = args.response.native;
  throwIfNativeError(native, "providers.list");
  if (native === null || native.kind !== "mcpDiscover") {
    throw new ProviderNativeRpcError({
      code: "unsupported_action",
      detail: "MCP discover returned no server payload.",
      method: "providers.list",
    });
  }
  return { server: native.server };
}

export function mapSetEnabledToMcpMutate(args: {
  readonly response: ProvidersSetEnabledWireResponse;
}): McpMutateData {
  const native = args.response.native;
  throwIfNativeError(native, "providers.setEnabled");
  if (native === null || native.kind !== "mcp") {
    throw new ProviderNativeRpcError({
      code: "unsupported_action",
      detail: "MCP mutation returned no servers payload.",
      method: "providers.setEnabled",
    });
  }
  return { servers: native.servers };
}

export function mapSetEnabledToPluginsMutate(args: {
  readonly response: ProvidersSetEnabledWireResponse;
}): PluginsMutateData {
  const native = args.response.native;
  throwIfNativeError(native, "providers.setEnabled");
  if (native === null || native.kind !== "plugins") {
    throw new ProviderNativeRpcError({
      code: "unsupported_action",
      detail: "Plugins mutation returned no plugins payload.",
      method: "providers.setEnabled",
    });
  }
  return { plugins: native.plugins };
}

export function mapSetEnabledToSkillsMutate(args: {
  readonly response: ProvidersSetEnabledWireResponse;
}): SkillsMutateData {
  const native = args.response.native;
  throwIfNativeError(native, "providers.setEnabled");
  if (native === null || native.kind !== "skills") {
    throw new ProviderNativeRpcError({
      code: "unsupported_action",
      detail: "Skills mutation returned no skills payload.",
      method: "providers.setEnabled",
    });
  }
  return { skills: native.skills };
}

export function mapStartLoginToMcpAuth(args: {
  readonly response: ProvidersStartLoginWireResponse;
}): McpAuthData {
  const mcpAuth = args.response.mcpAuth;
  if (mcpAuth === null) {
    throw new ProviderNativeRpcError({
      code: "unsupported_action",
      detail: "MCP auth returned no result payload.",
      method: "providers.startLogin",
    });
  }
  if (mcpAuth.kind === "error") {
    throw new ProviderNativeRpcError({
      code: mcpAuth.code,
      detail: mcpAuth.detail,
      method: "providers.startLogin",
    });
  }
  return { result: mcpAuth };
}

/**
 * Feature detection for native tabs: `nativeCapabilities.mcp|plugins|skills`
 * is null when the host/provider does not support the surface (old hosts get
 * DEFAULT via `.catch`, which sets all three to null).
 */
export function isNativeSurfaceSupported(
  caps:
    | {
        readonly mcp: unknown;
        readonly plugins: unknown;
        readonly skills: unknown;
      }
    | null
    | undefined,
  surface: "mcp" | "plugins" | "skills",
): boolean {
  if (caps === null || caps === undefined) return false;
  return caps[surface] !== null;
}
