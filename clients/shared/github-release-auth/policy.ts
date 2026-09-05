import type { GitHubReleaseAuthPolicy, GitHubRepoCoordinate } from "./types";

const OWNER_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function createStagingGitHubReleaseAuthPolicy(
  releaseRepo: string,
): GitHubReleaseAuthPolicy | null {
  const repository = parseGitHubRepoCoordinate(releaseRepo);
  return repository === null
    ? null
    : {
        repository,
        authorizedOrigins: ["https://github.com", "https://api.github.com"],
      };
}

export function parseGitHubRepoCoordinate(
  value: string,
): GitHubRepoCoordinate | null {
  const normalized = value.trim();
  if (!OWNER_REPO.test(normalized)) return null;
  const [owner, repo] = normalized.split("/");
  return { owner, repo };
}

export function isAuthorizedGitHubReleaseUrl(
  url: URL,
  policy: GitHubReleaseAuthPolicy,
): boolean {
  if (!policy.authorizedOrigins.includes(url.origin)) return false;
  const owner = encodeURIComponent(policy.repository.owner).toLowerCase();
  const repo = encodeURIComponent(policy.repository.repo).toLowerCase();
  const pathname = url.pathname.toLowerCase();
  const prefix =
    url.hostname === "api.github.com"
      ? `/repos/${owner}/${repo}`
      : `/${owner}/${repo}`;
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}
