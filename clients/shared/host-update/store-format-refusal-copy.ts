import { HOST_STORE_FORMAT_FLOOR_CODE } from "@traycer/protocol/config/host-update-attempt";

/** Safe user-facing copy for the CLI's store-format refusal. */
export const HOST_STORE_FORMAT_REFUSAL_MESSAGE =
  "This update would install a host that cannot read this machine's data. Open Settings › Host to choose a compatible version.";

export function hostUpdateFailureMessage(
  errorCode: string | null,
  message: string,
): string {
  return errorCode === HOST_STORE_FORMAT_FLOOR_CODE
    ? HOST_STORE_FORMAT_REFUSAL_MESSAGE
    : message;
}
