import {
  createContext,
  use,
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
  PrGetLocalDiffSummaryResponseV11,
  PrLocalDiffUnavailableReason,
} from "@traycer/protocol/host/pr-schemas";
import { DEFAULT_PR_LOCAL_FILE_DIFF_BYTE_BUDGET } from "@traycer/protocol/host/pr-schemas";
import { Button } from "@/components/ui/button";
import { BundleDiffFindRegistrationProvider } from "@/components/diff/bundle-diff-find-registration";
import { useBundleDiffFindRegistrationContext } from "@/components/diff/bundle-diff-find-registration-hooks";
import { DiffContentPrimitive } from "@/components/epic-canvas/git-diff/diff-content-primitive";
import { DiffBundleCollapseChevron } from "@/components/epic-canvas/git-diff/diff-bundle-file-section";
import { DiffContentLoadingSkeleton } from "@/components/epic-canvas/git-diff/diff-content-loading-skeleton";
import { GitErrorBlock } from "@/components/epic-canvas/git-diff/git-error-block";
import { TruncatedBanner } from "@/components/epic-canvas/git-diff/truncated-banner";
import { GitSectionStatsSummary } from "@/components/epic-canvas/git-diff/diff-tab-shell";
import { StartTruncatedText } from "@/components/ui/start-truncated-text";
import { PrExternalGitHubLink } from "@/components/epic-canvas/pr/pr-external-github-link";
import {
  prBundleDiffFindFileId,
  prBundleLoadedPatchCacheKey,
  usePrBundleDiffFind,
} from "@/components/epic-canvas/pr/pr-bundle-diff-find";
import type { DiffViewerPreferences } from "@/lib/diff/diff-viewer-preferences";
import { isPrLocalDiffLargeFile } from "@/lib/pr/pr-local-diff-large-file";
import {
  isPrLocalDiffFileCollapsed,
  prLocalDiffFileKey,
  prLocalDiffPreviousSideKey,
  type PrLocalDiffViewFile,
} from "@/lib/pr/pr-local-diff-file-key";
import {
  isHostUnsupportedError,
  usePrLocalFileDiffQuery,
  type PrLocalDiffTarget,
} from "@/hooks/pr/use-pr-local-diff";
import { useBundleDiffScrollRestoration } from "@/hooks/scroll/use-bundle-diff-scroll-restoration";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { PrDiffTileRef } from "@/stores/epics/canvas/types";

type PrLocalDiffSummarySuccess = Extract<
  PrGetLocalDiffSummaryResponseV11,
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
 * The identity of a section's body FOR ONE COMPARISON: its React `key`, and
 * the key its per-section "load" approvals ({@link PrSectionLoadApprovals})
 * are granted under - "Load diff" on a large file, "Load Full" past a
 * truncation. Both expire whenever the comparison they were approved FOR
 * changes. Without this, sections would key only by path: a summary refresh
 * that resolves new OIDs (the local branch advanced), or a whitespace-mode
 * flip, would carry a previously-approved `byteBudget: null` straight onto
 * the NEW comparison and defeat the 256KiB guard - the same identity
 * discipline `useEditableGitDiffSurface` applies via `fullDiffIdentity`.
 */
function sectionStateKey(
  mode: PrDiffPatchMode,
  file: PrLocalDiffViewFile,
  ignoreWhitespace: boolean,
): string {
  return [
    mode.comparisonKey,
    String(ignoreWhitespace),
    // Tagged per-side identities, not the lossy display strings: two files
    // whose replaced names collide must not share an approval, and a rename
    // side is byte-addressed independently of its partner.
    prLocalDiffPreviousSideKey(file),
    prLocalDiffFileKey(file),
    // NUL-joined: it is the one byte neither a git path nor a base64 token
    // can contain, so two fields can never collide into another identity's
    // key.
  ].join("\0");
}

