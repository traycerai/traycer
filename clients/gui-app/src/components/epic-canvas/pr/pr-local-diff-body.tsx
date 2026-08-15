import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { FileWarning } from "lucide-react";
import { Virtuoso } from "react-virtuoso";
import type {
  PrGetLocalDiffResponse,
  PrGetLocalDiffSummaryResponse,
  PrLocalDiffSummaryFile,
  PrLocalDiffUnavailableReason,
} from "@traycer/protocol/host/pr-schemas";
import { DEFAULT_PR_LOCAL_FILE_DIFF_BYTE_BUDGET } from "@traycer/protocol/host/pr-schemas";
import { Button } from "@/components/ui/button";
import { DiffContentPrimitive } from "@/components/epic-canvas/git-diff/diff-content-primitive";
import { DiffBundleCollapseChevron } from "@/components/epic-canvas/git-diff/diff-bundle-file-section";
import { DiffContentLoadingSkeleton } from "@/components/epic-canvas/git-diff/diff-content-loading-skeleton";
import { GitErrorBlock } from "@/components/epic-canvas/git-diff/git-error-block";
import { TruncatedBanner } from "@/components/epic-canvas/git-diff/truncated-banner";
import { GitSectionStatsSummary } from "@/components/epic-canvas/git-diff/diff-tab-shell";
import { StartTruncatedText } from "@/components/ui/start-truncated-text";
import { PrExternalGitHubLink } from "@/components/epic-canvas/pr/pr-external-github-link";
import { BUNDLE_INLINE_LINE_THRESHOLD } from "@/lib/git/bundle-thresholds";
import type { DiffViewerPreferences } from "@/lib/diff/diff-viewer-preferences";
import {
  isHostUnsupportedError,
  usePrLocalFileDiffQuery,
  type PrLocalDiffTarget,
} from "@/hooks/pr/use-pr-local-diff";
import { useBundleDiffScrollRestoration } from "@/hooks/scroll/use-bundle-diff-scroll-restoration";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { PrDiffTileRef } from "@/stores/epics/canvas/types";

type PrLocalDiffSummarySuccess = Extract<
  PrGetLocalDiffSummaryResponse,
  { kind: "summary" }
>;

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
 * How a mounted, expanded file section gets its patch bytes.
 *
 * `split` is the primary path: the section owns a `pr.getLocalFileDiff`
 * query addressed by the summary's OID pair, with its own pending/error/
 * retry states - the Git Diff bundle row's architecture. `monolith` is the
 * old-host fallback: one `pr.getLocalDiff` response was already fetched, and
 * sections read their patch out of it directly - same section body, no
 * per-file queries, because a host in this mode has no per-file method to
 * call.
 */
type PrDiffPatchMode =
  | {
      readonly kind: "split";
      readonly target: PrLocalDiffTarget;
      readonly mergeBaseOid: string;
      readonly headOid: string;
      /** The comparison this mode is showing - see {@link sectionStateKey}. */
      readonly comparisonKey: string;
      readonly onRangeDrift: () => void;
    }
  | {
      readonly kind: "monolith";
      readonly patches: ReadonlyMap<string, string | null>;
      /** The comparison this mode is showing - see {@link sectionStateKey}. */
      readonly comparisonKey: string;
    };

/**
 * React `key` for a section's STATEFUL body, so its per-section overrides -
 * "Load diff" on a large file, "Load Full" past a truncation - reset by
 * remount whenever the comparison they were approved FOR changes. Without
 * this, sections key only by path: a summary refresh that resolves new OIDs
 * (the local branch advanced), or a whitespace-mode flip, would carry a
 * previously-approved `byteBudget: null` straight onto the NEW comparison
 * and defeat the 256KiB guard - the same identity discipline
 * `useEditableGitDiffSurface` applies via `fullDiffIdentity`.
 */
