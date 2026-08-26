import {
  CircleCheck,
  CircleDot,
  CircleSlash,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  type LucideIcon,
} from "lucide-react";
import type { ReactElement } from "react";

import type {
  GithubIssueMentionRow,
  GithubMentionRepository,
  GithubMentionRow,
  GithubMentionSection,
  GithubPullRequestMentionRow,
} from "@traycer/protocol/host/mention-schemas";

import { PR_STATE_TINT_CLASS } from "@/components/worktree/worktree-pr-state-palette";
import {
  formatPrBaseFromHead,
  prChecksSummary,
} from "@/lib/pr/pr-list-projection";
import { REVIEW_DECISION_LABEL } from "@/lib/pr/pr-review-decision-label";
import type {
  GithubMentionAttachment,
  MentionPreview,
  MentionPreviewFact,
} from "@/lib/composer/types";
import { formatCompactRelativeTime } from "@/lib/relative-time";
import { cn } from "@/lib/utils";

import { foldGithubIdentitySegment } from "./github-mention-rows";
import { isDefaultGithubMentionHost } from "@traycer/protocol/common/github-mention-host";
import { MENU_ICON_CLASS } from "./mention-entry-display";

/**
 * How a PR/issue row reads: its state glyph, its row text, its preview card,
 * and the chip it inserts.
 *
 * The glyphs and tints are the PR panel's, taken from
 * `worktree-pr-state-palette` rather than restated - the same three shapes
 * (open / merged / closed) a reader has already learned in the sidebar and the
 * hover card, at the same contrast-validated tokens. Draft and the two issue
 * states extend that vocabulary; they are not a second dialect of it.
 */

/**
 * Draft is not a PR *state* on the wire - it is a flag on an open PR, and
 * `issue-not-planned` is the same shape: a closed issue's `stateReason`.
 */
export type GithubMentionDisplayState =
  | "open"
  | "draft"
  | "merged"
  | "closed"
  | "issue-open"
  | "issue-closed"
  | "issue-not-planned";

/** How much of `host/owner/repo` a row must print to be unambiguous in scope. */
export type GithubRepositoryQualification =
  | "none"
  | "repo"
  | "owner-repo"
  | "host-owner-repo";

const STATE_ICON: Readonly<Record<GithubMentionDisplayState, LucideIcon>> = {
  open: GitPullRequest,
  draft: GitPullRequestDraft,
  merged: GitMerge,
  closed: GitPullRequestClosed,
  "issue-open": CircleDot,
  "issue-closed": CircleCheck,
  "issue-not-planned": CircleSlash,
};

const STATE_TINT: Readonly<Record<GithubMentionDisplayState, string>> = {
  open: PR_STATE_TINT_CLASS.open,
  // A draft is deliberately UNTINTED muted foreground: the tint means "this
  // state matters", and a draft's whole point is that it is not ready to.
  draft: "text-muted-foreground",
  merged: PR_STATE_TINT_CLASS.merged,
  closed: PR_STATE_TINT_CLASS.closed,
  "issue-open": PR_STATE_TINT_CLASS.open,
  // A closed issue is resolved, not rejected - purple (the "landed" colour
  // merged PRs already use) rather than the red that means "closed unmerged".
  // That sentence is only true of a COMPLETED closure, which is why the
  // not-planned case below is a separate state rather than a shade of this one.
  "issue-closed": PR_STATE_TINT_CLASS.merged,
  // Dismissed, not failed - so muted rather than the red that means something
  // went wrong, on the same reasoning that leaves `draft` untinted. Red would
  // read as a rejection the closure did not necessarily express.
  "issue-not-planned": "text-muted-foreground",
};

const STATE_LABEL: Readonly<Record<GithubMentionDisplayState, string>> = {
  open: "Open",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
  "issue-open": "Open",
  "issue-closed": "Closed",
  "issue-not-planned": "Closed (not planned)",
};

export function githubMentionDisplayState(
  row: GithubMentionRow,
): GithubMentionDisplayState {
  if (row.kind === "issue") {
    if (row.state === "open") return "issue-open";
    // `stateReason` is a nullable free-form string on the wire, so this asks
    // whether it explicitly says something OTHER than completed rather than
    // whether it says `completed`. A null reason is legacy or unpopulated, not
    // a dismissal, and inventing one from an absence would be the same
    // overclaim in the opposite direction - it keeps the settled reading.
    if (row.stateReason !== null && row.stateReason !== "completed") {
      return "issue-not-planned";
    }
    return "issue-closed";
  }
  if (row.state === "open" && row.isDraft) return "draft";
  return row.state;
}

