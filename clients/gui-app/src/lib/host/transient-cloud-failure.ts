import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";

/**
 * Whether a host read failed only because the host could not get an answer
 * from the cloud: its egress budget refused the request
 * (`E_CLOUD_REQUEST_REFUSED`), or the cloud gave no verdict
 * (`E_CLOUD_UNREACHABLE`). Such a read is asked again when that host's
 * cloud-recovery doorbell rings (`cloud-recovery-doorbell-mount.tsx`), and a
 * read that already has data keeps showing it meanwhile.
 */
export function isTransientCloudFailure(error: unknown): boolean {
  return (
    error instanceof HostRpcError &&
    (error.code === "E_CLOUD_REQUEST_REFUSED" ||
      error.code === "E_CLOUD_UNREACHABLE")
  );
}