function sectionStateKey(
  mode: PrDiffPatchMode,
  file: PrLocalDiffSummaryFile,
  ignoreWhitespace: boolean,
): string {
  return [
    mode.comparisonKey,
    String(ignoreWhitespace),
    file.previousPath ?? "",
    file.path,
    // NUL-joined: it is the one byte a git path can never contain, so two
    // fields can never collide into another identity’s key.
  ].join("\0");
}

/**
 * The body of a PR diff tile: the drift banner, then one collapsible,
 * VIRTUALIZED section per file.
 *
 * The patches come from the checkout the branch was pushed from, not from
 * GitHub — GitHub's GraphQL changed-file list has no patch field at any page
 * size, so this is the only source of a real diff short of a REST sweep per
 * file. That trade has one visible consequence, and making it legible is this
 * component's job: the local checkout can be behind or ahead of what GitHub is
 * showing, and when it is, the banner says so before the reader scrolls a
 * single hunk.
 *
 * Two data plumbings feed ONE rendering path: the summary + per-file split
 * (new hosts), or the whole-PR monolith (old hosts, detected per call by the
 * tile). Either way the file list virtualizes and a section renders patch
 * content only while mounted and expanded — the alternative, one commit
 * mounting every file's parsed patch, is a multi-second main-thread hang on a
 * large PR.
 */
export function PrLocalDiffBody(props: {
  readonly node: PrDiffTileRef;
  readonly viewTabId: string;
  readonly target: PrLocalDiffTarget | null;
  /** The summary response, when the host supports the split methods. */
  readonly summary: PrGetLocalDiffSummaryResponse | null;
  /** The monolith response, only in `E_HOST_UNSUPPORTED` fallback mode. */
  readonly monolith: PrGetLocalDiffResponse | null;
  /** Bounded range-drift recovery - see the tile's `handleRangeDrift`. */
  readonly onRangeDrift: () => void;
  readonly prUrl: string | null;
  readonly preferences: DiffViewerPreferences;
}): ReactNode {
  const monolithDiff = props.monolith?.kind === "diff" ? props.monolith : null;
  const monolithPatches = useMemo(
    () =>
      monolithDiff === null
        ? null
        : new Map(monolithDiff.files.map((file) => [file.path, file.patch])),
    [monolithDiff],
  );

  if (props.summary?.kind === "summary" && props.target !== null) {
    const summary: PrLocalDiffSummarySuccess = props.summary;
    return (
      <PrLocalDiffFilesView
        node={props.node}
        viewTabId={props.viewTabId}
        isStale={summary.isStale}
        localHeadOid={summary.localHeadOid}
        files={summary.files}
        monolithTruncation={null}
        mode={{
          kind: "split",
          target: props.target,
          mergeBaseOid: summary.mergeBaseOid,
          headOid: summary.localHeadOid,
          comparisonKey: `${summary.mergeBaseOid}..${summary.localHeadOid}`,
          onRangeDrift: props.onRangeDrift,
        }}
        prUrl={props.prUrl}
        preferences={props.preferences}
      />
    );
  }

  if (monolithDiff !== null && monolithPatches !== null) {
    return (
      <PrLocalDiffFilesView
        node={props.node}
        viewTabId={props.viewTabId}
        isStale={monolithDiff.isStale}
        localHeadOid={monolithDiff.localHeadOid}
        files={monolithDiff.files}
        monolithTruncation={
          monolithDiff.isTruncated
            ? {
                shownPatches: monolithDiff.files.filter(
                  (file) => file.patch !== null && file.patch.length > 0,
                ).length,
              }
            : null
        }
        mode={{
          kind: "monolith",
          patches: monolithPatches,
          comparisonKey: `monolith:${monolithDiff.mergeBaseOid}..${monolithDiff.localHeadOid}`,
        }}
        prUrl={props.prUrl}
        preferences={props.preferences}
      />
    );
  }

  return (
    <PrLocalDiffUnavailable
      summary={props.summary}
      monolith={props.monolith}
      hasTarget={props.target !== null}
      prUrl={props.prUrl}
    />
  );
}

