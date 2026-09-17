import {
  AUTHENTICATION_REQUIRED_MESSAGE,
  createStagingGitHubReleaseAuthPolicy,
  fetchGitHubReleaseAssetWithAuth,
  GitHubReleaseCredentialResolver,
  isAuthenticationRequiredError,
  STAGING_RELEASE_TOKEN_ENV,
} from "@traycer-clients/shared/github-release-auth";
import { config, configuredReleaseRepo } from "../config";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";

const policy = createStagingGitHubReleaseAuthPolicy(configuredReleaseRepo());
const resolver = new GitHubReleaseCredentialResolver();

/**
 * The registry fetch for this build. Production is plain `fetch`. Staging
 * reads a PRIVATE repository: its manifests, signatures and archives are all
 * `releases/download/...` browser URLs (the manifest URLs and the URLs inside
 * `versions.json` alike), which GitHub serves only to a browser session, so
 * each one is resolved through the release-assets API with the release token.
 */
export async function registryFetch(
  url: string,
  init: RequestInit,
): Promise<Response> {
  if (config.environment !== "staging") return fetch(url, init);
  if (policy === null) throw authenticationCliError();
  try {
    return await fetchGitHubReleaseAssetWithAuth(resolver, policy, url, init);
  } catch (error) {
    if (isAuthenticationRequiredError(error)) {
      throw authenticationCliError();
    }
    throw error;
  }
}

function authenticationCliError(): Error {
  return cliError({
    code: CLI_ERROR_CODES.RELEASE_AUTHENTICATION_REQUIRED,
    message: `${AUTHENTICATION_REQUIRED_MESSAGE} Set ${STAGING_RELEASE_TOKEN_ENV} or sign in with GitHub CLI (gh auth login).`,
    details: {
      environment: config.environment,
      releaseRepo: configuredReleaseRepo(),
    },
    exitCode: 1,
  });
}
