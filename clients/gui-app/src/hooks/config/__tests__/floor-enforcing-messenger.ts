import {
  HostMethodVersionUnsatisfiedError,
  negotiatedVersionMeetsRequirement,
  type HostRequestOptions,
  type RequestOfMethod,
  type ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type {
  SchemaVersion,
  VersionedRpcRegistry,
} from "@traycer/protocol/framework/index";

/**
 * A `MockHostMessenger` that enforces `requiredHostMethodVersion` the way the
 * real transports do: against the version a connection NEGOTIATED for the
 * required method, before the request reaches a handler, refusing with
 * `HostMethodVersionUnsatisfiedError`. The mock alone only records a floor, so
 * without this a test cannot tell a write that carries one from a write that
 * does not. The predicate and the error are the transports' own.
 *
 * `negotiated` maps a method to the version the (simulated) handshake
 * advertised; a method it omits is "not advertised".
 */
export class FloorEnforcingMessenger<
  Registry extends VersionedRpcRegistry,
> extends MockHostMessenger<Registry> {
  private readonly negotiated: ReadonlyMap<string, SchemaVersion>;
  /** Methods whose handler ran, i.e. whose dispatch was not refused. */
  readonly dispatched: string[] = [];

  constructor(
    options: ConstructorParameters<typeof MockHostMessenger<Registry>>[0],
    negotiated: ReadonlyMap<string, SchemaVersion>,
  ) {
    super(options);
    this.negotiated = negotiated;
  }

  override async request<Method extends keyof Registry & string>(
    method: Method,
    params: RequestOfMethod<Registry, Method>,
    options: HostRequestOptions,
  ): Promise<ResponseOfMethod<Registry, Method>> {
    const floor = options.requiredHostMethodVersion;
    if (floor !== null) {
      const negotiated = this.negotiated.get(floor.method);
      if (!negotiatedVersionMeetsRequirement(negotiated, floor)) {
        throw new HostMethodVersionUnsatisfiedError({
          requirement: floor,
          negotiated,
          requestId: "req-floor-refused",
          method,
          hostId: options.authority.endpoint.hostId,
        });
      }
    }
    this.dispatched.push(method);
    return super.request(method, params, options);
  }
}
