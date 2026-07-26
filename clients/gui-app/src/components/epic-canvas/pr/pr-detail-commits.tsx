import { type ReactNode } from "react";
import { ExternalLink, GitCommitHorizontal } from "lucide-react";
import type {
  PrCommit,
  PrCommitsSection,
  PrDetailCore,
} from "@traycer/protocol/host/pr-schemas";
import { PrActorAvatar } from "@/components/epic-canvas/pr/pr-detail-avatar";
import {
  PrOlderOnGitHub,
  PrRelativeTime,
} from "@/components/epic-canvas/pr/pr-detail-conversation";
import { cn } from "@/lib/utils";

/**
 * The Commits tab: the PR's commits as a list of rows that open on GitHub.
 *
 * Every row is a button rather than an `<a>` because the desktop shell owns
 * external navigation (`runner.openExternalLink`) - a bare anchor in the
 * renderer would either navigate the app frame or be swallowed. The short sha
 * still reads as the affordance, so the row looks like the link it behaves as.
 *
 * `commitUrl` needs the PR's own url to build `{prUrl}/commits/{oid}`. When it
 * is absent (a never-swept or unparseable row) the rows render inert rather
 * than pretending to be clickable.
 */
export function PrDetailCommits(props: {
  readonly core: PrDetailCore;
  readonly commits: PrCommitsSection;
  readonly onOpenCommit: (url: string) => void;
}): ReactNode {
  const shown = props.commits.commits;
  if (shown.length === 0) {
    return (
      <p
        className="rounded-xl border border-dashed border-border/60 py-10 text-center text-ui-sm text-muted-foreground/70"
        data-testid="pr-detail-commits-empty"
      >
        No commits on this pull request yet.
      </p>
    );
  }
  const totalCount = props.commits.totalCount ?? shown.length;

  return (
    <div
      className="flex min-w-0 flex-col gap-3"
      data-testid="pr-detail-commits"
    >
      <div className="min-w-0 overflow-hidden rounded-xl border border-border/60 bg-canvas">
        <div className="flex min-w-0 items-center gap-2 border-b border-border/50 bg-muted/25 px-3 py-2 text-ui-xs text-muted-foreground">
          <GitCommitHorizontal className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 truncate">
            {totalCount} commit{totalCount === 1 ? "" : "s"}
          </span>
          {totalCount > shown.length ? (
            <span className="shrink-0">Showing the last {shown.length}</span>
          ) : null}
        </div>
        <ul className="divide-y divide-border/40">
          {shown.map((commit) => (
            <PrCommitRow
              key={commit.oid}
              commit={commit}
              prUrl={props.core.prUrl}
              onOpenCommit={props.onOpenCommit}
            />
          ))}
        </ul>
      </div>
      {props.commits.isTruncated && props.core.prUrl !== null ? (
        <PrOlderOnGitHub
          href={`${props.core.prUrl}/commits`}
          label="View all commits on GitHub"
        />
      ) : null}
    </div>
  );
}

function PrCommitRow(props: {
  readonly commit: PrCommit;
  readonly prUrl: string | null;
  readonly onOpenCommit: (url: string) => void;
}): ReactNode {
  const shortOid = props.commit.oid.slice(0, 7);
  const headline = props.commit.messageHeadline ?? shortOid;
  const actor =
    props.commit.author ??
    (props.commit.authorName !== null && props.commit.authorName.length > 0
      ? { login: props.commit.authorName, avatarUrl: null }
      : null);
  const url =
    props.prUrl === null ? null : `${props.prUrl}/commits/${props.commit.oid}`;

  return (
    <li data-testid="pr-detail-commit-item">
      <button
        type="button"
        disabled={url === null}
        onClick={() => {
          if (url !== null) props.onOpenCommit(url);
        }}
        aria-label={
          url === null ? headline : `Open commit ${shortOid} on GitHub`
        }
        className={cn(
          "group flex w-full min-w-0 items-center gap-2.5 px-3 py-2.5 text-left transition-colors",
          "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
          url === null ? "cursor-default" : "hover:bg-muted/40",
        )}
      >
        <PrActorAvatar actor={actor} size="sm" className="shrink-0" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="min-w-0 truncate text-ui-sm text-foreground">
            {headline}
          </span>
          {actor !== null ? (
            <span className="min-w-0 truncate text-ui-xs text-muted-foreground">
              {actor.login}
            </span>
          ) : null}
        </span>
        {props.commit.committedAt !== null ? (
          <span className="shrink-0 text-ui-xs text-muted-foreground">
            <PrRelativeTime timestamp={props.commit.committedAt} />
          </span>
        ) : null}
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded-md border border-border/60 px-1.5 py-0.5",
            "font-mono text-ui-xs text-muted-foreground",
            url !== null &&
              "group-hover:border-primary/40 group-hover:text-primary",
          )}
        >
          {shortOid}
          {url !== null ? (
            <ExternalLink className="size-3 shrink-0" aria-hidden />
          ) : null}
        </span>
      </button>
    </li>
  );
}
