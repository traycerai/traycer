import { useCallback, type ReactNode } from "react";
import { Check, Copy, GitCommitHorizontal } from "lucide-react";
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
import { useClipboardCopy } from "@/hooks/ui/use-clipboard-copy";
import { reportableErrorToast } from "@/lib/reportable-error-toast";
import { cn } from "@/lib/utils";

/**
 * The Commits tab: the PR's commits as a list of rows that open on GitHub.
 *
 * Every row is a button rather than an `<a>` because the desktop shell owns
 * external navigation (`runner.openExternalLink`) - a bare anchor in the
 * renderer would either navigate the app frame or be swallowed.
 *
 * The sha chip beside it COPIES rather than opens: the row already goes to
 * GitHub, so a second control pointing at the same place bought nothing, while
 * the one thing a sha is repeatedly wanted for - pasting it into a terminal -
 * had no affordance at all.
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
          {props.commits.isTruncated || totalCount > shown.length ? (
            // `isTruncated` is the contract's own answer; the count comparison
            // cannot stand in for it. When `totalCount` is null it falls back
            // to `shown.length`, so the comparison is false on exactly the
            // truncated-but-uncounted frames - the header would then claim the
            // list is complete while the footer offers "view all on GitHub".
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

const COPIED_RESET_MS = 1600;

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
  const { onOpenCommit } = props;
  const openCommit = useCallback((): void => {
    if (url !== null) onOpenCommit(url);
  }, [onOpenCommit, url]);

  // The chip is a SIBLING of the row button, not a child of it: a button
  // inside a button is invalid HTML, and the browser will not deliver the
  // inner click reliably.
  return (
    <li
      className="flex min-w-0 items-center transition-colors hover:bg-muted/40"
      data-testid="pr-detail-commit-item"
    >
      <button
        type="button"
        disabled={url === null}
        onClick={openCommit}
        aria-label={
          url === null ? headline : `Open commit ${shortOid} on GitHub`
        }
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2.5 py-2.5 pr-2 pl-3 text-left",
          "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
          url === null ? "cursor-default" : "hover:underline-offset-2",
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
          <PrRelativeTime timestamp={props.commit.committedAt} />
        ) : null}
      </button>
      <PrCommitShaCopyButton oid={props.commit.oid} shortOid={shortOid} />
    </li>
  );
}

/**
 * Copies the commit's FULL sha, while displaying the short one.
 *
 * The short form is what a reader recognizes; the full form is what `git show`
 * and every other tool actually wants, and abbreviating it on the clipboard
 * would make the button quietly useless for the thing it is for. The chip
 * previously opened GitHub - a second route to where the row already goes.
 */
function PrCommitShaCopyButton(props: {
  readonly oid: string;
  readonly shortOid: string;
}): ReactNode {
  const { copied, copy } = useClipboardCopy({
    resetMs: COPIED_RESET_MS,
    onSuccess: null,
    onError: () =>
      reportableErrorToast("Couldn't copy the commit sha.", undefined, {
        title: "Could not copy to clipboard",
        message: null,
        code: null,
        source: "Clipboard",
      }),
  });
  const { oid } = props;
  const handleCopy = useCallback((): void => copy(oid), [copy, oid]);
  const Icon = copied ? Check : Copy;
  return (
    <span className="shrink-0 py-2.5 pr-3 pl-1">
      <button
        type="button"
        onClick={handleCopy}
        aria-label={copied ? "Copied" : `Copy commit sha ${props.shortOid}`}
        data-testid="pr-detail-commit-copy-sha"
        data-copied={copied}
        className={cn(
          "inline-flex shrink-0 items-center gap-1 rounded-md border border-border/60 px-1.5 py-0.5",
          "font-mono text-ui-xs text-muted-foreground transition-colors",
          "hover:border-primary/40 hover:text-primary",
          "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
        )}
      >
        {props.shortOid}
        <Icon className="size-3 shrink-0" aria-hidden />
      </button>
    </span>
  );
}
