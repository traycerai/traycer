import {
  useMemo,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type UIEvent,
} from "react";
import { File, FileDiff } from "@pierre/diffs/react";
import {
  hydratePartialDiff,
  parseDiffFromFile,
  parsePatchFiles,
  type FileContents,
  type FileDiffContentsLoader,
  type FileDiffMetadata,
} from "@pierre/diffs";
import type { EditorOptions } from "@pierre/diffs/edit";
import {
  useResolvedTheme,
  type ResolvedTheme,
} from "@/providers/use-resolved-theme";
import {
  buildPatchCacheKey,
  resolveDiffThemeName,
} from "@/lib/git/diff-rendering";
import { DIFF_PANEL_UNSAFE_CSS } from "@/lib/git/diff-tokens-css";
import { cn } from "@/lib/utils";
import { DiffEditProvider } from "@/components/diff/diff-edit-provider";
import { DiffHighlightLoading } from "@/components/diff/diff-highlight-loading";
import {
  useDiffsDiffEditHighlightReady,
  useDiffsDiffHighlightReady,
} from "@/components/diff/use-diff-highlight-ready";
import type { DiffClickToEditAdapter } from "@/components/diff/use-diff-click-to-edit";
import { EmptyOriginEditAffordance } from "@/components/diff/empty-origin-edit-affordance";

const DIFF_FIND_UNSAFE_CSS = `
  [data-traycer-diff-find-match] {
    --diffs-line-bg: color-mix(in srgb, var(--primary) 22%, var(--diffs-computed-diff-line-bg));
  }
  [data-traycer-diff-find-active] {
    --diffs-line-bg: color-mix(in srgb, var(--primary) 52%, var(--diffs-computed-diff-line-bg));
    outline: 1px solid color-mix(in srgb, var(--primary) 70%, transparent);
    outline-offset: -1px;
  }
`;

const DIFF_PANEL_WITH_FIND_UNSAFE_CSS = `${DIFF_PANEL_UNSAFE_CSS}\n${DIFF_FIND_UNSAFE_CSS}`;

export interface DiffContentPrimitiveProps {
  readonly patch: string;
  readonly cacheScope: string;
  readonly mode: "split" | "unified";
  readonly wordWrap: boolean;
  readonly backgrounds: boolean;
  readonly lineNumbers: boolean;
  readonly indicatorStyle: "bars" | "classic" | "none";
  readonly fileHeaders: boolean;
  readonly loadDiffFiles?: FileDiffContentsLoader;
  readonly editAdapter?: DiffClickToEditAdapter;
  readonly editSession?: {
    readonly editorOptions: EditorOptions<undefined>;
    /** Hydrated into the parsed diff synchronously (see `hydrateFileDiffForEdit`) so `<FileDiff>` never receives a
     * partial `FileDiffMetadata` while `edit` is true. */
    readonly oldFile: FileContents | null;
    readonly newFile: FileContents;
  };
  /** The renderer always verifies this against the parsed diff before exposing the empty-origin path: a stale or
   * placeholder size must never replace a real `<FileDiff>` with the whole-file `<File>` editor. */
  readonly isEmptyFile: boolean;
}

export interface DiffContentFrameFileIdentity {
  readonly findFilePath: string;
  /** Reuse a shared builder (e.g. `gitBundleDiffFindFileId`) rather than hand-formatting this per surface. */
  readonly bundleFindFileId: string;
}

export interface DiffContentFrameProps {
  readonly sizing: "fill" | "content";
  readonly banner: ReactNode | null;
  readonly scrollContainerRef:
    | ((element: HTMLDivElement | null) => void)
    | null;
  readonly onScroll: ((event: UIEvent<HTMLDivElement>) => void) | null;
  readonly onKeyDownCapture?: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly onPointerDownCapture?: (event: PointerEvent<HTMLDivElement>) => void;
  readonly editorBoundary?: boolean;
  /** Every caller of this frame should supply one instead of leaving single-file/workspace hosts with only the
   * generic `data-diffs-host` marker. */
  readonly fileIdentity: DiffContentFrameFileIdentity | null;
  readonly children: ReactNode;
}

