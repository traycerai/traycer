import { validateAuthTokenViaHttp } from "../../../shared/auth/auth-validation";
import {
  readCredentials,
  writeCredentials,
  type StoredCredentials,
} from "../store/credentials";

export type ValidationOutcome =
  | { readonly kind: "no-credentials" }
  | { readonly kind: "rejected" }
  | { readonly kind: "network-error" }
  | { readonly kind: "valid"; readonly credentials: StoredCredentials };

/**
 * Reads stored credentials and round-trips them against the authn service.
 * If the helper auto-refreshed, the rotated token is persisted before
 * returning so a follow-up call uses the new bearer.
 */
export async function validateStoredCredentials(): Promise<ValidationOutcome> {
  const stored = await readCredentials();
  if (stored === null) return { kind: "no-credentials" };

  const result = await validateAuthTokenViaHttp(
    stored.authnBaseUrl,
    stored.token,
    stored.refreshToken,
  );
  if (result.kind === "rejected") return { kind: "rejected" };
  if (result.kind === "network-error") return { kind: "network-error" };

  const nextToken =
    "refreshedToken" in result ? result.refreshedToken : stored.token;
  const nextRefreshToken =
    "refreshedRefreshToken" in result
      ? result.refreshedRefreshToken
      : stored.refreshToken;
  const nextUser = {
    id: result.profile.userId,
    email: result.profile.email,
    name: result.profile.userName,
  };
  const tokenChanged =
    nextToken !== stored.token || nextRefreshToken !== stored.refreshToken;
  const userChanged =
    nextUser.id !== stored.user.id ||
    nextUser.email !== stored.user.email ||
    nextUser.name !== stored.user.name;
  const refreshed: StoredCredentials = tokenChanged || userChanged
    ? {
        token: nextToken,
        refreshToken: nextRefreshToken,
        authnBaseUrl: stored.authnBaseUrl,
        savedAt: new Date().toISOString(),
        user: nextUser,
      }
    : stored;
  if (refreshed !== stored) await writeCredentials(refreshed);
  return { kind: "valid", credentials: refreshed };
}
