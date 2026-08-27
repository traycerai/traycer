import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  File,
  type FileContents,
  type FileOptions,
  type PostRenderPhase,
} from "@pierre/diffs/react";
import { DiffEditProvider } from "@/components/diff/diff-edit-provider";
import { DiffHighlightLoading } from "@/components/diff/diff-highlight-loading";
import { useDiffsFileHighlightReady } from "@/components/diff/use-diff-highlight-ready";
import type { DiffClickToEditAdapter } from "@/components/diff/use-diff-click-to-edit";
import type { DiffContentFrameFileIdentity } from "@/components/diff/diff-content-primitive";
import { EmptyOriginEditAffordance } from "@/components/diff/empty-origin-edit-affordance";
import { useResolvedTheme } from "@/providers/use-resolved-theme";
import { resolveDiffThemeName } from "@/lib/git/diff-rendering";
import { DIFF_PANEL_UNSAFE_CSS } from "@/lib/git/diff-tokens-css";
import {
  clearSourceFindHighlights,
  paintSourceFindHighlights,
} from "@/components/epic-canvas/workspace-file/workspace-file-source-find-highlight";
import type { WorkspaceFileSourceFindTarget } from "@/components/epic-canvas/workspace-file/workspace-file-find-adapter";

const WORKSPACE_FILE_UNSAFE_CSS = `${DIFF_PANEL_UNSAFE_CSS}
  [data-line][data-workspace-file-reveal],
  [data-column-number][data-workspace-file-reveal] {
    --diffs-line-bg: color-mix(in srgb, var(--primary) 14%, var(--diffs-computed-diff-line-bg));
    color: var(--primary);
  }
  [data-line][data-workspace-file-find-active],
  [data-column-number][data-workspace-file-find-active] {
    --diffs-line-bg: color-mix(in srgb, var(--primary) 20%, var(--diffs-computed-diff-line-bg));
    color: var(--primary);
  }
`;

interface WorkspaceFileSourceFindTargetWithNonce extends WorkspaceFileSourceFindTarget {
  readonly nonce: number;
}

// `File` virtualizes rows, so a target line's row may not exist yet right
// after mount/scroll. Retry across a few frames to let virtualization settle,
// then give up rather than polling forever - matches the retry bound used for
// the comparable "wait for a virtualized DOM node after a jump" concern in
// `use-chat-find-controller.ts` (`FIND_REVEAL_ANCHOR_RETRY_LIMIT`).
const WORKSPACE_FILE_REVEAL_RETRY_LIMIT = 3;

/**
 * The shared Diffs-backed source surface for both reading and editing a
 * workspace file. Canvas find/reveal is projected into Diffs' open shadow DOM
 * so adopting the library renderer does not regress tile navigation.
 */
