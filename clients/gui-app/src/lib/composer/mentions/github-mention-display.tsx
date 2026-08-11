import {
  CircleCheck,
  CircleDot,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  type LucideIcon,
} from "lucide-react";
import type { ReactElement } from "react";

import type {
  GithubIssueMentionRow,
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

/** Draft is not a PR *state* on the wire - it is a flag on an open PR. */
export type GithubMentionDisplayState =
  "open" | "draft" | "merged" | "closed" | "issue-open" | "issue-closed";

const STATE_ICON: Readonly<Record<GithubMentionDisplayState, LucideIcon>> = {
  open: GitPullRequest,
  draft: GitPullRequestDraft,
  merged: GitMerge,
  closed: GitPullRequestClosed,
  "issue-open": CircleDot,
  "issue-closed": CircleCheck,
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
  "issue-closed": PR_STATE_TINT_CLASS.merged,
};

const STATE_LABEL: Readonly<Record<GithubMentionDisplayState, string>> = {
  open: "Open",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
  "issue-open": "Open",
  "issue-closed": "Closed",
};

export function githubMentionDisplayState(
  row: GithubMentionRow,
): GithubMentionDisplayState {
  if (row.kind === "issue") {
    return row.state === "open" ? "issue-open" : "issue-closed";
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

/** `org/repo#123`, the one canonical way to write a reference in prose. */
export function githubMentionReference(row: GithubMentionRow): string {
  return `${row.owner}/${row.repo}#${row.number}`;
}

/**
 * The row's trailing muted segment: `repo · 2h`, or just `2h` when the whole
 * scope is one repository and naming it every row would say nothing.
 */
export function githubMentionRowTrailing(
  row: GithubMentionRow,
  singleRepositoryScope: boolean,
  now: number,
): string {
  const age = formatCompactRelativeTime(row.updatedAt, now);
  return singleRepositoryScope ? age : `${row.repo} · ${age}`;
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

export function githubMentionToken(row: GithubMentionRow): string {
  return `${githubMentionTokenPrefix(row)}:${githubMentionReference(row)}`;
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
  singleRepositoryScope: boolean,
): GithubMentionAttachment {
  return {
    kind: "mention",
    contextType:
      row.kind === "pull-request" ? "github_pull_request" : "github_issue",
    path: githubMentionToken(row),
    pathKind: null,
    relPath: null,
    absolutePath: null,
    workspacePath: null,
    label: singleRepositoryScope
      ? `#${row.number}`
      : `${row.repo}#${row.number}`,
    description: `${githubMentionReference(row)} · ${row.title}`,
    githubHost: row.githubHost,
    organizationLogin: row.owner,
    repositoryName: row.repo,
    issueNumber: row.number,
    url: row.url,
  };
}