export function DiffContentFrame(props: DiffContentFrameProps): ReactNode {
  const { banner, children, onScroll, scrollContainerRef, sizing } = props;
  const fillsContainer = sizing === "fill";

  return (
    <div
      className={cn(
        "flex w-full flex-col",
        fillsContainer ? "min-h-0 flex-1 overflow-hidden" : "min-h-0 shrink-0",
      )}
      data-diffs-host
      data-diffs-editor-boundary={
        props.editorBoundary === true ? "" : undefined
      }
      data-diff-find-file={props.fileIdentity?.findFilePath}
      data-bundle-diff-file-id={props.fileIdentity?.bundleFindFileId}
      onKeyDownCapture={props.onKeyDownCapture}
      onPointerDownCapture={props.onPointerDownCapture}
    >
      {banner}
      <div
        ref={scrollContainerRef}
        onScroll={onScroll ?? undefined}
        className={cn(
          fillsContainer ? "min-h-0 flex-1 overflow-auto" : "overflow-x-auto",
        )}
      >
        {children}
      </div>
    </div>
  );
}

/** Owns the `@pierre/diffs` pipeline (`parsePatchFiles` -> `<FileDiff>`) so live Git diffs, chat snapshot
 * tiles, and inline file-change blocks share rendering, theming. */
export function DiffContentPrimitive(
  props: DiffContentPrimitiveProps,
): ReactNode {
  const { resolvedTheme } = useResolvedTheme();
  const parsed = useMemo(() => {
    const cacheKey = buildPatchCacheKey(
      props.patch,
      `${resolvedTheme}:${props.cacheScope}`,
    );
    return parsePatchFiles(props.patch, cacheKey);
  }, [resolvedTheme, props.patch, props.cacheScope]);
  const parsedFileDiffs = useMemo(
    () => parsed.flatMap((patchGroup) => patchGroup.files),
    [parsed],
  );
  const editOldFile = props.editSession?.oldFile;
  const editNewFile = props.editSession?.newFile;
  const fileDiffs = useMemo(() => {
    if (editNewFile === undefined) return parsedFileDiffs;
    return parsedFileDiffs.map((fileDiff) =>
      hydrateFileDiffForEdit(fileDiff, editOldFile ?? null, editNewFile),
    );
  }, [parsedFileDiffs, editOldFile, editNewFile]);
  const themeName = resolveDiffThemeName(resolvedTheme);
  const highlightReady = useDiffsDiffHighlightReady({
    fileDiffs,
    theme: themeName,
    enabled: props.editSession === undefined,
  });
  const editHighlightReady = useDiffsDiffEditHighlightReady({
    fileDiffs,
    theme: themeName,
    enabled: props.editSession !== undefined,
  });
  const nonEmptyEditorReady =
    props.editSession !== undefined && editHighlightReady;

  const pierreOverflow = resolvePierreOverflow(props.wordWrap);
  const confirmedEmptyNewFile =
    props.isEmptyFile && isConfirmedEmptyNewFileDiff(fileDiffs);
  // An empty file's `FileDiffMetadata` carries zero hunks, so it never renders a clickable line/token.
  const emptyOriginAdapter =
    confirmedEmptyNewFile &&
    props.editAdapter !== undefined &&
    !props.editAdapter.attached
      ? props.editAdapter
      : null;
  // A diff with zero hunks (an empty new/untracked file) never renders a content element at all in `<FileDiff>`.
  const emptyFileEditSession =
    confirmedEmptyNewFile && props.editSession !== undefined
      ? props.editSession
      : null;

  return (
    <DiffEditProvider>
      <div className="grid">
        <div className="col-start-1 row-start-1">
          {renderDiffContentBody({
            emptyFileEditSession,
            fileDiffs,
            highlightReady,
            nonEmptyEditorReady,
            props,
            pierreOverflow,
            themeName,
            resolvedTheme,
          })}
        </div>
        {emptyOriginAdapter !== null ? (
          <EmptyOriginEditAffordance
            onActivate={emptyOriginAdapter.activateEmptyOrigin}
          />
        ) : null}
      </div>
    </DiffEditProvider>
  );
}

function resolvePierreOverflow(wordWrap: boolean): "wrap" | "scroll" {
  return wordWrap ? "wrap" : "scroll";
}

/** The plain `<File>` fallback exists only for a genuinely empty, newly-added file: `@pierre/diffs` renders
 * that zero-hunk model with no attachable line. */