export function WorkspaceFileRenderer(props: {
  readonly content: string;
  readonly fileName: string;
  readonly language: string;
  readonly editing: boolean;
  readonly editAdapter: DiffClickToEditAdapter;
  /**
   * Wrap long lines instead of scrolling them. Unwrapped, Diffs gives its code
   * area its own horizontal scroll box (`overflow-x` on `[data-code]`, with the
   * gutter stuck to its left edge), which sits inside the tile's vertical
   * scroller; wrapped, that box does not exist and the tile scrolls in one axis.
   */
  readonly wordWrap: boolean;
  readonly revealLine: number | null;
  readonly revealNonce: number | null;
  readonly findTarget: WorkspaceFileSourceFindTargetWithNonce | null;
  readonly onRevealConsumed: () => void;
  /**
   * Stable file identity for cross-surface find/navigation and exact-host
   * resolution (parity with `DiffContentFrame`/`DiffBundleFileSectionFrame`)
   * - `null` while this tab's file identity isn't resolved yet.
   */
  readonly fileIdentity: DiffContentFrameFileIdentity | null;
}): ReactNode {
  const {
    content,
    editAdapter,
    editing,
    fileName,
    findTarget,
    language,
    onRevealConsumed,
    revealLine,
    revealNonce,
    wordWrap,
  } = props;
  const { resolvedTheme } = useResolvedTheme();
  const themeName = resolveDiffThemeName(resolvedTheme);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  // `cacheKey` must stay unique-and-stable for as long as `Editor`'s
  // `persistState` (always on - see `editorOptions` in
  // `use-diff-click-to-edit.ts`) needs to recognize "this is the same
  // session" - but it must NOT stay stable forever, because
  // `@pierre/diffs`' line-count cache only compares `contents` for an
  // UNKEYED file (`FileRenderer.isLineCacheForFile`); a cacheKey that's
  // stable across editing sessions tells it "same key, trust the cache"
  // regardless of content, so a render whose content shrank back (e.g. a
  // discarded draft reverting an empty file after typing, once blurred)
  // can leave the cached line count higher than what the freshly-rendered
  // code actually has, and `processFileResult` throws reading a line that
  // no longer exists. Bumping a generation on every `editing` transition -
  // the render-phase "storing information from previous renders" pattern
  // (https://react.dev/reference/react/useState#storing-information-from-previous-renders),
  // not an effect, so the very next render already carries the new key -
  // keeps the key stable for the whole of one attached session (persistState
  // still works) while guaranteeing the key differs the moment that session
  // ends, so a post-session render can never hit the stale cache above.
  const [wasEditing, setWasEditing] = useState(editing);
  const [cacheKeyGeneration, setCacheKeyGeneration] = useState(0);
  if (wasEditing !== editing) {
    setWasEditing(editing);
    setCacheKeyGeneration((generation) => generation + 1);
  }
  // Only an attached editing session needs a key at all (`persistState`'s
  // own requirement, above) - a read-only render supplies none, so Diffs
  // falls back to its own identity/content comparison
  // (`lineCache.file === file && lineCache.sourceContents === file.contents`)
  // and rebuilds the line cache on every real content change (e.g. an
  // external disk edit picked up by a reactivation refetch, which changes
  // `content` without ever flipping `editing`). A stable explicit key here
  // would keep telling `isLineCacheForFile` to trust a cache the content
  // comparison would have invalidated.
  const file = useMemo<FileContents>(
    () => ({
      name: fileName,
      contents: content,
      lang: language,
      cacheKey: editing
        ? `${fileName}:${String(cacheKeyGeneration)}`
        : undefined,
    }),
    [content, fileName, language, cacheKeyGeneration, editing],
  );
  const highlightReady = useDiffsFileHighlightReady({
    file,
    theme: themeName,
    enabled: !editing,
  });
  const handlePostRender = useCallback(
    (node: HTMLElement, phase: PostRenderPhase): void => {
      setContainer((current) => {
        if (phase === "unmount") return current === node ? null : current;
        return node;
      });
    },
    [],
  );
  const options = useMemo<FileOptions<undefined>>(
    () => ({
      disableFileHeader: true,
      overflow: wordWrap ? "wrap" : "scroll",
      useTokenTransformer: true,
      theme: themeName,
      themeType: resolvedTheme,
      unsafeCSS: WORKSPACE_FILE_UNSAFE_CSS,
      ...editAdapter.fileOptions,
      onPostRender: (node, _instance, phase) => {
        handlePostRender(node, phase);
      },
    }),
    [
      editAdapter.fileOptions,
      handlePostRender,
      resolvedTheme,
      themeName,
      wordWrap,
    ],
  );

  useEffect(() => {
    if (container === null || revealLine === null || revealNonce === null) {
      return;
    }
    const lineIndex = clampLineIndex(revealLine, content);
    let frameId: number | null = null;
    let remainingRetries = WORKSPACE_FILE_REVEAL_RETRY_LIMIT;
    const reveal = (): void => {
      const line = findDiffsLine(container, lineIndex);
      if (line === null) {
        if (remainingRetries <= 0) {
          onRevealConsumed();
          return;
        }
        remainingRetries -= 1;
        frameId = requestAnimationFrame(reveal);
        return;
      }
      markDiffsLine(container, "data-workspace-file-reveal", lineIndex, "");
      line.scrollIntoView({ block: "center", behavior: "auto" });
      onRevealConsumed();
    };
    reveal();
    return () => {
      if (frameId !== null) cancelAnimationFrame(frameId);
    };
  }, [container, content, onRevealConsumed, revealLine, revealNonce]);

  useEffect(() => {
    if (container === null) return;
    const contentRoot =
      container.shadowRoot?.querySelector<HTMLElement>("[data-content]");
    if (contentRoot === undefined || contentRoot === null) return;
    clearDiffsFindMark(container);
    if (findTarget === null) {
      clearSourceFindHighlights(contentRoot);
      return;
    }
    const lineIndex = clampLineIndex(findTarget.active.line, content);
    markDiffsLine(
      container,
      "data-workspace-file-find-active",
      lineIndex,
      "true",
    );
    const activeGutter = container.shadowRoot?.querySelector<HTMLElement>(
      `[data-column-number][data-line-index="${lineIndex}"]`,
    );
    activeGutter?.setAttribute(
      "data-workspace-file-find-column",
      String(findTarget.active.column),
    );
    findDiffsLine(container, lineIndex)?.scrollIntoView({
      block: "center",
      behavior: "auto",
    });
    paintSourceFindHighlights({
      root: contentRoot,
      matches: findTarget.matches,
      activeOffset: findTarget.active.offset,
    });
    return () => {
      clearSourceFindHighlights(contentRoot);
      clearDiffsFindMark(container);
    };
  }, [container, content, findTarget]);

  // Zero-line content has no clickable line/token, in read mode or while an
  // activation is still attaching - keep the affordance up until
  // `editAdapter.attached` confirms the real editor took over, not merely
  // until `editing` flips (which happens before the editor exists).
  const showEmptyOriginAffordance = content === "" && !editAdapter.attached;

  return (
    <div
      className="min-h-full min-w-full bg-canvas"
      data-diffs-host
      data-diffs-editor-boundary={editing ? "" : undefined}
      data-diff-find-file={props.fileIdentity?.findFilePath}
      data-bundle-diff-file-id={props.fileIdentity?.bundleFindFileId}
      onKeyDownCapture={editAdapter.onKeyDownCapture}
      onPointerDownCapture={editAdapter.onPointerDownCapture}
    >
      <DiffEditProvider>
        <div className="grid">
          {highlightReady ? (
            <div className="col-start-1 row-start-1">
              <File
                file={file}
                edit={editing}
                editorOptions={editAdapter.editorOptions}
                options={options}
              />
            </div>
          ) : (
            <div className="col-start-1 row-start-1">
              <DiffHighlightLoading testId="workspace-file-highlighting" />
            </div>
          )}
          {showEmptyOriginAffordance ? (
            <EmptyOriginEditAffordance
              onActivate={editAdapter.activateEmptyOrigin}
            />
          ) : null}
        </div>
      </DiffEditProvider>
    </div>
  );
}