/**
 * The per-section "load" approvals - "Load diff" on a large file, "Load
 * Full" past a truncation - keyed by {@link sectionStateKey}.
 *
 * Held at the FILES-VIEW level rather than as row state for one reason: the
 * find session retains a loaded patch after its row unmounts (a collapse, or
 * Virtuoso evicting it), and a retained patch must remount the SAME
 * renderable bytes when a match in it is revealed. Row-local approvals die
 * with the row, so the reveal would land on the large-file placeholder (no
 * DOM to paint the match in) or on the bounded re-fetch of a fully-loaded
 * truncated file (its cached truncated answer registers over the retained
 * full patch, and the tail's matches vanish). Approvals and retention share
 * one lifetime - the files view - and one identity discipline: an approval
 * is granted for a comparison and expires with it, which is what keying by
 * `sectionStateKey` gives (the key embeds the comparison and the whitespace
 * mode), so a summary refresh that resolves new OIDs still cannot carry a
 * `byteBudget: null` onto a comparison it was never approved for.
 */
interface PrSectionLoadApprovals {
  readonly isLoadRequested: (stateKey: string) => boolean;
  readonly isLoadFull: (stateKey: string) => boolean;
  readonly approveLoad: (stateKey: string) => void;
  readonly approveLoadFull: (stateKey: string) => void;
}

const PrSectionLoadApprovalsContext =
  createContext<PrSectionLoadApprovals | null>(null);

function usePrSectionLoadApprovals(): PrSectionLoadApprovals {
  const approvals = use(PrSectionLoadApprovalsContext);
  if (approvals === null) {
    throw new Error(
      "PR diff sections must render inside PrLocalDiffFilesView (no load-approval scope).",
    );
  }
  return approvals;
}

