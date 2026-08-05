import { useCallback, type ReactNode } from "react";
import { FileWarning } from "lucide-react";
import type {
  PrGetLocalDiffResponse,
  PrLocalDiffFile,
  PrLocalDiffUnavailableReason,
} from "@traycer/protocol/host/pr-schemas";
import { DiffContentPrimitive } from "@/components/epic-canvas/git-diff/diff-content-primitive";
import { DiffBundleCollapseChevron } from "@/components/epic-canvas/git-diff/diff-bundle-file-section";
import { GitSectionStatsSummary } from "@/components/epic-canvas/git-diff/diff-tab-shell";
import { StartTruncatedText } from "@/components/ui/start-truncated-text";
import { PrExternalGitHubLink } from "@/components/epic-canvas/pr/pr-external-github-link";
import type { DiffViewerPreferences } from "@/lib/diff/diff-viewer-preferences";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { PrDiffTileRef } from "@/stores/epics/canvas/types";
import { useNativeDivScrollRestoration } from "@/hooks/scroll/use-native-div-scroll-restoration";

type PrLocalDiffSuccess = Extract<PrGetLocalDiffResponse, { kind: "diff" }>;

const UNAVAILABLE_SENTENCE: Record<PrLocalDiffUnavailableReason, string> = {
  "no-local-checkout":
    "This machine has no worktree for this pull request, so there is no local diff to read.",
  "repo-mismatch":
    "The worktree this PR came from doesn’t hold this repository — an uninitialized submodule, most likely.",
  "ref-unavailable":
    "The local checkout is missing one end of the range. Fetching the base branch usually fixes it.",
  "no-merge-base":
    "The two branches share no history locally, so there is no merge base to diff from.",
  "git-unavailable": "Git could not be run against this checkout.",
};

/**
 * The body of a PR diff tile: the drift banner, then one collapsible section
 * per file.
 *
 * The patches come from the checkout the branch was pushed from, not from
 * GitHub — GitHub's GraphQL changed-file list has no patch field at any page
 * size, so this is the only source of a real diff short of a REST sweep per
 * file. That trade has one visible consequence, and making it legible is this
 * component's job: the local checkout can be behind or ahead of what GitHub is
 * showing, and when it is, the banner says so before the reader scrolls a
 * single hunk.
 */
export function PrLocalDiffBody(props: {
  readonly node: PrDiffTileRef;
  readonly viewTabId: string;
  readonly result: PrGetLocalDiffResponse | null;
  /** False when the PR frame never carried enough to ask (no `linkGroupKey`). */
  readonly hasTarget: boolean;
  readonly isError: boolean;
  readonly prUrl: string | null;
  readonly preferences: DiffViewerPreferences;
}): ReactNode {
  if (props.result?.kind === "diff") {
    return (
      <PrLocalDiffFiles
        node={props.node}
        viewTabId={props.viewTabId}
        diff={props.result}
        prUrl={props.prUrl}
        preferences={props.preferences}
      />
    );
  }

  // A host too old for the method, a transport failure, and a PR with no
  // `linkGroupKey` all land here. None can name a specific cause, so they get
  // the "no checkout" line rather than a guess; only a real `unavailable`
  // frame names one.
  const reason: PrLocalDiffUnavailableReason =
    props.result?.kind === "unavailable"
      ? props.result.reason
      : "no-local-checkout";

  return (
    <div
      className="flex h-full min-h-0 flex-col items-center justify-center gap-3 px-6 text-center"
      data-testid="pr-diff-unavailable"
    >
      <FileWarning
        className="size-5 shrink-0 text-muted-foreground"
        aria-hidden
      />
      <p className="max-w-prose text-ui-sm text-muted-foreground">
        {props.hasTarget || props.isError
          ? UNAVAILABLE_SENTENCE[reason]
          : UNAVAILABLE_SENTENCE["no-local-checkout"]}
      </p>
      {props.prUrl !== null ? (
        <PrExternalGitHubLink
          href={`${props.prUrl}/files`}
          className="text-ui-sm text-primary hover:underline"
          testId="pr-diff-unavailable-github-link"
        >
          View the full diff on GitHub
        </PrExternalGitHubLink>
      ) : null}
    </div>
  );
}

