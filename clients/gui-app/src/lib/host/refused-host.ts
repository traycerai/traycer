import {
  HostRpcError,
  type HostRequestOptions,
  type IHostMessenger,
  type RequestOfMethod,
  type ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { VersionedRpcRegistry } from "@traycer/protocol/framework/index";

/**
 * The host each failed call was sent to, keyed by the error the caller
 * catches. The app's unary messenger writes it as its outermost layer, so
 * the object recorded is the one a caller holds. The toast reads it to tell
 * whether a door state covers that host. An error with no entry was not sent
 * through that messenger, and no door state is taken to cover it.
 */
const sentTo = new WeakMap<HostRpcError, string>();

export function hostOfFailedCall(error: HostRpcError): string | null {
  return sentTo.get(error) ?? null;
}

/** `inner`, recording the host of every call that fails with a host error. */
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
