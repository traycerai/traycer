import type { HostRpcRegistry } from "@traycer/protocol/host/registry";
import type {
  HostTransportEndpoint,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { isAgentSession } from "../agent-worktree-create";
import { runByDesktop } from "../host/update-contender";
import { CLI_ERROR_CODES, CliError } from "../runner/errors";
import { resolveHostAuth } from "./host-auth";
import {
  callHostRpcAtResolvedEndpoint,
  hostRpcToCliError,
  PLAIN_DISPATCH,
  resolveEndpoint,
} from "./host-rpc";

type ConfigWriteMethod =
  | "config.shell.set"
  | "config.shell.reset"
  | "config.shell.add"
  | "config.shell.remove"
  | "config.shell.revertArgs"
  | "config.env.set"
  | "config.env.delete";

/** Null selects the existing file road, only before any request is sent. */
export async function writeConfigViaRunningHost<
  Method extends ConfigWriteMethod,
>(
  method: Method,
  params: RequestOfMethod<HostRpcRegistry, Method>,
): Promise<ResponseOfMethod<HostRpcRegistry, Method> | null> {
  // Desktop's local fallback and agent commands still edit the shared file.
  if (isAgentSession(process.env) || runByDesktop()) return null;
  const auth = await resolveHostAuth();
  if (auth === null) return null;
  let endpoint: HostTransportEndpoint;
  try {
    endpoint = await resolveEndpoint();
  } catch (error) {
    if (
      error instanceof CliError &&
      error.code === CLI_ERROR_CODES.HOST_NOT_RUNNING
    )
      return null;
    throw error;
  }
  try {
    return await callHostRpcAtResolvedEndpoint(
      method,
      params,
      endpoint,
      auth,
      PLAIN_DISPATCH,
    );
  } catch (error) {
    // A refusal or lost answer cannot authorize a second write to the file.
    throw hostRpcToCliError(error);
  }
}