/**
 * The reason an unavailable body names. A host too old for the method, a
 * transport failure, and a PR with no `linkGroupKey` all land here without a
 * real `unavailable` frame; none can name a specific cause, so they get the
 * "no checkout" line rather than a guess.
 */
function unavailableReason(
  summary: PrGetLocalDiffSummaryResponse | null,
  monolith: PrGetLocalDiffResponse | null,
): PrLocalDiffUnavailableReason | null {
  if (summary?.kind === "unavailable") return summary.reason;
  if (monolith?.kind === "unavailable") return monolith.reason;
  return null;
}

// No error-shaped variant on purpose: a transport failure has no `unavailable`
// frame, so it lands here with `reason === null` and renders the same
// "no checkout" line the pre-split view rendered for it - errors and genuine
// misses have never been told apart on this surface, and the per-file error
// blocks (split mode) are where a transient failure actually surfaces now.
function PrLocalDiffUnavailable(props: {
  readonly summary: PrGetLocalDiffSummaryResponse | null;
  readonly monolith: PrGetLocalDiffResponse | null;
  readonly hasTarget: boolean;
  readonly prUrl: string | null;
}): ReactNode {
  const reason = unavailableReason(props.summary, props.monolith);
  const sentence =
    reason !== null && props.hasTarget
      ? UNAVAILABLE_SENTENCE[reason]
      : UNAVAILABLE_SENTENCE["no-local-checkout"];

  return (
    <div
      className="flex h-full min-h-0 flex-col items-center justify-center gap-3 px-6 text-center"
      data-testid="pr-diff-unavailable"
    >
      <FileWarning
        className="size-5 shrink-0 text-muted-foreground"
        aria-hidden
      />
      <p className="max-w-prose text-ui-sm text-muted-foreground">{sentence}</p>
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

function PrLocalDiffFilesView(props: {
  readonly node: PrDiffTileRef;
  readonly viewTabId: string;
  readonly isStale: boolean;
  readonly localHeadOid: string;
  readonly files: readonly PrLocalDiffSummaryFile[];
  /** Monolith mode only: the whole-PR byte budget cut the patch sweep off. */
  readonly monolithTruncation: { readonly shownPatches: number } | null;
  readonly mode: PrDiffPatchMode;
  readonly prUrl: string | null;
  readonly preferences: DiffViewerPreferences;
}): ReactNode {
  // Virtuoso restoration replaces the old native-div scroll restoration; the
  // anchors are stored under a different kind for the same tile instance, so
  // stale native offsets are simply never read again.
  const { virtuosoRef, restoreStateFrom, isScrolling } =
    useBundleDiffScrollRestoration(
      props.node.instanceId,
      props.files.length > 0,
    );

  if (props.files.length === 0) {
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
    <div className="flex h-full min-h-0 flex-col">
      {props.isStale ? (
        <p
          className="flex min-w-0 shrink-0 items-start gap-2 border-b border-warning/40 bg-warning/10 px-3 py-2 text-ui-xs text-foreground"
          data-testid="pr-diff-stale"
        >
          <FileWarning
            className="mt-px size-3.5 shrink-0 text-warning"
            aria-hidden
          />
          <span className="min-w-0">
            This is your local checkout at{" "}
            <span className="font-mono">{props.localHeadOid.slice(0, 7)}</span>.
            GitHub is showing a different commit, so pushed changes you haven’t
            pulled — or local commits you haven’t pushed — will not match.
          </span>
        </p>
      ) : null}
      <Virtuoso
        ref={virtuosoRef}
        restoreStateFrom={restoreStateFrom}
        isScrolling={isScrolling}
        data={props.files}
        className="min-h-0 flex-1"
        overscan={6}
        computeItemKey={(_index, file) => file.path}
        // eslint-disable-next-line react/no-unstable-nested-components -- Virtuoso row renderer, not a component definition.
        itemContent={(_index, file) => (
          <PrLocalDiffFileSection
            node={props.node}
            viewTabId={props.viewTabId}
            file={file}
            mode={props.mode}
            prUrl={props.prUrl}
            preferences={props.preferences}
          />
        )}
      />
      {props.monolithTruncation !== null ? (
        <p
          className="shrink-0 border-t border-border/60 px-3 py-2 text-ui-xs text-muted-foreground/70"
          data-testid="pr-diff-truncated"
        >
          The patch was cut off after {props.monolithTruncation.shownPatches} of{" "}
          {props.files.length} files.{" "}
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
 * diff content at all rather than hiding it — in split mode that also means
 * no fetch: the per-file query only exists while a section body is mounted.
 */
function PrLocalDiffFileSection(props: {
  readonly node: PrDiffTileRef;
  readonly viewTabId: string;
  readonly file: PrLocalDiffSummaryFile;
  readonly mode: PrDiffPatchMode;
  readonly prUrl: string | null;
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
        <PrLocalDiffFileBody
          file={file}
          mode={props.mode}
          prUrl={props.prUrl}
          preferences={props.preferences}
        />
      )}
    </div>
  );
}

/**
 * `null` line counts count as LARGE, not small: they mean the numstat sweep
 * had nothing to say about a (non-binary) file, so its size is unknown - and
 * the placeholder's failure mode ("one extra click") is far cheaper than the
 * inline mode's (parsing an unbounded patch on mount).
 */
function isLargeFile(file: PrLocalDiffSummaryFile): boolean {
  if (file.insertions === null || file.deletions === null) return true;
  return file.insertions + file.deletions > BUNDLE_INLINE_LINE_THRESHOLD;
}

function PrLocalDiffFileBody(props: {
  readonly file: PrLocalDiffSummaryFile;
  readonly mode: PrDiffPatchMode;
  readonly prUrl: string | null;
  readonly preferences: DiffViewerPreferences;
}): ReactNode {
  const { file, mode } = props;
  if (file.isBinary) {
    return (
      <PrLocalDiffNote>Binary file — no text diff to show.</PrLocalDiffNote>
    );
  }
  const stateKey = sectionStateKey(
    mode,
    file,
    props.preferences.ignoreWhitespace,
  );
  if (mode.kind === "monolith") {
    return (
      <PrMonolithFileBody
        key={stateKey}
        file={file}
        patch={mode.patches.get(file.path) ?? null}
        prUrl={props.prUrl}
        preferences={props.preferences}
      />
    );
  }
  return (
    <PrSplitFileBody
      key={stateKey}
      file={file}
      mode={mode}
      preferences={props.preferences}
    />
  );
}

/**
 * Split mode: a large file renders a placeholder INSTEAD of fetching - the
 * whole point of the summary knowing line counts up front - and the "Load
 * diff" button swaps in the fetching body on demand.
 */
function PrSplitFileBody(props: {
  readonly file: PrLocalDiffSummaryFile;
  readonly mode: Extract<PrDiffPatchMode, { kind: "split" }>;
  readonly preferences: DiffViewerPreferences;
}): ReactNode {
  const [loadRequested, setLoadRequested] = useState(false);
  const handleLoad = useCallback((): void => {
    setLoadRequested(true);
  }, []);
  if (isLargeFile(props.file) && !loadRequested) {
    return (
      <PrLargeDiffPlaceholder path={props.file.path} onLoad={handleLoad} />
    );
  }
  return (
    <PrLocalFileDiffContent
      file={props.file}
      mode={props.mode}
      preferences={props.preferences}
    />
  );
}

/**
 * Monolith fallback: the patch (or its absence) is already known, so the
 * large-file placeholder reveals inline content rather than fetching, and a
 * `null` patch - a file past the whole-PR byte budget - can only point at
 * GitHub, because a host in this mode has no per-file method to ask.
 */
function PrMonolithFileBody(props: {
  readonly file: PrLocalDiffSummaryFile;
  readonly patch: string | null;
  readonly prUrl: string | null;
  readonly preferences: DiffViewerPreferences;
}): ReactNode {
  const [loadRequested, setLoadRequested] = useState(false);
  const handleLoad = useCallback((): void => {
    setLoadRequested(true);
  }, []);
  // `null` and empty are different facts and get different sentences: the byte
  // budget never reached this file, versus the range genuinely changed nothing
  // in it (a pure mode change, say).
  if (props.patch === null) {
    return (
      <PrLocalDiffNote>
        Not loaded — the diff exceeded this view’s size budget.{" "}
        {props.prUrl !== null ? (
          <PrExternalGitHubLink
            href={`${props.prUrl}/files`}
            className="text-primary hover:underline"
            testId="pr-diff-not-loaded-github-link"
          >
            View it on GitHub
          </PrExternalGitHubLink>
        ) : null}
      </PrLocalDiffNote>
    );
  }
  if (isLargeFile(props.file) && !loadRequested) {
    return (
      <PrLargeDiffPlaceholder path={props.file.path} onLoad={handleLoad} />
    );
  }
  return (
    <PrPatchContent
      patch={props.patch}
      cacheScope={`pr-local-diff:${props.file.path}`}
      preferences={props.preferences}
    />
  );
}

/**
 * The fetching section body of split mode - the `BundleInlineDiff` of this
 * surface. Owns one `pr.getLocalFileDiff` query and its pending/error
 * states, so one file's transient failure is one section's error block, not
 * the tile's.
 */
function PrLocalFileDiffContent(props: {
  readonly file: PrLocalDiffSummaryFile;
  readonly mode: Extract<PrDiffPatchMode, { kind: "split" }>;
  readonly preferences: DiffViewerPreferences;
}): ReactNode {
  const { file, mode } = props;
  const [loadFull, setLoadFull] = useState(false);
  const handleLoadFull = useCallback((): void => {
    setLoadFull(true);
  }, []);
  const query = usePrLocalFileDiffQuery({
    target: mode.target,
    mergeBaseOid: mode.mergeBaseOid,
    headOid: mode.headOid,
    path: file.path,
    previousPath: file.previousPath,
    ignoreWhitespace: props.preferences.ignoreWhitespace,
    byteBudget: loadFull ? null : DEFAULT_PR_LOCAL_FILE_DIFF_BYTE_BUDGET,
    enabled: true,
  });

  // Two section-observed facts about the tile's SPINE route to the same
  // recovery, a summary refetch: `ref-unavailable` (the checkout no longer
  // has the summary's OIDs - pruned, or moved and gc'd) re-resolves the
  // range, and `E_HOST_UNSUPPORTED` (the HOST lost the method between the
  // summary and this row - a downgrade, or a reconnect to an older build)
  // makes the refetch itself fail unsupported, which is what flips the tile
  // to the monolith fallback - the summary query is the split view's only
  // capability probe and never re-asks on its own at `staleTime: Infinity`.
  // The recovery is BOUNDED at the tile so a repeatedly-failing range cannot
  // loop. The ref makes the report once-per-EPISODE for this section
  // instance: the effect re-runs whenever `onRangeDrift`'s identity moves
  // (any tile re-render can do that), and without the guard a failed
  // recovery - which releases the tile's once-per-range token AND re-renders
  // the tile - would re-report the same cached answer and hot-loop. A
  // genuinely new episode arrives as a new result (ref reset) or a
  // remounted section (fresh ref).
  const response = query.data;
  const unavailableReason =
    response?.kind === "unavailable" ? response.reason : null;
  const methodUnsupported = isHostUnsupportedError(query.error);
  const reportedDriftRef = useRef(false);
  const { onRangeDrift } = mode;
  useEffect(() => {
    if (unavailableReason !== "ref-unavailable" && !methodUnsupported) {
      reportedDriftRef.current = false;
      return;
    }
    if (reportedDriftRef.current) return;
    reportedDriftRef.current = true;
    onRangeDrift();
  }, [unavailableReason, methodUnsupported, onRangeDrift]);

  if (query.isPending) {
    return (
      <DiffContentLoadingSkeleton
        mode={props.preferences.mode}
        sizing="content"
        density="compact"
        sectionIndex={0}
      />
    );
  }
  if (query.error !== null) {
    return <GitErrorBlock error={query.error} />;
  }
  if (response === undefined) return null;
  if (response.kind === "unavailable") {
    // Deliberately NOT the range-level `UNAVAILABLE_SENTENCE` map: "fetch the
    // base branch" is advice about REF NAMES, and this miss is about OIDs the
    // summary already resolved. The tile-level recovery above is the fix.
    return (
      <PrLocalDiffNote>
        This file’s diff is no longer available from the local checkout.
      </PrLocalDiffNote>
    );
  }
  if (response.isBinary) {
    return (
      <PrLocalDiffNote>Binary file — no text diff to show.</PrLocalDiffNote>
    );
  }
  return (
    <>
      {response.isTruncated ? (
        <TruncatedBanner
          truncatedAfterBytes={
            response.truncatedAfterBytes ??
            DEFAULT_PR_LOCAL_FILE_DIFF_BYTE_BUDGET
          }
          onLoadFull={handleLoadFull}
        />
      ) : null}
      <PrPatchContent
        patch={response.patch}
        cacheScope={`pr-local-diff:${mode.mergeBaseOid}:${mode.headOid}:${file.path}`}
        preferences={props.preferences}
      />
    </>
  );
}

function PrPatchContent(props: {
  readonly patch: string;
  readonly cacheScope: string;
  readonly preferences: DiffViewerPreferences;
}): ReactNode {
  // A patch with no `@@` hunk is a change git states entirely in headers — a
  // pure rename, or a mode change. Real, but there are no lines to render, and
  // the diff viewer would draw an empty frame for it. The wire contract does
  // not promise a `diff --git` preamble, so a hunk header is a hunk header at
  // the very first byte too. (An empty patch has neither form.)
  const hasHunk =
    props.patch.startsWith("@@ ") || props.patch.includes("\n@@ ");
  if (!hasHunk) {
    return <PrLocalDiffNote>No content changes.</PrLocalDiffNote>;
  }
  return (
    <DiffContentPrimitive
      patch={props.patch}
      cacheScope={props.cacheScope}
      mode={props.preferences.mode}
      wordWrap={props.preferences.wordWrap}
      backgrounds={props.preferences.backgrounds}
      lineNumbers={props.preferences.lineNumbers}
      indicatorStyle={props.preferences.indicatorStyle}
      fileHeaders={false}
      isEmptyFile={false}
    />
  );
}

/**
 * Mirrors the bundle tile's large-diff placeholder, except the button loads
 * the diff INLINE: git's placeholder opens the file tile, and a range diff
 * has no file on disk to open - both endpoints are commits.
 */
function PrLargeDiffPlaceholder(props: {
  readonly path: string;
  readonly onLoad: () => void;
}): ReactNode {
  return (
    <div className="p-4">
      <div className="flex items-center justify-between gap-3 rounded-md border border-border/70 bg-muted/30 p-3">
        <div className="min-w-0">
          <div className="text-ui-sm font-medium">Large diff</div>
          <StartTruncatedText className="block min-w-0 text-ui-xs text-muted-foreground">
            {props.path}
          </StartTruncatedText>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={props.onLoad}
        >
          Load diff
        </Button>
      </div>
    </div>
  );
}

function PrLocalDiffNote(props: { readonly children: ReactNode }): ReactNode {
  return (
    <p className="px-3 py-4 text-ui-xs text-muted-foreground/70">
      {props.children}
    </p>
  );
}
