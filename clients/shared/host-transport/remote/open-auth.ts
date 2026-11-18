import type { RemoteHostDirectoryEntry } from "../../host-client/remote-fetcher";

export type RemoteOpenAuth = "user-bearer" | "session-grant";

export type HostOpenAuthFacts =
  | Pick<RemoteHostDirectoryEntry, "owner" | "sandbox">
  | { readonly localAdmission: "SESSION_GRANT_REQUIRED" | null };

/** Ownership comes from the directory, or from the local door's typed challenge. */
export function remoteOpenAuthFor(target: HostOpenAuthFacts): RemoteOpenAuth {
  if ("localAdmission" in target) {
    return target.localAdmission === "SESSION_GRANT_REQUIRED"
      ? "session-grant"
      : "user-bearer";
  }
  return target.sandbox !== null || target.owner?.kind === "team"
    ? "session-grant"
    : "user-bearer";
}
