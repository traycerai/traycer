/**
 * Thrown when the cloud collab-token mint endpoints reject a request with
 * HTTP 403 + body `{ code: "FREE_TIER_NO_CLOUD_SYNC" }`. The server is the
 * authoritative gate; the Traycer Host recognizes this code only so callers can
 * abort connected-storage construction (epic / notification room) and fall
 * back to the existing local-only / offline path without retrying.
 *
 * Lives in @traycer/protocol so server, Traycer Host, and clients can all reach
 * the same shape (the lint boundary blocks `@traycerai/*` from clients).
 */
export class FreeTierNoCloudSyncError extends Error {
  constructor(reason: string) {
    super(`Cloud sync disabled for free tier: ${reason}`);
    this.name = "FreeTierNoCloudSyncError";
  }
}

export function isFreeTierNoCloudSyncBody(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    "code" in body &&
    body.code === "FREE_TIER_NO_CLOUD_SYNC"
  );
}
