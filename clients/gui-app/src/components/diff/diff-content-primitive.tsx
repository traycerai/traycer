import {
  useMemo,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type UIEvent,
} from "react";
import { FileDiff } from "@pierre/diffs/react";
import {
  hydratePartialDiff,
  parseDiffFromFile,
  parsePatchFiles,
  type FileContents,
  type FileDiffMetadata,
} from "@pierre/diffs";
import type { EditorOptions } from "@pierre/diffs/edit";
import { useResolvedTheme } from "@/providers/use-resolved-theme";
import {
  buildPatchCacheKey,
  resolveDiffThemeName,
} from "@/lib/git/diff-rendering";
import { DIFF_PANEL_UNSAFE_CSS } from "@/lib/git/diff-tokens-css";
import { cn } from "@/lib/utils";
import { DiffEditProvider } from "@/components/diff/diff-edit-provider";
import { DiffHighlightLoading } from "@/components/diff/diff-highlight-loading";
import { useDiffsDiffHighlightReady } from "@/components/diff/use-diff-highlight-ready";
import type { DiffClickToEditAdapter } from "@/components/diff/use-diff-click-to-edit";

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
  readonly editAdapter?: DiffClickToEditAdapter;
  readonly editSession?: {
    readonly editorOptions: EditorOptions<undefined>;
    /**
     * Full baseline file contents, already fetched before this prop is ever
     * set. Hydrated into the parsed diff synchronously (see
     * `hydrateFileDiffForEdit`) so `<FileDiff>` never receives a partial
     * `FileDiffMetadata` while `edit` is true - `@pierre/diffs` treats a
     * fresh partial object for the same file as an unrelated render model
     * and never re-attempts hydration for it (see FileDiffMetadata.isPartial
     * in @pierre/diffs' types), which otherwise permanently strands the
     * editor without ever attaching a contentEditable surface.
     */
    readonly oldFile: FileContents | null;
    readonly newFile: FileContents;
  };
}

export interface DiffContentFrameProps {
  readonly sizing: "fill" | "content";
  readonly banner: ReactNode | null;
  readonly scrollContainerRef:
    ((element: HTMLDivElement | null) => void) | null;
  readonly onScroll: ((event: UIEvent<HTMLDivElement>) => void) | null;
  readonly onKeyDownCapture?: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly onPointerDownCapture?: (event: PointerEvent<HTMLDivElement>) => void;
  readonly editorBoundary?: boolean;
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

/**
 * Source-agnostic diff renderer. Owns the `@pierre/diffs` pipeline
 * (`parsePatchFiles` -> `<FileDiff>`) so live Git diffs, chat snapshot tiles,
 * and inline file-change blocks share rendering, theming, and view options
 * without coupling callers to the epic-canvas package.
 */
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

  const pierreOverflow = resolvePierreOverflow(props.wordWrap);

  return (
    <DiffEditProvider>
      {highlightReady ? (
        fileDiffs.map((fileDiff) => (
          <FileDiff
            key={fileDiff.name}
            fileDiff={fileDiff}
            edit={props.editSession !== undefined}
            editorOptions={props.editSession?.editorOptions}
            options={{
              disableFileHeader: !props.fileHeaders,
              collapsed: false,
              diffStyle: props.mode === "split" ? "split" : "unified",
              diffIndicators: props.indicatorStyle,
              disableBackground: !props.backgrounds,
              disableLineNumbers: !props.lineNumbers,
              lineDiffType: "none",
              useTokenTransformer: true,
              overflow: pierreOverflow,
              theme: themeName,
              themeType: resolvedTheme,
              unsafeCSS: DIFF_PANEL_WITH_FIND_UNSAFE_CSS,
              ...props.editAdapter?.diffOptions,
            }}
          />
        ))
      ) : (
        <DiffHighlightLoading testId="diff-highlighting" />
      )}
    </DiffEditProvider>
  );
}

function resolvePierreOverflow(wordWrap: boolean): "wrap" | "scroll" {
  return wordWrap ? "wrap" : "scroll";
}

/**
 * Synchronously upgrades a patch-parsed (always partial) `FileDiffMetadata`
 * to a fully loaded one before it ever reaches `<FileDiff edit={true}>`.
 *
 * `@pierre/diffs` only attempts to hydrate a partial diff once, at the
 * moment an editor first attaches to it (`FileDiff.attachEditor` ->
 * `loadFilesIfNecessary`), and only for `change`/`rename-changed`/
 * `rename-pure` types. A later render that hands it a *different* partial
 * `FileDiffMetadata` object for the same file - which is exactly what a
 * fresh `parsePatchFiles()` call produces - is "treated as a new partial
 * render model" per the library's own `FileDiffMetadata.isPartial` docs,
 * permanently stranding the editor without a hydration attempt. Doing the
 * hydration ourselves, before `edit` ever flips true, sidesteps that
 * async race entirely.
 */
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
  // "new" / "deleted": hydratePartialDiff has no case for these (they carry
  // their full content in the patch already) - build a full, non-partial
  // diff straight from file contents instead.
  return parseDiffFromFile(oldFile, newFile);
}
