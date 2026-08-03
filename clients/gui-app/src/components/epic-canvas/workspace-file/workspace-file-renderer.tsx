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
  readonly cacheKey: string;
  readonly editAdapter: DiffClickToEditAdapter;
  readonly revealLine: number | null;
  readonly revealNonce: number | null;
  readonly findTarget: WorkspaceFileSourceFindTargetWithNonce | null;
  readonly onRevealConsumed: () => void;
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
  } = props;
  const { resolvedTheme } = useResolvedTheme();
  const themeName = resolveDiffThemeName(resolvedTheme);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const file = useMemo<FileContents>(
    () => ({
      name: fileName,
      contents: content,
      lang: language,
      cacheKey: props.cacheKey,
    }),
    [content, fileName, language, props.cacheKey],
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
      overflow: "scroll",
      useTokenTransformer: true,
      theme: themeName,
      themeType: resolvedTheme,
      unsafeCSS: WORKSPACE_FILE_UNSAFE_CSS,
      ...editAdapter.fileOptions,
      onPostRender: (node, _instance, phase) => {
        handlePostRender(node, phase);
      },
    }),
    [editAdapter.fileOptions, handlePostRender, resolvedTheme, themeName],
  );

  useEffect(() => {
    if (container === null || revealLine === null || revealNonce === null) {
      return;
    }
    const lineIndex = clampLineIndex(revealLine, content);
    let frameId: number | null = null;
    const reveal = (): void => {
      const line = findDiffsLine(container, lineIndex);
      if (line === null) {
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

  return (
    <div
      className="min-h-full min-w-full bg-canvas"
      data-diffs-host
      data-diffs-editor-boundary={editing ? "" : undefined}
      onKeyDownCapture={editAdapter.onKeyDownCapture}
      onPointerDownCapture={editAdapter.onPointerDownCapture}
    >
      <DiffEditProvider>
        {highlightReady ? (
          <File
            file={file}
            edit={editing}
            editorOptions={editAdapter.editorOptions}
            options={options}
          />
        ) : (
          <DiffHighlightLoading testId="workspace-file-highlighting" />
        )}
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
