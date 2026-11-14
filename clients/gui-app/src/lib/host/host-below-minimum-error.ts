import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { HOST_UPDATE_SKEW_COPY } from "@/lib/host/version-skew-copy";

/** A local version check stopped this request before any host dispatch. */
export class HostBelowMinimumError extends HostRpcError {
  constructor(details: {
    readonly requestId: string;
    readonly method: string;
  }) {
    super({
      code: "RPC_ERROR",
      message: HOST_UPDATE_SKEW_COPY.title,
      requestId: details.requestId,
      method: details.method,
      fatalDetails: null,
    });
    this.name = "HostBelowMinimumError";
  }
}
