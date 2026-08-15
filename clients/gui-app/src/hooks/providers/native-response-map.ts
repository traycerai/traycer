import type {
  NativeAuthResult,
  NativeListResult,
  NativeMutationResult,
  ProviderMcpServer,
  ProviderNativeErrorCode,
  ProviderNativeErrorResult,
  ProviderPlugin,
  ProviderPluginIcon,
  ProviderSkill,
  ProviderSkillInspectCandidate,
} from "@traycer/protocol/host/provider-native-schemas";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { nativeErrorMessage } from "@/lib/providers/native-error-copy";

export type ProvidersListWireResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.list"
>;
export type ProvidersNativeMutateWireResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.nativeMutate"
>;
export type ProvidersMcpAuthWireResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.mcpAuth"
>;

/** External list shapes preserved for tab consumers. */
export type McpListData = { readonly servers: readonly ProviderMcpServer[] };
export type PluginsListData = { readonly plugins: readonly ProviderPlugin[] };
export type SkillsListData = { readonly skills: readonly ProviderSkill[] };
export type McpDiscoverData = { readonly server: ProviderMcpServer };
export type PluginIconData = { readonly icon: ProviderPluginIcon };

/** External mutate success shapes (response-equals-state). */
export type McpMutateData = McpListData;
export type PluginsMutateData = PluginsListData;

export type SkillsInspectData = {
  readonly kind: "inspect";
  readonly token: string;
  readonly candidates: readonly ProviderSkillInspectCandidate[];
};

export type SkillsListMutateData = {
  readonly kind: "skills";
  readonly skills: readonly ProviderSkill[];
};

/** Inspect does not rewrite the listed set; create/import/remove do. */
export type SkillsMutateData = SkillsInspectData | SkillsListMutateData;

/** External auth result shape (unwraps `providers.mcpAuth`'s result). */
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
      // `nativeErrorMessage`, not `detail ?? code`. The panels render
      // `error.message` directly, so a protocol-valid `{ detail: null }` put
      // the raw enum member on screen ("Native provider error:
      // config_unreadable") and the friendly copy map was never consulted on
      // the list path at all. Building the message here fixes every code at
      // once rather than the one that happened to surface it, and
      // `nativeErrorMessage` already prefers a non-blank trimmed `detail`, so
      // a whitespace-only detail falls back too.
      message: nativeErrorMessage(args.code, args.detail),
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

/**
 * An icon is decoration: a host that cannot produce one answers
 * `{ dataUri: null }` rather than failing, and this mapper keeps that shape
 * instead of throwing. It DOES throw on a native error result or a mismatched
 * arm, because those mean the request itself did not do what was asked - an
 * older host that has never heard of `pluginIcon`, for instance.
 */
export function mapProvidersListToPluginIcon(args: {
  readonly response: ProvidersListWireResponse;
}): PluginIconData {
  const native = args.response.native;
  throwIfNativeError(native, "providers.list");
  if (native === null || native.kind !== "pluginIcon") {
    throw new ProviderNativeRpcError({
      code: "unsupported_action",
      detail: "Plugin icons are not supported by this host.",
      method: "providers.list",
    });
  }
  return { icon: native.icon };
}

export function mapNativeMutateToMcpMutate(args: {
  readonly response: ProvidersNativeMutateWireResponse;
}): McpMutateData {
  const result = args.response.result;
  throwIfNativeError(result, "providers.nativeMutate");
  if (result.kind !== "mcp") {
    throw new ProviderNativeRpcError({
      code: "unsupported_action",
      detail: "MCP mutation returned no servers payload.",
      method: "providers.nativeMutate",
    });
  }
  return { servers: result.servers };
}

export function mapNativeMutateToPluginsMutate(args: {
  readonly response: ProvidersNativeMutateWireResponse;
}): PluginsMutateData {
  const result = args.response.result;
  throwIfNativeError(result, "providers.nativeMutate");
  if (result.kind !== "plugins") {
    throw new ProviderNativeRpcError({
      code: "unsupported_action",
      detail: "Plugins mutation returned no plugins payload.",
      method: "providers.nativeMutate",
    });
  }
  return { plugins: result.plugins };
}

export function mapNativeMutateToSkillsMutate(args: {
  readonly response: ProvidersNativeMutateWireResponse;
}): SkillsMutateData {
  const result = args.response.result;
  throwIfNativeError(result, "providers.nativeMutate");
  if (result.kind === "skillsInspect") {
    return {
      kind: "inspect",
      token: result.token,
      candidates: result.candidates,
    };
  }
  if (result.kind !== "skills") {
    throw new ProviderNativeRpcError({
      code: "unsupported_action",
      detail: "Skills mutation returned no skills payload.",
      method: "providers.nativeMutate",
    });
  }
  return { kind: "skills", skills: result.skills };
}

export function mapMcpAuthResponse(args: {
  readonly response: ProvidersMcpAuthWireResponse;
}): McpAuthData {
  const result = args.response.result;
  if (result.kind === "error") {
    throw new ProviderNativeRpcError({
      code: result.code,
      detail: result.detail,
      method: "providers.mcpAuth",
    });
  }
  return { result };
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
