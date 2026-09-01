import { STAGING_RELEASE_TOKEN_ENV } from "./types";

/** Prevent the release credential from reaching Host/provider processes. */
export function stripGitHubReleaseCredentialsFromEnv(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (!(STAGING_RELEASE_TOKEN_ENV in env)) return env;
  const clean = { ...env };
  delete clean[STAGING_RELEASE_TOKEN_ENV];
  return clean;
}
