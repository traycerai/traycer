import type { GithubMentionRow } from "@traycer/protocol/host/mention-schemas";

import { isDefaultGithubMentionHost } from "./github-mention-host";

/**
 * Durable GitHub mention identity (strings only). Keep the `host/mention-schemas` import type-only.
 */

export function foldGithubIdentitySegment(value: string): string {
  return value.toLowerCase();
}

/** `github-pr:` / `github-issue:` - the prefix `segments.ts` also recognizes. */
export function githubMentionTokenPrefix(row: GithubMentionRow): string {
  return row.kind === "pull-request" ? "github-pr" : "github-issue";
}

/**
 * Attachment `path` / node id. Include non-default `githubHost`; omit github.com to keep existing tokens. Identity segments are folded.
 */
export function githubMentionToken(row: GithubMentionRow): string {
  return `${githubMentionTokenPrefix(row)}:${githubMentionTokenReference(row)}`;
}

/**
 * The token's reference segment, from whichever record carries the identity - a picker row on one side, mention node attributes in `composer-mention-attrs.ts`'s rebuild on the other.
 * Both sides MUST produce this through this one function: the rebuild used to restate the rule by hand, and a hand-written restatement is a second gate that drifts.
 */
export function githubMentionTokenReference(identity: {
  readonly githubHost: string;
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}): string {
  const reference = `${foldGithubIdentitySegment(identity.owner)}/${foldGithubIdentitySegment(identity.repo)}#${identity.number}`;
  return isDefaultGithubMentionHost(identity.githubHost)
    ? reference
    : `${foldGithubIdentitySegment(identity.githubHost)}/${reference}`;
}
