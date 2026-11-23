import {
  HostRpcError,
  type HostRequestOptions,
} from "../../../../shared/host-transport/host-messenger";
import type { WsRpcClientOptions } from "../../../../shared/host-transport/ws-rpc-client";
import type { HostRpcRegistry } from "@traycer/protocol/host/registry";

/**
 * What a stubbed `WsRpcClient` does before it sends, in the real client's
 * order: the first ask is `hostBearerFor` without waiting for a mint, and
 * answers the token the call already holds. With none held, the real client
 * opens with the no-token probe and the host names its reason; this stub stands
 * in for that probe as a current host that named its reason, and only then asks
 * again, awaiting the mint. `null` after that is the real client's "no
 * host-only token" refusal. The probe itself and a call that never gets a token
 * are covered through the real client in
 * `local-door-while-authn-unreachable.test.ts`.
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
  const held = await hostBearerFor(hostId, signIn, false, callSignal);
  // The probe: no token to present, and a current host names its reason.
  const bearer =
    held ?? (await hostBearerFor(hostId, signIn, true, callSignal));
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
