/**
 * Thrown when the cloud collab-token mint endpoints reject a request with HTTP 403 + body `{ code: "FREE_TIER_NO_CLOUD_SYNC" }`.
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