/** Files-view state behind {@link PrSectionLoadApprovals}. */
function usePrSectionLoadApprovalsState(): PrSectionLoadApprovals {
  const [loadRequested, setLoadRequested] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [loadFull, setLoadFull] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const isLoadRequested = useCallback(
    (stateKey: string): boolean => loadRequested.has(stateKey),
    [loadRequested],
  );
  const isLoadFull = useCallback(
    (stateKey: string): boolean => loadFull.has(stateKey),
    [loadFull],
  );
  const approveLoad = useCallback((stateKey: string): void => {
    setLoadRequested((current) =>
      current.has(stateKey) ? current : new Set(current).add(stateKey),
    );
  }, []);
  const approveLoadFull = useCallback((stateKey: string): void => {
    setLoadFull((current) =>
      current.has(stateKey) ? current : new Set(current).add(stateKey),
    );
  }, []);
  return useMemo(
    () => ({ isLoadRequested, isLoadFull, approveLoad, approveLoadFull }),
    [approveLoad, approveLoadFull, isLoadFull, isLoadRequested],
  );
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
  readonly summary: PrGetLocalDiffSummaryResponseV11 | null;
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
  // The mode seam's normalization: monolith files become view files with
  // `null` sidecars (legacy-unknown - a 1.0 host never reported byte paths),
  // so every consumer below the seam keys files one way and the tagged keys
  // all degrade to `p:` in fallback mode, by construction.
  const monolithViewFiles = useMemo(
    () =>
      monolithDiff === null
        ? null
        : monolithDiff.files.map((file): PrLocalDiffViewFile => ({
            path: file.path,
            previousPath: file.previousPath,
            status: file.status,
            insertions: file.insertions,
            deletions: file.deletions,
            isBinary: file.isBinary,
            pathBytes: null,
            previousPathBytes: null,
          })),
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

  if (
    monolithDiff !== null &&
    monolithPatches !== null &&
    monolithViewFiles !== null
  ) {
    return (
      <PrLocalDiffFilesView
        node={props.node}
        viewTabId={props.viewTabId}
        isStale={monolithDiff.isStale}
        localHeadOid={monolithDiff.localHeadOid}
        files={monolithViewFiles}
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
  summary: PrGetLocalDiffSummaryResponseV11 | null,
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
  readonly summary: PrGetLocalDiffSummaryResponseV11 | null;
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
  readonly files: readonly PrLocalDiffViewFile[];
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
  // One find session for BOTH patch modes - the sections below register their
  // coverage and loaded patches through its context regardless of where the
  // bytes came from, so what "searchable" means cannot diverge between a new
  // host and the old-host fallback. Registered before the empty-range return
  // so the hook order is stable across a range that empties and refills.
  const { registration: bundleFindRegistration, setRootElement } =
    usePrBundleDiffFind({
      node: props.node,
      viewTabId: props.viewTabId,
      files: props.files,
      comparisonKey: props.mode.comparisonKey,
      patchMode: props.mode.kind,
      monolithPatches:
        props.mode.kind === "monolith" ? props.mode.patches : null,
      ignoreWhitespace: props.preferences.ignoreWhitespace,
      virtuosoRef,
    });
  // Same lifetime as the find session above, on purpose - see the type's doc.
  const loadApprovals = usePrSectionLoadApprovalsState();

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
    <BundleDiffFindRegistrationProvider value={bundleFindRegistration}>
      <PrSectionLoadApprovalsContext.Provider value={loadApprovals}>
        <div ref={setRootElement} className="flex h-full min-h-0 flex-col">
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
                <span className="font-mono">
                  {props.localHeadOid.slice(0, 7)}
                </span>
                . GitHub is showing a different commit, so pushed changes you
                haven’t pulled — or local commits you haven’t pushed — will not
                match.
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
            computeItemKey={(_index, file) => prLocalDiffFileKey(file)}
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
              The patch was cut off after{" "}
              {props.monolithTruncation.shownPatches} of {props.files.length}{" "}
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
      </PrSectionLoadApprovalsContext.Provider>
    </BundleDiffFindRegistrationProvider>
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
  readonly file: PrLocalDiffViewFile;
  readonly mode: PrDiffPatchMode;
  readonly prUrl: string | null;
  readonly preferences: DiffViewerPreferences;
}): ReactNode {
  const { file, node } = props;
  const bundleFindRegistration = useBundleDiffFindRegistrationContext();
  const bundleFindFileId = prBundleDiffFindFileId(file);
  const toggleCollapsed = useEpicCanvasStore(
    (state) => state.togglePrDiffFileCollapsedInTab,
  );
  const fileKey = prLocalDiffFileKey(file);
  const collapsed = isPrLocalDiffFileCollapsed(
    node.view.collapsedFileKeys,
    file,
  );
  const { viewTabId } = props;
  const toggle = useCallback((): void => {
    toggleCollapsed(viewTabId, node.id, fileKey);
  }, [fileKey, node.id, toggleCollapsed, viewTabId]);
  // Re-notify when a collapsed section expands (find-driven or manual): the
  // diff body only mounts while expanded, so a mount-only notification would
  // leave a freshly-revealed match painted nowhere. The find session repaints
  // in place from this - no scroll, no search replay.
  useEffect(() => {
    if (collapsed) return;
    bundleFindRegistration.notifySectionMounted(bundleFindFileId);
  }, [bundleFindFileId, bundleFindRegistration, collapsed]);

  const label =
    file.previousPath === null
      ? file.path
      : `${file.previousPath} → ${file.path}`;

  // Deliberately NOT `DiffBundleFileSectionFrame`: that frame carries an
  // "open in editor" button, and a range diff has no file on disk to open -
  // both endpoints are commits, and the working-tree copy of a path may hold
  // neither side of the change. The rest of the frame (sticky header, border
  // rhythm, chevron) is reproduced so the two diff surfaces still read alike -
  // including the two find identity attributes the frame stamps, which are
  // how a revealed match is scoped to this section's DOM.
  return (
    <div
      className="border-b border-border/70 bg-background"
      data-diff-find-file={file.path}
      data-bundle-diff-file-id={bundleFindFileId}
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
          bundleFindFileId={bundleFindFileId}
          mode={props.mode}
          prUrl={props.prUrl}
          preferences={props.preferences}
        />
      )}
    </div>
  );
}