export function githubMentionRowIcon(row: GithubMentionRow): ReactElement {
  const state = githubMentionDisplayState(row);
  const Icon = STATE_ICON[state];
  return (
    <Icon
      className={cn(MENU_ICON_CLASS, STATE_TINT[state])}
      aria-label={STATE_LABEL[state]}
    />
  );
}

export function githubMentionCategoryIcon(
  section: GithubMentionSection,
): ReactElement {
  const Icon = section === "pull-requests" ? GitPullRequest : CircleDot;
  return <Icon className={MENU_ICON_CLASS} aria-hidden />;
}

/**
 * `org/repo#123`, the one canonical way to write a reference in prose -
 * host-prefixed when the host is not github.com. The same coordinates on two
 * hosts are two different attachments, and every surface this feeds (the chip
 * tooltip, the preview subtitle, the menu description, the token below) must
 * not collapse them into one indistinguishable string. The default host is
 * omitted for the same byte-stability reason `githubMentionToken` documents.
 */
export function githubMentionReference(row: GithubMentionRow): string {
  const reference = `${row.owner}/${row.repo}#${row.number}`;
  // The default check FOLDS (one predicate, shared with the token and the
  // serializer): a row served as `GitHub.com` is the default host, and
  // printing `GitHub.com/acme/widgets#123` would assert a host qualification
  // the identity layer says does not exist.
  return isDefaultGithubMentionHost(row.githubHost)
    ? reference
    : `${row.githubHost}/${reference}`;
}

/**
 * How much of a row's repository has to be written for the name to identify it
 * WITHIN THIS SCOPE - the shortest form that is still unambiguous.
 *
 * A boolean cannot answer this. `acme/api` and `contoso/api` in one scope are
 * two repositories with one name, so "more than one repository, therefore
 * print `repo`" labels both rows `api#123` and makes two distinct attachments
 * read identically - correct paths under indistinguishable text. Rare, but a
 * monorepo org plus a fork or a vendored upstream is exactly how it happens.
 *
 * Escalates only as far as the collision forces, so the common scope keeps the
 * short name it had before.
 */
export function githubRepositoryQualification(
  identity: {
    readonly githubHost: string;
    readonly owner: string;
    readonly repo: string;
  },
  repositories: ReadonlyArray<GithubMentionRepository> | null,
): GithubRepositoryQualification {
  // Null is ignorance, not an answer: the scope has not resolved, and the live
  // search can still put rows on screen (it runs whenever no repository is
  // selected). Under ignorance the safe label is `owner/repo` - a bare `#123`
  // from one repository beside a `#123` from another is exactly the ambiguity
  // this function exists to prevent, and no collision answer exists to prove
  // the short form safe.
  if (repositories === null) return "owner-repo";
  if (repositories.length <= 1) return "none";
  // Folded per segment: the row is API-cased while the scope's entries carry
  // the remote's user-typed casing, so a verbatim compare under-counts the
  // collisions and fails to escalate - the one job this function has.
  const sharingName = repositories.filter(
    (repository) =>
      foldGithubIdentitySegment(repository.repo) ===
      foldGithubIdentitySegment(identity.repo),
  );
  if (sharingName.length <= 1) return "repo";
  const sharingOwner = sharingName.filter(
    (repository) =>
      foldGithubIdentitySegment(repository.owner) ===
      foldGithubIdentitySegment(identity.owner),
  );
  return sharingOwner.length <= 1 ? "owner-repo" : "host-owner-repo";
}

/** The repository name at that qualification; empty string for `none`. */
export function githubRepositoryQualifiedName(
  row: GithubMentionRow,
  qualification: GithubRepositoryQualification,
): string {
  switch (qualification) {
    case "none":
      return "";
    case "repo":
      return row.repo;
    case "owner-repo":
      return `${row.owner}/${row.repo}`;
    case "host-owner-repo":
      return `${row.githubHost}/${row.owner}/${row.repo}`;
  }
}

/**
 * The row's trailing muted segment: `repo · 2h`, or just `2h` when the whole
 * scope is one repository and naming it every row would say nothing.
 */
