import { useMemo, type ReactNode, type UIEvent } from "react";
import { FileDiff } from "@pierre/diffs/react";
import { parsePatchFiles } from "@pierre/diffs";
import { useResolvedTheme } from "@/providers/use-resolved-theme";
import {
  buildPatchCacheKey,
  resolveDiffThemeName,
} from "@/lib/git/diff-rendering";
import { DIFF_PANEL_UNSAFE_CSS } from "@/lib/git/diff-tokens-css";
import { cn } from "@/lib/utils";

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
}

export interface DiffContentFrameProps {
  readonly sizing: "fill" | "content";
  readonly banner: ReactNode | null;
  readonly scrollContainerRef:
    ((element: HTMLDivElement | null) => void) | null;
  readonly onScroll: ((event: UIEvent<HTMLDivElement>) => void) | null;
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

  const pierreOverflow = resolvePierreOverflow(props.wordWrap);

  return (
    <>
      {parsed.flatMap((patchGroup) =>
        patchGroup.files.map((fileDiff) => (
          <FileDiff
            key={fileDiff.name}
            fileDiff={fileDiff}
            options={{
              disableFileHeader: !props.fileHeaders,
              collapsed: false,
              diffStyle: props.mode === "split" ? "split" : "unified",
              diffIndicators: props.indicatorStyle,
              disableBackground: !props.backgrounds,
              disableLineNumbers: !props.lineNumbers,
              lineDiffType: "none",
              overflow: pierreOverflow,
              theme: resolveDiffThemeName(resolvedTheme),
              themeType: resolvedTheme,
              unsafeCSS: DIFF_PANEL_WITH_FIND_UNSAFE_CSS,
            }}
          />
        )),
      )}
    </>
  );
}

function resolvePierreOverflow(wordWrap: boolean): "wrap" | "scroll" {
  return wordWrap ? "wrap" : "scroll";
}