function PrLocalDiffFiles(props: {
  readonly node: PrDiffTileRef;
  readonly viewTabId: string;
  readonly diff: PrLocalDiffSuccess;
  readonly prUrl: string | null;
  readonly preferences: DiffViewerPreferences;
}): ReactNode {
  const { diff } = props;
  const { scrollContainerRef, onScroll } = useNativeDivScrollRestoration(
    props.node.instanceId,
    true,
  );
  const shownPatches = diff.files.filter(
    (file) => file.patch !== null && file.patch.length > 0,
  ).length;

  if (diff.files.length === 0) {
    return (
      <div
        className="flex h-full min-h-0 items-center justify-center px-6 text-center text-ui-sm text-muted-foreground/70"
        data-testid="pr-diff-empty"
      >
        This range has no file changes in the local checkout.
      </div>
    );
  }

  return (
    <div
      ref={scrollContainerRef}
      onScroll={onScroll}
      className="h-full min-h-0 overflow-auto"
    >
      {diff.isStale ? (
        <p
          className="flex min-w-0 items-start gap-2 border-b border-warning/40 bg-warning/10 px-3 py-2 text-ui-xs text-foreground"
          data-testid="pr-diff-stale"
        >
          <FileWarning
            className="mt-px size-3.5 shrink-0 text-warning"
            aria-hidden
          />
          <span className="min-w-0">
            This is your local checkout at{" "}
            <span className="font-mono">{diff.localHeadOid.slice(0, 7)}</span>.
            GitHub is showing a different commit, so pushed changes you haven’t
            pulled — or local commits you haven’t pushed — will not match.
          </span>
        </p>
      ) : null}
      {diff.files.map((file) => (
        <PrLocalDiffFileSection
          key={file.path}
          node={props.node}
          viewTabId={props.viewTabId}
          file={file}
          preferences={props.preferences}
        />
      ))}
      {diff.isTruncated ? (
        <p
          className="px-3 py-3 text-ui-xs text-muted-foreground/70"
          data-testid="pr-diff-truncated"
        >
          The patch was cut off after {shownPatches} of {diff.files.length}{" "}
          files.{" "}
          {props.prUrl !== null ? (
            <PrExternalGitHubLink
              href={`${props.prUrl}/files`}
              className="text-primary hover:underline"
              testId="pr-diff-truncated-github-link"
            >
              View the full diff on GitHub
            </PrExternalGitHubLink>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

/**
 * One file. Collapse state lives on the TILE (so it survives a reload and the
 * toolbar's collapse-all can drive it), and a collapsed section renders no
 * `<FileDiff>` at all rather than hiding one — a 200-file PR would otherwise
 * parse and mount every patch the moment the tile opens.
 */
function PrLocalDiffFileSection(props: {
  readonly node: PrDiffTileRef;
  readonly viewTabId: string;
  readonly file: PrLocalDiffFile;
  readonly preferences: DiffViewerPreferences;
}): ReactNode {
  const { file, node } = props;
  const toggleCollapsed = useEpicCanvasStore(
    (state) => state.togglePrDiffFileCollapsedInTab,
  );
  const collapsed = node.view.collapsedFilePaths.includes(file.path);
  const { viewTabId } = props;
  const toggle = useCallback((): void => {
    toggleCollapsed(viewTabId, node.id, file.path);
  }, [file.path, node.id, toggleCollapsed, viewTabId]);

  const label =
    file.previousPath === null
      ? file.path
      : `${file.previousPath} → ${file.path}`;

  // Deliberately NOT `DiffBundleFileSectionFrame`: that frame carries an
  // "open in editor" button, and a range diff has no file on disk to open -
  // both endpoints are commits, and the working-tree copy of a path may hold
  // neither side of the change. The rest of the frame (sticky header, border
  // rhythm, chevron) is reproduced so the two diff surfaces still read alike.
  return (
    <div
      className="border-b border-border/70 bg-background"
      data-diff-find-file={file.path}
    >
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!collapsed}
        data-testid="pr-diff-file"
        className="sticky top-0 z-10 flex w-full min-w-0 items-center gap-2 border-b border-border/60 bg-background p-2 text-left transition-colors hover:bg-muted/40"
      >
        <DiffBundleCollapseChevron collapsed={collapsed} />
        <StartTruncatedText className="min-w-0 flex-1 font-mono text-ui-xs">
          {label}
        </StartTruncatedText>
        <GitSectionStatsSummary
          insertions={file.insertions ?? 0}
          deletions={file.deletions ?? 0}
        />
      </button>
      {collapsed ? null : (
        <PrLocalDiffFileBody file={file} preferences={props.preferences} />
      )}
    </div>
  );
}

function PrLocalDiffFileBody(props: {
  readonly file: PrLocalDiffFile;
  readonly preferences: DiffViewerPreferences;
}): ReactNode {
  const { file, preferences } = props;
  if (file.isBinary) {
    return (
      <PrLocalDiffNote>Binary file — no text diff to show.</PrLocalDiffNote>
    );
  }
  // `null` and empty are different facts and get different sentences: the byte
  // budget never reached this file, versus the range genuinely changed nothing
  // in it (a pure mode change, say).
  if (file.patch === null) {
    return (
      <PrLocalDiffNote>
        Not loaded — the diff exceeded this view’s size budget.
      </PrLocalDiffNote>
    );
  }
  // A patch with no `@@` hunk is a change git states entirely in headers — a
  // pure rename, or a mode change. Real, but there are no lines to render, and
  // the diff viewer would draw an empty frame for it.
  if (file.patch.length === 0 || !file.patch.includes("\n@@ ")) {
    return <PrLocalDiffNote>No content changes.</PrLocalDiffNote>;
  }
  return (
    <DiffContentPrimitive
      patch={file.patch}
      cacheScope={`pr-local-diff:${file.path}`}
      mode={preferences.mode}
      wordWrap={preferences.wordWrap}
      backgrounds={preferences.backgrounds}
      lineNumbers={preferences.lineNumbers}
      indicatorStyle={preferences.indicatorStyle}
      fileHeaders={false}
    />
  );
}

function PrLocalDiffNote(props: { readonly children: ReactNode }): ReactNode {
  return (
    <p className="px-3 py-4 text-ui-xs text-muted-foreground/70">
      {props.children}
    </p>
  );
}