export function githubMentionRowTrailing(
  row: GithubMentionRow,
  repositories: ReadonlyArray<GithubMentionRepository> | null,
  now: number,
): string {
  const age = formatCompactRelativeTime(row.updatedAt, now);
  const name = githubRepositoryQualifiedName(
    row,
    githubRepositoryQualification(row, repositories),
  );
  return name === "" ? age : `${name} · ${age}`;
}

/**
 * The preview card. Rendered from the CACHED row only - highlighting a row
 * never fetches, so every fact here is one the catalog already carried.
 *
 * A fact with nothing to say is OMITTED rather than rendered blank: a PR whose
 * checks have not reported yet should not show an empty "Checks" line, because
 * a labelled blank reads as "zero" rather than as "not known".
 */
export function githubMentionPreview(
  row: GithubMentionRow,
  now: number,
): MentionPreview {
  return {
    kind: "card",
    title: row.title,
    subtitle: githubMentionReference(row),
    facts:
      row.kind === "pull-request"
        ? pullRequestFacts(row, now)
        : issueFacts(row, now),
  };
}

function pullRequestFacts(
  row: GithubPullRequestMentionRow,
  now: number,
): ReadonlyArray<MentionPreviewFact> {
  const checks = prChecksSummary(row.checksRollup);
  return [
    { label: "State", value: STATE_LABEL[githubMentionDisplayState(row)] },
    // `base ← head`, the merge-target reading GitHub's own compare control
    // uses - shared with the PR panel row rather than re-derived here, so the
    // two surfaces cannot end up writing the arrow in opposite directions.
    ...(row.baseRefName === null && row.headRefName === null
      ? []
      : [{ label: "Branch", value: formatPrBaseFromHead(row) }]),
    // The worst-wins rollup, in the panel's exact words ("1 failing").
    ...(checks === null ? [] : [{ label: "Checks", value: checks.label }]),
    ...(row.reviewDecision === null
      ? []
      : [
          {
            label: "Review",
            value: REVIEW_DECISION_LABEL[row.reviewDecision],
          },
        ]),
    ...authorFact(row),
    { label: "Updated", value: formatCompactRelativeTime(row.updatedAt, now) },
  ];
}

function issueFacts(
  row: GithubIssueMentionRow,
  now: number,
): ReadonlyArray<MentionPreviewFact> {
  const assignees = row.assignees.map((actor) => actor.login).join(", ");
  return [
    { label: "State", value: STATE_LABEL[githubMentionDisplayState(row)] },
    ...(row.labels.length === 0
      ? []
      : [{ label: "Labels", value: row.labels.join(", ") }]),
    ...(assignees.length === 0
      ? []
      : [{ label: "Assignees", value: assignees }]),
    ...authorFact(row),
    { label: "Updated", value: formatCompactRelativeTime(row.updatedAt, now) },
  ];
}

function authorFact(row: GithubMentionRow): ReadonlyArray<MentionPreviewFact> {
  const author = row.author;
  if (author === null) return [];
  return [{ label: "Author", value: author.login }];
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

/**
 * The inserted chip.
 *
 * `label` is what the chip READS - `#123`, or `repo#123` when the scope spans
 * more than one repository and a bare number would be ambiguous. `description`
 * is its tooltip: `org/repo#123 · <title>`, deliberately WITHOUT the state.
 * State changes between insert and read, and a chip must not assert a fact
 * that can quietly go stale on the reader.
 */
export function githubMentionAttachmentFromRow(
  row: GithubMentionRow,
  repositories: ReadonlyArray<GithubMentionRepository> | null,
): GithubMentionAttachment {
  const name = githubRepositoryQualifiedName(
    row,
    githubRepositoryQualification(row, repositories),
  );
  return {
    kind: "mention",
    contextType:
      row.kind === "pull-request" ? "github_pull_request" : "github_issue",
    path: githubMentionToken(row),
    pathKind: null,
    relPath: null,
    absolutePath: null,
    workspacePath: null,
    label: name === "" ? `#${row.number}` : `${name}#${row.number}`,
    description: `${githubMentionReference(row)} · ${row.title}`,
    githubHost: row.githubHost,
    organizationLogin: row.owner,
    repositoryName: row.repo,
    issueNumber: row.number,
    url: row.url,
  };
}
