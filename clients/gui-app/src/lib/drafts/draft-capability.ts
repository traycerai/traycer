import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";

export function isDraftsCapabilityMissing(error: unknown): boolean {
  return error instanceof HostRpcError && error.code === "E_HOST_UNSUPPORTED";
}