function clampLineIndex(lineNumber: number, content: string): number {
  const lineCount = content.length === 0 ? 1 : content.split("\n").length;
  return Math.min(Math.max(lineNumber, 1), lineCount) - 1;
}

function findDiffsLine(
  container: HTMLElement,
  lineIndex: number,
): HTMLElement | null {
  return (
    container.shadowRoot?.querySelector<HTMLElement>(
      `[data-line][data-line-index="${lineIndex}"]`,
    ) ?? null
  );
}

function markDiffsLine(
  container: HTMLElement,
  attribute: string,
  lineIndex: number,
  value: string,
): void {
  clearDiffsLineMark(container, attribute);
  const nodes = container.shadowRoot?.querySelectorAll<HTMLElement>(
    `[data-line-index="${lineIndex}"]`,
  );
  nodes?.forEach((node) => {
    node.setAttribute(attribute, value);
  });
}

function clearDiffsFindMark(container: HTMLElement): void {
  clearDiffsLineMark(container, "data-workspace-file-find-active");
  container.shadowRoot
    ?.querySelectorAll<HTMLElement>("[data-workspace-file-find-column]")
    .forEach((node) => {
      node.removeAttribute("data-workspace-file-find-column");
    });
}

function clearDiffsLineMark(container: HTMLElement, attribute: string): void {
  container.shadowRoot
    ?.querySelectorAll<HTMLElement>(`[${attribute}]`)
    .forEach((node) => {
      node.removeAttribute(attribute);
    });
}
