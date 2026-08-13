/**
 * The GitHub host a bare mention token or reference implies, and the ONE
 * predicate deciding whether a host is that default.
 *
 * GitHub host identity is case-insensitive on the wire (the mention row
 * schema permits any casing), so the check folds: `GitHub.com` IS the default
 * host, and a surface that compares verbatim treats it as an enterprise host
 * - asserting a host qualification the identity layer says does not exist.
 * Every omit-the-default decision (serializer suffixes here in protocol, the
 * gui token builder, prose references, ranking rewrites) must go through this
 * function rather than restating the compare.
 */
export const DEFAULT_GITHUB_MENTION_HOST = "github.com";

export function isDefaultGithubMentionHost(githubHost: string): boolean {
  return githubHost.toLowerCase() === DEFAULT_GITHUB_MENTION_HOST;
}
