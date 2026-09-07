import type {
  ConnectionManifest,
  MethodDegradeDeclaration,
  MethodVersionRegistry,
  SchemaVersion,
  VersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import { HostRpcError } from "./host-messenger";

/**
 * The one implementation of "this host does not advertise that method", shared by both transports.
 * A method kept off the released floor is negotiated away by a peer that lacks it, so every transport must answer the same way: apply the registry's declared degrade rather than inventing an error.
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
  /** Transport-specific dispatch of an already-negotiated method. */
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