function isConfirmedEmptyNewFileDiff(
  fileDiffs: ReadonlyArray<FileDiffMetadata>,
): boolean {
  if (fileDiffs.length !== 1) return false;
  const fileDiff = fileDiffs[0];
  return (
    fileDiff.type === "new" &&
    fileDiff.hunks.length === 0 &&
    fileDiff.additionLines.length === 0 &&
    fileDiff.deletionLines.length === 0
  );
}

function renderDiffContentBody(args: {
  readonly emptyFileEditSession: NonNullable<
    DiffContentPrimitiveProps["editSession"]
  > | null;
  readonly fileDiffs: ReadonlyArray<FileDiffMetadata>;
  readonly highlightReady: boolean;
  readonly nonEmptyEditorReady: boolean;
  readonly props: DiffContentPrimitiveProps;
  readonly pierreOverflow: "wrap" | "scroll";
  readonly themeName: "pierre-light" | "pierre-dark";
  readonly resolvedTheme: ResolvedTheme;
}): ReactNode {
  const { emptyFileEditSession, props } = args;
  // Changing this inert comment when the edit cache becomes ready makes @pierre/diffs force one render of the
  // hydrated model before its sibling edit-attach layout effect runs.
  const diffUnsafeCSS = args.nonEmptyEditorReady
    ? `${DIFF_PANEL_WITH_FIND_UNSAFE_CSS}\n/* traycer-edit-cache-ready */`
    : DIFF_PANEL_WITH_FIND_UNSAFE_CSS;
  // An empty new file is the one surface where that lifetime is spent growing - the person is typing into it -
  // so it is the last place to skip the wait.
  if (!args.highlightReady) {
    return <DiffHighlightLoading testId="diff-highlighting" />;
  }
  if (emptyFileEditSession !== null) {
    return (
      <File
        file={emptyFileEditSession.newFile}
        edit
        editorOptions={emptyFileEditSession.editorOptions}
        options={{
          disableFileHeader: !props.fileHeaders,
          overflow: args.pierreOverflow,
          useTokenTransformer: true,
          theme: args.themeName,
          themeType: args.resolvedTheme,
          unsafeCSS: DIFF_PANEL_WITH_FIND_UNSAFE_CSS,
          ...props.editAdapter?.fileOptions,
        }}
      />
    );
  }
  return args.fileDiffs.map((fileDiff) => (
    <FileDiff
      key={fileDiff.name}
      fileDiff={fileDiff}
      // `@pierre/diffs` never re-attempts hydration for a partial diff once `edit` flips true, so claiming a working
      // editor here would silently strand it the same way an unhydrated diff always did.
      edit={args.nonEmptyEditorReady ? !fileDiff.isPartial : false}
      editorOptions={
        !args.nonEmptyEditorReady || fileDiff.isPartial
          ? undefined
          : props.editSession?.editorOptions
      }
      options={{
        disableFileHeader: !props.fileHeaders,
        collapsed: false,
        diffStyle: props.mode === "split" ? "split" : "unified",
        diffIndicators: props.indicatorStyle,
        disableBackground: !props.backgrounds,
        disableLineNumbers: !props.lineNumbers,
        lineDiffType: "none",
        useTokenTransformer: true,
        overflow: args.pierreOverflow,
        theme: args.themeName,
        themeType: args.resolvedTheme,
        unsafeCSS: diffUnsafeCSS,
        loadDiffFiles: props.loadDiffFiles,
        ...props.editAdapter?.diffOptions,
      }}
    />
  ));
}

/** Doing the hydration ourselves, before `edit` ever flips true, sidesteps that async race entirely. */
function hydrateFileDiffForEdit(
  fileDiff: FileDiffMetadata,
  oldFile: FileContents | null,
  newFile: FileContents,
): FileDiffMetadata {
  if (!fileDiff.isPartial) return fileDiff;
  if (fileDiff.type === "rename-pure") {
    return hydratePartialDiff("clone", fileDiff, { oldFile: null, newFile });
  }
  if (fileDiff.type === "change" || fileDiff.type === "rename-changed") {
    if (oldFile === null) return fileDiff;
    return hydratePartialDiff("clone", fileDiff, { oldFile, newFile });
  }
  // "new" / "deleted": hydratePartialDiff has no case for these (they carry their full content in the patch
  // already) - build a full, non-partial diff straight from file contents instead.
  return parseDiffFromFile(oldFile, newFile);
}
