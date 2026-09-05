import {
  AUTHENTICATION_REQUIRED_MESSAGE,
  createStagingGitHubReleaseAuthPolicy,
  fetchWithGitHubReleaseAuth,
  GitHubReleaseCredentialResolver,
  sanitizeCredentialTextWithSecrets,
} from "@traycer-clients/shared/github-release-auth";
import { config, configuredDesktopReleaseRepo } from "../../config";

const policy = createStagingGitHubReleaseAuthPolicy(
  configuredDesktopReleaseRepo(),
);
const resolver = new GitHubReleaseCredentialResolver();

export function stagingReleaseAuthRequired(): boolean {
  return config.environment === "staging";
}

export async function prepareStagingUpdateToken(): Promise<string | null> {
  if (!stagingReleaseAuthRequired() || policy === null) return null;
  try {
    return (await resolver.resolveOrThrow()).token;
  } catch {
    return null;
  }
}

export async function fetchStagingGitHubRelease(
  url: string,
  init: RequestInit,
): Promise<Response> {
  if (!stagingReleaseAuthRequired() || policy === null) {
    return fetch(url, init);
  }
  return fetchWithGitHubReleaseAuth(resolver, policy, url, init);
}

export function discardStagingUpdateToken(): void {
  resolver.discardLease();
}

/**
 * `releaseTokens` are every token the message may quote: the current lease
 * AND the one a concurrent error path may already have discarded, since
 * electron-updater can both emit `error` and reject `downloadUpdate()` for
 * the same failure.
 */
export function stagingAuthLogMessage(
  error: unknown,
  releaseTokens: readonly string[],
): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeCredentialTextWithSecrets(message, releaseTokens);
}

export { AUTHENTICATION_REQUIRED_MESSAGE };
