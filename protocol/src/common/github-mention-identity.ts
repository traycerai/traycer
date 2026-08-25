import type { GithubMentionRow } from "@traycer/protocol/host/mention-schemas";

import { isDefaultGithubMentionHost } from "./github-mention-host";

/**
 * The durable IDENTITY of a GitHub mention, separated from how one is drawn.
 *
 * These functions produce strings and nothing else. They started in the GUI's
 * `github-mention-display.tsx`, moved to a sibling `github-mention-token.ts` to
 * get a pure text path off `react` / `lucide-react`, and land here because the
 * composer's plain-text projection - which rebuilds a chip's token from node
 * attributes when the node carries no `path` - is now shared between the host
 * and the GUI. A projection both sides run cannot reach into `clients/gui-app`,
 * so the identity rule it depends on has to sit at the layer the projection
 * does.
 *
 * Named for the identity rather than for the token because {@link
 * foldGithubIdentitySegment} is part of that rule and is consumed on its own:
 * the GUI's row keys and its display qualification compare single segments
 * without ever building a token.
 *
 * The GUI's `github-mention-display.tsx` still re-exports the three token
 * builders, so its callers and the doc comments pointing at
 * {@link githubMentionToken} are unaffected.
 *
 * The `host/mention-schemas` import below is type-only and must stay that way.
 * `common/` is the base layer that `host/` imports from; this is one of the
 * only edges pointing back, and it is safe solely because `import type` is
 * erased at emit. Unlike the sibling edge in `composer-mention-attrs.ts` - which
 * would close a cycle the moment it became a value import - this one happens to
 * reach nothing in `common/` today, which makes it the more dangerous of the
 * two: a value import here would look fine until someone adds an unrelated
 * `common/` import upstream in `host/`, and the cycle would then arrive
 * attributed to their change rather than to this one. `GithubMentionRow` is a
 * wire shape, so only its type is ever wanted here regardless.
 */

/**
 * The fold every GitHub identity comparison runs on, exported on its own for
 * the comparisons that are per-FIELD rather than whole-identity: the GUI's
 * display qualification and its popover labels count name collisions one
 * segment at a time, and a verbatim segment compare there under-counts across
 * the same two provenances the row key exists to reconcile.
 */
export function foldGithubIdentitySegment(value: string): string {
  return value.toLowerCase();
}

/** `github-pr:` / `github-issue:` - the prefix `segments.ts` also recognizes. */
export function githubMentionTokenPrefix(row: GithubMentionRow): string {
  return row.kind === "pull-request" ? "github-pr" : "github-issue";
}

/**
 * The durable identity of an inserted GitHub mention.
 *
 * This token IS the attachment's `path`, which is also its node id, which is
 * what `buildAttachmentsFromJSONContent` dedupes on and what the sent-message
 * renderer indexes by. `owner/repo#123` is therefore not enough: the catalog
 * identity includes `githubHost`, so the same `owner/repo#123` served by
 * github.com and by an enterprise host collapsed to one token - inserting both
 * dropped or aliased an attachment, and both chips then rendered from whichever
 * metadata survived.
 *
 * The default host is OMITTED rather than always written. Emitting
 * `github.com/...` for everything would be simpler, but it would also change
 * the token for every mention that already exists: the same pull request
 * inserted before and after this change would carry two different identities,
 * so one message holding both would show it twice. Omitting the default keeps
 * every github.com token byte-identical to what it has always been, and only
 * a non-default host - which could not previously be represented at all - adds
 * the segment. `segments.ts` accepts both shapes; its pattern already allows
 * further slashes after the first.
 *
 * The identity segments are FOLDED, unlike every prose surface: the row key
 * already treats two spellings of one host/owner/repo as one row, so a live
 * payload that respells a cached row must not re-identify its attachment -
 * inserting before and after that replacement minted two paths for one
 * artifact. The number stays numeric and the prefix is fixed, so folding the
 * reference folds exactly the segments the row key folds.
 */
export function githubMentionToken(row: GithubMentionRow): string {
  return `${githubMentionTokenPrefix(row)}:${githubMentionTokenReference(row)}`;
}

/**
 * The token's reference segment, from whichever record carries the identity -
 * a picker row on one side, mention node attributes in
 * `composer-mention-attrs.ts`'s rebuild on the other. Both sides MUST produce
 * this through this one function: the rebuild used to restate the rule by hand,
 * and a hand-written restatement is a second gate that drifts. The default-host
 * check runs on the FOLDED host, so `GitHub.com` omits the segment exactly as
 * `github.com` does.
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
