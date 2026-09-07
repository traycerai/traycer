/**
 * The GitHub host a bare mention token or reference implies, and the ONE predicate deciding whether a host is that default.
 * Every omit-the-default decision (serializer suffixes here in protocol, the gui token builder, prose references, ranking rewrites) must go through this function rather than restating the compare.
 */
export const DEFAULT_GITHUB_MENTION_HOST = "github.com";

export function isDefaultGithubMentionHost(githubHost: string): boolean {
  return githubHost.toLowerCase() === DEFAULT_GITHUB_MENTION_HOST;
}
