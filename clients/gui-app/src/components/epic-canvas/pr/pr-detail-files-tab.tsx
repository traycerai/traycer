import { useCallback, useMemo, type MouseEvent, type ReactNode } from "react";
import { FileDiff } from "lucide-react";
import type {
  PrChangedFile,
  PrDetailCore,
  PrFilesSection,
} from "@traycer/protocol/host/pr-schemas";
import { Button } from "@/components/ui/button";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { modifiersFromMouseEvent } from "@/lib/canvas/tile-open/intent";
import { makePrDiffTile } from "@/lib/pr/pr-diff-tile";
import { PrDetailFilesChanged } from "@/components/epic-canvas/pr/pr-detail-sections";
import { PrExternalGitHubLink } from "@/components/epic-canvas/pr/pr-external-github-link";

/**
 * The Files tab: the changed-file list, plus the one control that opens the
 * PR's actual diff.
 *
 * The diff is a TILE, not a section here - the same shape as Git Diff's
 * "open bundle" button. Inline, a full patch competes with the PR header, tab
 * strip and context card for width and cannot be split beside the
 * conversation it is about; as a tile it takes the pane, drags to a split, and
 * keeps its own collapse state.
 *
 * The list stays as the tab's content because it is the part that is ALWAYS
 * available: it comes from the `pr.subscribeDetail` sweep, whereas the diff
 * needs a local checkout of this PR. A reader on a teammate's PR still gets
 * the file list; the button simply reports that there is nothing local to
 * open once the tile says so.
 */
export function PrDetailFilesTab(props: {
  readonly core: PrDetailCore;
  readonly files: PrFilesSection;
  readonly viewTabId: string;
  readonly hostId: string;
  /** `null` when no chat is selected to send to, which disables the row action. */
  readonly onQuoteFile: ((file: PrChangedFile) => void) | null;
}): ReactNode {
  return (
    <PrDetailFilesChanged
      files={props.files}
      prUrl={props.core.prUrl}
      additions={props.core.additions}
      deletions={props.core.deletions}
      onQuoteFile={props.onQuoteFile}
      headerAction={
        <PrOpenDiffButton
          core={props.core}
          viewTabId={props.viewTabId}
          hostId={props.hostId}
        />
      }
      footer={
        <p className="px-1 text-ui-xs text-muted-foreground/70">
          The diff is read from your local checkout of this branch.{" "}
          {props.core.prUrl !== null ? (
            <PrFilesGitHubFooterLink href={`${props.core.prUrl}/files`} />
          ) : null}
        </p>
      }
    />
  );
}

/**
 * Opens (or refocuses) this PR's diff tile.
 *
 * Never disabled on "does this PR have a local checkout?" - that answer costs a
 * host round-trip, and a button that silently disables itself is
 * indistinguishable from one that is broken. The tile says so plainly instead,
 * with a reason and a link to GitHub.
 */
function PrOpenDiffButton(props: {
  readonly core: PrDetailCore;
  readonly viewTabId: string;
  readonly hostId: string;
}): ReactNode {
  const { openTile } = useEpicTileNavigation();
  const { core, hostId } = props;
  const tile = useMemo(
    () =>
      makePrDiffTile({
        hostId,
        githubHost: core.githubHost,
        owner: core.base.owner,
        repo: core.base.repo,
        prNumber: core.base.prNumber,
      }),
    [core.base, core.githubHost, hostId],
  );

  const { viewTabId } = props;
  const openDiff = useCallback(
    (event: MouseEvent<HTMLButtonElement>): void => {
      openTile({
        node: tile,
        target: { tabId: viewTabId },
        gesture: "explicit",
        modifiers: modifiersFromMouseEvent(event),
        placement: null,
        dedupe: true,
        source: "direct_ui",
      });
    },
    [openTile, tile, viewTabId],
  );

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={openDiff}
      data-testid="pr-detail-open-diff"
      className="h-7 shrink-0 gap-1.5 px-2 text-ui-xs"
    >
      <FileDiff className="size-3.5 shrink-0" aria-hidden />
      Open diff
    </Button>
  );
}

/**
 * The footer's "View it on GitHub instead" link. See
 * {@link PrExternalGitHubLink} for why every GitHub anchor on these surfaces
 * goes through the RunnerHost bridge.
 */
function PrFilesGitHubFooterLink(props: { readonly href: string }): ReactNode {
  return (
    <PrExternalGitHubLink
      href={props.href}
      className="text-primary hover:underline"
      testId="pr-detail-files-github-footer-link"
    >
      View it on GitHub instead
    </PrExternalGitHubLink>
  );
}
