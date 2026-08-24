import type { GithubMentionRow } from "@traycer/protocol/host/mention-schemas";
import { isDefaultGithubMentionHost } from "@traycer/protocol/common/github-mention-host";

import { foldGithubIdentitySegment } from "./github-mention-rows";

/**
 * The durable IDENTITY of a GitHub mention, separated from how one is drawn.
 *
 * These three functions produce strings and nothing else, but they used to
 * live in `github-mention-display.tsx` alongside that file's `ReactElement`
 * exports. The cost was structural rather than cosmetic: `tiptap-json-content`
 * imports exactly one of them to rebuild a mention token, so a pure text path
 * transitively depended on `lucide-react`, `react` and the whole PR-palette
 * component stack. That single edge was one of only two keeping the chat find
 * projection's dependency closure from being pure TypeScript, which is what
 * the shared (host + client) find projection needs it to be.
 *
 * `github-mention-display.tsx` re-exports all three, so its callers and the
 * doc comments pointing at `githubMentionToken` are unaffected.
 */

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
 * a row here, node attributes in `tiptap-json-content.ts`'s rebuild. Both
 * sides MUST produce this through this one function: the rebuild used to
 * restate the rule by hand, and a hand-written restatement is a second gate
 * that drifts. The default-host check runs on the FOLDED host, so
 * `GitHub.com` omits the segment exactly as `github.com` does.
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