function PrLocalDiffFileBody(props: {
  readonly file: PrLocalDiffViewFile;
  readonly bundleFindFileId: string;
  readonly mode: PrDiffPatchMode;
  readonly prUrl: string | null;
  readonly preferences: DiffViewerPreferences;
}): ReactNode {
  const { file, mode } = props;
  // A summary-declared binary needs no section-level find registration: the
  // session already files it under "binary" coverage from the file list.
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
        stateKey={stateKey}
        file={file}
        bundleFindFileId={props.bundleFindFileId}
        comparisonKey={mode.comparisonKey}
        patch={mode.patches.get(file.path) ?? null}
        prUrl={props.prUrl}
        preferences={props.preferences}
      />
    );
  }
  return (
    <PrSplitFileBody
      key={stateKey}
      stateKey={stateKey}
      file={file}
      bundleFindFileId={props.bundleFindFileId}
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
  readonly file: PrLocalDiffViewFile;
  readonly stateKey: string;
  readonly bundleFindFileId: string;
  readonly mode: Extract<PrDiffPatchMode, { kind: "split" }>;
  readonly preferences: DiffViewerPreferences;
}): ReactNode {
  const { stateKey } = props;
  const loadApprovals = usePrSectionLoadApprovals();
  const handleLoad = useCallback((): void => {
    loadApprovals.approveLoad(stateKey);
  }, [loadApprovals, stateKey]);
  // The placeholder registers nothing with find: the session already files a
  // large file under "large" coverage from the file list, and a find reveal
  // deliberately does NOT press this button for the reader - the guard exists
  // to keep an unbounded patch off the main thread until asked for.
  if (
    isPrLocalDiffLargeFile(props.file) &&
    !loadApprovals.isLoadRequested(stateKey)
  ) {
    return (
      <PrLargeDiffPlaceholder path={props.file.path} onLoad={handleLoad} />
    );
  }
  return (
    <PrLocalFileDiffContent
      file={props.file}
      stateKey={stateKey}
      bundleFindFileId={props.bundleFindFileId}
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
  readonly file: PrLocalDiffViewFile;
  readonly stateKey: string;
  readonly bundleFindFileId: string;
  readonly comparisonKey: string;
  readonly patch: string | null;
  readonly prUrl: string | null;
  readonly preferences: DiffViewerPreferences;
}): ReactNode {
  const { stateKey } = props;
  const loadApprovals = usePrSectionLoadApprovals();
  const handleLoad = useCallback((): void => {
    loadApprovals.approveLoad(stateKey);
  }, [loadApprovals, stateKey]);
  // `null` and empty are different facts and get different sentences: the byte
  // budget never reached this file, versus the range genuinely changed nothing
  // in it (a pure mode change, say). Neither state registers with find here:
  // the session files a `null` patch under "truncated" coverage from the
  // monolith itself, and an empty patch registers as loaded below.
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
  if (
    isPrLocalDiffLargeFile(props.file) &&
    !loadApprovals.isLoadRequested(stateKey)
  ) {
    return (
      <PrLargeDiffPlaceholder path={props.file.path} onLoad={handleLoad} />
    );
  }
  return (
    <PrPatchContent
      patch={props.patch}
      cacheScope={`pr-local-diff:${prLocalDiffFileKey(props.file)}`}
      find={{
        fileId: props.bundleFindFileId,
        cacheKey: prBundleLoadedPatchCacheKey({
          comparisonKey: props.comparisonKey,
          file: props.file,
          ignoreWhitespace: props.preferences.ignoreWhitespace,
          isTruncated: false,
        }),
        isTruncated: false,
      }}
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
  readonly file: PrLocalDiffViewFile;
  readonly stateKey: string;
  readonly bundleFindFileId: string;
  readonly mode: Extract<PrDiffPatchMode, { kind: "split" }>;
  readonly preferences: DiffViewerPreferences;
}): ReactNode {
  const { bundleFindFileId, file, mode, stateKey } = props;
  const bundleFindRegistration = useBundleDiffFindRegistrationContext();
  const loadApprovals = usePrSectionLoadApprovals();
  const loadFull = loadApprovals.isLoadFull(stateKey);
  const handleLoadFull = useCallback((): void => {
    loadApprovals.approveLoadFull(stateKey);
  }, [loadApprovals, stateKey]);
  const query = usePrLocalFileDiffQuery({
    target: mode.target,
    mergeBaseOid: mode.mergeBaseOid,
    headOid: mode.headOid,
    path: file.path,
    previousPath: file.previousPath,
    pathBytes: file.pathBytes,
    previousPathBytes: file.previousPathBytes,
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

  // Find coverage for the answers that carry NO searchable patch: an errored
  // query and an `unavailable` file both mean the reader is looking at an
  // error block, not content ("failed"); a response the summary called text
  // but git calls binary joins the summary-declared binaries. A loaded patch
  // registers itself from `PrPatchContent`, and a later success supersedes a
  // registered failure in the session's coverage counts.
  //
  // A section that is mounted but shows NO content - a query pending for a
  // key that has no data yet, an error, an `unavailable` answer - also
  // UNREGISTERS whatever it registered before. The session retains a loaded
  // patch past its section's UNMOUNT on purpose (the row can remount and
  // show those bytes again), and a retained patch outranks any coverage
  // state; but a mounted section past "Load Full" will never render the
  // truncated bytes again - the approval only moves forward - so from the
  // moment the new key is pending they are dead for this comparison, and
  // leaving them indexed would have find match text that is not in the DOM,
  // report the file as truncated rather than loading/failed, and park
  // navigation on a skeleton. Registered ⇔ renderable by this section, or
  // retained after its unmount.
  const responseBinary = response?.kind === "diff" && response.isBinary;
  const responseFailed = query.error !== null || unavailableReason !== null;
  const contentAbsent = query.isPending || responseFailed;
  useEffect(() => {
    if (contentAbsent) {
      bundleFindRegistration.unregisterLoadedPatch(bundleFindFileId);
    }
    if (responseFailed) {
      bundleFindRegistration.registerCoverageState(bundleFindFileId, "failed");
      return;
    }
    if (responseBinary) {
      bundleFindRegistration.registerCoverageState(bundleFindFileId, "binary");
    }
  }, [
    bundleFindFileId,
    bundleFindRegistration,
    contentAbsent,
    responseBinary,
    responseFailed,
  ]);

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
        cacheScope={`pr-local-diff:${mode.mergeBaseOid}:${mode.headOid}:${prLocalDiffFileKey(file)}`}
        find={{
          fileId: bundleFindFileId,
          cacheKey: prBundleLoadedPatchCacheKey({
            comparisonKey: mode.comparisonKey,
            file,
            ignoreWhitespace: props.preferences.ignoreWhitespace,
            isTruncated: response.isTruncated,
          }),
          isTruncated: response.isTruncated,
        }}
        preferences={props.preferences}
      />
    </>
  );
}

/**
 * The one place a PR file's patch bytes reach the screen, in either patch
 * mode - so it is also the one place they reach the find index. Registering
 * here (rather than in each mode's fetch/lookup body) is what keeps "what
 * find can search" identical between a new host and the fallback: a rendered
 * patch is a searchable patch, and stays one after the row virtualizes away.
 */
function PrPatchContent(props: {
  readonly patch: string;
  readonly cacheScope: string;
  readonly find: {
    readonly fileId: string;
    readonly cacheKey: string;
    readonly isTruncated: boolean;
  };
  readonly preferences: DiffViewerPreferences;
}): ReactNode {
  const bundleFindRegistration = useBundleDiffFindRegistrationContext();
  const { cacheKey, fileId, isTruncated } = props.find;
  // Registered BEFORE the hunk check on purpose: a header-only change has no
  // rows to search, but leaving it unregistered would count it as "unloaded"
  // in the coverage message forever, and it is fully loaded.
  useEffect(() => {
    bundleFindRegistration.registerLoadedPatch({
      fileId,
      patch: props.patch,
      cacheKey,
      isTruncated,
    });
  }, [bundleFindRegistration, cacheKey, fileId, isTruncated, props.patch]);
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
