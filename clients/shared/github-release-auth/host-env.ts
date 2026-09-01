import { STAGING_RELEASE_TOKEN_ENV } from "./types";

/**
 * Prevent the release credential from reaching Host/provider processes.
 *
 * Windows environment names are case-insensitive: the resolver reads a token
 * supplied as `Traycer_Staging_Release_Token`, but a spread copy keeps that
 * spelling, so an exact-case delete would hand the child the token under the
 * original name. Strip every casing there; elsewhere names are case-sensitive
 * and only the exact name is the credential.
 */
export function stripGitHubReleaseCredentialsFromEnv(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const isCredential =
    platform === "win32"
      ? (key: string) => key.toUpperCase() === STAGING_RELEASE_TOKEN_ENV
      : (key: string) => key === STAGING_RELEASE_TOKEN_ENV;
  const keys = Object.keys(env).filter(isCredential);
  if (keys.length === 0) return env;
  const clean = { ...env };
  for (const key of keys) delete clean[key];
  return clean;
}
