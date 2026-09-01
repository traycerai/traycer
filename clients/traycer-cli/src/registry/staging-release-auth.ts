import {
  AUTHENTICATION_REQUIRED_MESSAGE,
  createStagingGitHubReleaseAuthPolicy,
  fetchWithGitHubReleaseAuth,
  GitHubReleaseCredentialResolver,
  isAuthenticationRequiredError,
  STAGING_RELEASE_TOKEN_ENV,
} from "@traycer-clients/shared/github-release-auth";
import { config, configuredReleaseRepo } from "../config";
import { CLI_ERROR_CODES, cliError } from "../runner/errors";

const policy = createStagingGitHubReleaseAuthPolicy(configuredReleaseRepo());
const resolver = new GitHubReleaseCredentialResolver();

export async function registryFetch(
  url: string,
  init: RequestInit,
): Promise<Response> {
  if (config.environment !== "staging") return fetch(url, init);
  if (policy === null) throw authenticationCliError();
  try {
    return await fetchWithGitHubReleaseAuth(resolver, policy, url, init);
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
