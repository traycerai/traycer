import {
  HostRpcError,
  type HostRequestOptions,
  type IHostMessenger,
  type RequestOfMethod,
  type ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";

/**
 * Written by the unary messenger's outermost layer, so the recorded object is the
 * one a caller holds. An error with no entry is never covered by a door state.
 */
const sentTo = new WeakMap<HostRpcError, string>();

export function hostOfFailedCall(error: HostRpcError): string | null {
  return sentTo.get(error) ?? null;
}

export function recordingRefusedHost<Registry extends VersionedRpcRegistry>(
  inner: IHostMessenger<Registry>,
): IHostMessenger<Registry> {
  const note = (cause: unknown, options: HostRequestOptions): void => {
    if (cause instanceof HostRpcError)
      sentTo.set(cause, options.authority.endpoint.hostId);
  };
  return {
    async request<Method extends keyof Registry & string>(
      method: Method,
      params: RequestOfMethod<Registry, Method>,
      options: HostRequestOptions,
    ): Promise<ResponseOfMethod<Registry, Method>> {
      try {
        return await inner.request(method, params, options);
      } catch (cause) {
        note(cause, options);
        throw cause;
      }
    },
    async requestWithResponseTimeout<Method extends keyof Registry & string>(
      method: Method,
      params: RequestOfMethod<Registry, Method>,
      responseTimeoutMs: number,
      options: HostRequestOptions,
    ): Promise<ResponseOfMethod<Registry, Method>> {
      try {
        return await inner.requestWithResponseTimeout(
          method,
          params,
          responseTimeoutMs,
          options,
        );
      } catch (cause) {
        note(cause, options);
        throw cause;
      }
    },
  };
}
