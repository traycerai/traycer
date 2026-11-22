import {
  HostRpcError,
  type HostRequestOptions,
} from "../../../../shared/host-transport/host-messenger";
import type { WsRpcClientOptions } from "../../../../shared/host-transport/ws-rpc-client";
import type { HostRpcRegistry } from "@traycer/protocol/host/registry";

/**
 * What a stubbed `WsRpcClient` does before it sends, as the real client does at
 * its first dial of a call: ask `hostBearerFor` without waiting for the mint;
 * with no token to present (the probe), a current host names its reason, and
 * the call asks again, now awaiting the mint. `null` after that is the real
 * client's "no host-only token" refusal.
 */
export async function resolveStubbedCallBearer(
  clientOptions: WsRpcClientOptions<HostRpcRegistry>,
  method: string,
  options: HostRequestOptions,
): Promise<HostRequestOptions> {
  const hostBearerFor = clientOptions.hostBearerFor;
  if (hostBearerFor === undefined) return options;
  const hostId = options.authority.endpoint.hostId;
  const signIn = options.authority.bearer;
  // The call's own lifetime, as the real client hands it.
  const callSignal = options.authority.abortSignal;
  const bearer =
    (await hostBearerFor(hostId, signIn, false, callSignal)) ??
    (await hostBearerFor(hostId, signIn, true, callSignal));
  if (bearer === null) {
    throw new HostRpcError({
      code: "RPC_ERROR",
      message: "No host-only token is held for this host",
      requestId: "stubbed-no-host-token",
      method,
      fatalDetails: null,
    });
  }
  return { ...options, authority: { ...options.authority, bearer } };
}
