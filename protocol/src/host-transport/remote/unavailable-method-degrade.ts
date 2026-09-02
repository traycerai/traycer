import type {
  ConnectionManifest,
  MethodDegradeDeclaration,
  MethodVersionRegistry,
  SchemaVersion,
  VersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import { HostRpcError } from "./rpc-types";

/**
 * The ONE implementation of "this host does not advertise that method", shared
 * by both transports.
 *
 * A method kept off the released floor is negotiated away by a peer that
 * lacks it, so every transport must answer the same way: apply the registry's
 * DECLARED degrade rather than inventing an error. Callers key off that
 * outcome - `E_HOST_UNSUPPORTED` specifically, which surfaces as "this
 * feature needs a newer host" and which several call sites suppress to fall
 * back to legacy behavior (e.g. the run-settings write queue's
 * persist-on-next-send). A generic `RPC_ERROR` here reads as a real failure
 * and breaks those fallbacks.
 *
 * It lives here rather than inside either transport because the remote mux
 * session originally had no degrade path at all: its handshake fataled on any
 * method-set skew, so "host lacks an optional method" was unreachable, and
 * when the floor/optional split made it reachable the behavior had to be
 * written twice or shared once. Shared once - a third transport inherits it.
 *
 * Transport-specific execution (framing, timeouts, session plumbing) is
 * injected as {@link UnavailableMethodDegradeOptions.execute}; everything
 * else - which degrade applies, whether a fallback target is usable, and how
 * the fallback's request/response are adapted - is identical by construction.
 */
export interface UnavailableMethodDegradeOptions<
  Registry extends VersionedRpcRegistry,
> {
  readonly registry: Registry;
  readonly method: string;
  readonly methodRegistry: MethodVersionRegistry;
  /** The client's canonical version, or `undefined` when it has none either. */
  readonly clientCanonical: SchemaVersion | undefined;
  readonly clientManifest: ConnectionManifest;
  readonly hostManifest: ConnectionManifest;
  readonly params: unknown;
  readonly requestId: string;
  /** Transport-specific dispatch of an ALREADY-negotiated method. */
  readonly execute: (input: {
    readonly method: string;
    readonly methodRegistry: MethodVersionRegistry;
    readonly clientCanonical: SchemaVersion;
    readonly hostCanonical: SchemaVersion;
    readonly params: unknown;
  }) => Promise<unknown>;
}

/** The error a caller must see for "host too old for this method". */
export function unsupportedHostMethodError(
  method: string,
  requestId: string,
): HostRpcError {
  const reason = `This host does not support '${method}'. Upgrade the host to use this feature.`;
  return new HostRpcError({
    code: "E_HOST_UNSUPPORTED",
    message: reason,
    requestId,
    method,
    fatalDetails: {
      code: "E_HOST_UNSUPPORTED",
      reason,
      incompatibleMethods: null,
      // The host is the side that must move: the client already has the
      // method. Consumers read this to word the upgrade prompt.
      upgradeGuidance: {
        clientShouldUpgrade: false,
        hostShouldUpgrade: true,
      },
    },
  });
}

/**
 * Resolves a call to a method the host did not advertise, per the registry's
 * declared degrade. Throws `E_HOST_UNSUPPORTED` for an `unsupported` degrade
 * (or none declared beyond that), and otherwise routes through the declared
 * floor fallback.
 */
export async function resolveUnavailableMethodDegrade<
  Registry extends VersionedRpcRegistry,
>(options: UnavailableMethodDegradeOptions<Registry>): Promise<unknown> {
  const { method, requestId } = options;
  if (options.clientCanonical === undefined) {
    throw new HostRpcError({
      code: "RPC_ERROR",
      message: `Client registry has no canonical manifest entry for method '${method}'`,
      requestId,
      method,
      fatalDetails: null,
    });
  }

  const degrade: MethodDegradeDeclaration | undefined =
    options.methodRegistry.degrade;
  if (degrade === undefined) {
    throw new HostRpcError({
      code: "RPC_ERROR",
      message: `Host does not advertise method '${method}', and the client registry declares no degrade strategy`,
      requestId,
      method,
      fatalDetails: null,
    });
  }
  if (degrade.kind !== "fallback") {
    throw unsupportedHostMethodError(method, requestId);
  }

  const targetMethod = degrade.to.method;
  const targetRegistry = options.registry[targetMethod];
  if (targetRegistry === undefined) {
    throw new HostRpcError({
      code: "RPC_ERROR",
      message: `Fallback for method '${method}' targets unknown method '${targetMethod}'`,
      requestId,
      method,
      fatalDetails: null,
    });
  }

  const targetHostCanonical = options.hostManifest[targetMethod];
  if (
    options.clientManifest[targetMethod] === undefined ||
    targetHostCanonical === undefined
  ) {
    throw new HostRpcError({
      code: "RPC_ERROR",
      message: `Fallback for method '${method}' targets unavailable floor method '${targetMethod}'`,
      requestId,
      method,
      fatalDetails: null,
    });
  }

  const fallbackResult = await options.execute({
    method: targetMethod,
    methodRegistry: targetRegistry as MethodVersionRegistry,
    clientCanonical: { major: degrade.to.major, minor: degrade.to.minor },
    hostCanonical: targetHostCanonical,
    params: degrade.adaptRequest(options.params as never),
  });
  return degrade.adaptResponse(fallbackResult as never);
}
