import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { environmentCloudHostError } from "@/lib/environment/environment-cloud-calls";

/** Only the successful local write's revision travels with this failure, never hook values. */
export class NotificationHooksAccountSaveError extends HostRpcError {
  readonly savedConfigurationRevision: string | null;

  constructor(error: unknown, savedConfigurationRevision: string | null) {
    const mapped = environmentCloudHostError(
      "host.notificationHooks.save",
      error,
    );
    super({
      code: mapped instanceof HostRpcError ? mapped.code : "RPC_ERROR",
      message:
        mapped instanceof HostRpcError
          ? mapped.message
          : "Couldn't save notification hooks.",
      requestId: "account-hooks-save",
      method: "host.notificationHooks.save",
      fatalDetails: null,
    });
    this.name = "NotificationHooksAccountSaveError";
    this.savedConfigurationRevision = savedConfigurationRevision;
  }
}
