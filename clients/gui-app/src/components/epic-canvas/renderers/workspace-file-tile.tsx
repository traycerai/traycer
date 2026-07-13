import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { StartTruncatedText } from "@/components/ui/start-truncated-text";
import { useWorkspaceReadFile } from "@/hooks/workspace/use-read-file-query";
import { languageFromFilePath } from "@/lib/file-change-diff-hunks";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { cn } from "@/lib/utils";
import { TraycerMarkdown } from "@/markdown";
import { useShikiHighlighter } from "@/markdown/shiki-highlighter";
import { useThrottledCodeHighlight } from "@/markdown/use-throttled-code-highlight";
import { useRegisterTileFindAdapter } from "@/components/epic-canvas/tile-find/tile-find-adapter-context";
import {
  createWorkspaceFileFindAdapter,
  type WorkspaceFileFindEnvironment,
  type WorkspaceFileSourceFindTarget,
} from "@/components/epic-canvas/workspace-file/workspace-file-find-adapter";
import {
  clearSourceFindHighlights,
  paintSourceFindHighlights,
} from "@/components/epic-canvas/workspace-file/workspace-file-source-find-highlight";
import type { WorkspaceFileRef } from "@/stores/epics/canvas/types";
import {
  clearWorkspaceFileRevealTarget,
  useWorkspaceFileRevealTarget,
  type WorkspaceFileRevealTarget,
} from "@/stores/epics/canvas/workspace-file-reveal-store";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { useHostReachability } from "@/hooks/agent/use-host-reachability";
import { useNativeDivScrollRestoration } from "@/hooks/scroll/use-native-div-scroll-restoration";
import { WorkspaceFileDeadTileBanner } from "./dead-tile-banner";
import { WorkspaceMarkdownLinkProvider } from "@/components/epic-canvas/workspace-file/workspace-markdown-link-provider";

const MAX_MARKDOWN_PREVIEW_CHARS = 100_000;

type WorkspaceFileViewMode = "source" | "preview";

interface WorkspaceFileSourceFindTargetWithNonce extends WorkspaceFileSourceFindTarget {
  readonly nonce: number;
}

interface WorkspaceFileLineHighlight {
  readonly line: number;
  readonly top: number;
  readonly height: number;
}

const MARKDOWN_VIEW_MODE_OPTIONS: ReadonlyArray<{
  readonly mode: WorkspaceFileViewMode;
  readonly label: string;
}> = [
  { mode: "preview", label: "Preview" },
  { mode: "source", label: "Markdown" },
];

/**
 * Host-binding gate for the file preview.
 *
 * `useWorkspaceReadFile` resolves through `useHostClient()`, which is the
 * renderer's *active* host - it does not honor the per-tile
 * `TabHostProvider`. A workspace-file tab carries the host it was
 * opened against (`node.hostId`); if that host is unreachable, or is
 * simply not the currently-active host, the read RPC would silently hit
 * the wrong host. Gate on both conditions and show an informational
 * banner instead of mis-reading.
 */
export function WorkspaceFileTile(props: {
  readonly node: WorkspaceFileRef;
  readonly viewTabId: string;
  readonly isActive: boolean;
}) {
  const { node } = props;
  const tabHostId = useTabHostId();
  const activeHostId = useReactiveActiveHostId();
  const reachability = useHostReachability(tabHostId);
  // Read the target here (not just in the live body) so the dead-tile / inactive
  // states - which return BEFORE the live preview mounts - can still evict a
  // stranded entry. Scoped to this tab so a click meant for one tab's preview
  // doesn't move another tab's preview of the same file (CL-6).
  const revealTarget = useWorkspaceFileRevealTarget(props.viewTabId, node.id);
  const isDeadTile =
    reachability.status === "unreachable" || tabHostId !== activeHostId;

  // A reveal target on a dead / inactive tile can never be consumed: the live
  // preview that runs the consume effect (G4) never mounts. Drop it so these
  // states don't strand entries on the channel (CL-5). Keyed on the target so a
  // fresh click while the tile stays dead still evicts.
  useEffect(() => {
    if (isDeadTile && revealTarget !== null) {
      clearWorkspaceFileRevealTarget(props.viewTabId, node.id);
    }
  }, [isDeadTile, revealTarget, props.viewTabId, node.id]);

  if (reachability.status === "unreachable") {
    return (
      <WorkspaceFileDeadTileBanner
        hostLabel={reachability.hostLabel}
        reason="offline"
        testId={`workspace-file-tile-${node.id}`}
      />
    );
  }
  if (tabHostId !== activeHostId) {
    return (
      <WorkspaceFileDeadTileBanner
        hostLabel={reachability.hostLabel}
        reason="inactive"
        testId={`workspace-file-tile-${node.id}`}
      />
    );
  }
  return (
    <WorkspaceFileTileLive
      node={node}
      viewTabId={props.viewTabId}
      isActive={props.isActive}
      revealTarget={revealTarget}
    />
  );
}

function WorkspaceFileTileLive(props: {
  readonly node: WorkspaceFileRef;
  readonly viewTabId: string;
  readonly isActive: boolean;
  readonly revealTarget: WorkspaceFileRevealTarget | null;
}) {
  const { node, revealTarget } = props;
  const query = useWorkspaceReadFile(node.workspacePath, node.filePath);
  const rawContent = readFileContent(query.data);
  const content = useMemo(
    () =>
      rawContent === null ? null : normalizeWorkspaceFileContent(rawContent),
    [rawContent],
  );
  const displayError = readFileDisplayError(
    readFilePayloadError(query.data),
    query.isError,
    query.error,
  );
  const truncated = readFileTruncated(query.data);
  const language = useMemo(() => languageForFileName(node.name), [node.name]);
  const markdownFile = useMemo(
    () => isMarkdownFileName(node.name),
    [node.name],
  );
  const [viewMode, setViewMode] = useState<WorkspaceFileViewMode>("source");
  const markdownPreviewRootRef = useRef<HTMLElement | null>(null);
  const findEnvironmentRef = useRef<WorkspaceFileFindEnvironment | null>(null);
  const [sourceFindTarget, setSourceFindTarget] =
    useState<WorkspaceFileSourceFindTargetWithNonce | null>(null);
  const sourceFindNonceRef = useRef(0);
  const findAdapter = useMemo(
    () => createWorkspaceFileFindAdapter({ tileInstanceId: node.instanceId }),
    [node.instanceId],
  );
  useRegisterTileFindAdapter(findAdapter);
  const revealSourceMatch = useCallback(
    (target: WorkspaceFileSourceFindTarget | null): void => {
      if (target === null) {
        setSourceFindTarget(null);
        return;
      }
      sourceFindNonceRef.current += 1;
      setSourceFindTarget({
        ...target,
        nonce: sourceFindNonceRef.current,
      });
    },
    [],
  );

  // The preview content has loaded into a state the consume effect never runs
  // from - a host/payload error, or an empty/failed read (`content === null`).
  // Neither mounts `CodeEditorPreview`, so evict any pending target here rather
  // than strand it on the channel (CL-5). The loading state is excluded: the
  // content may still resolve to code and consume the target normally.
  const settledUnconsumable =
    !query.isLoading && (displayError !== null || content === null);
  useEffect(() => {
    if (settledUnconsumable && revealTarget !== null) {
      clearWorkspaceFileRevealTarget(props.viewTabId, node.id);
    }
  }, [settledUnconsumable, revealTarget, props.viewTabId, node.id]);

  const markdownPreviewDisabled =
    content !== null && content.length > MAX_MARKDOWN_PREVIEW_CHARS;
  // A pending line target forces source view so the line is addressable -
  // rendered markdown has none (G5). Purely derived: the child consumes the
  // target right after the scroll (G4), so a markdown file the user had on
  // preview returns to preview once the one-shot reveal completes. Line links
  // are almost always to code files, where source is the only view anyway.
  const effectiveViewMode = computeViewMode(
    revealTarget !== null,
    markdownFile,
    viewMode,
    markdownPreviewDisabled,
  );
  // Preserve scroll (both axes - long lines scroll horizontally) across epic
  // switches and remount, once the file content has loaded.
  const { scrollContainerRef, onScroll } = useNativeDivScrollRestoration(
    node.instanceId,
    content !== null && !query.isLoading,
  );

  const publishFindEnvironment = useCallback((): void => {
    const environment = findEnvironmentRef.current;
    if (environment === null) return;
    findAdapter.updateEnvironment({
      ...environment,
      previewRoot: markdownPreviewRootRef.current,
    });
  }, [findAdapter]);

  const handleMarkdownPreviewRootChange = useCallback(
    (root: HTMLElement | null): void => {
      markdownPreviewRootRef.current = root;
      publishFindEnvironment();
    },
    [publishFindEnvironment],
  );

  useLayoutEffect(() => {
    findEnvironmentRef.current = {
      viewMode: effectiveViewMode,
      content,
      isLoading: query.isLoading,
      displayError,
      truncated,
      previewRoot: markdownPreviewRootRef.current,
      revealSourceMatch,
    };
    publishFindEnvironment();
  }, [
    content,
    displayError,
    effectiveViewMode,
    publishFindEnvironment,
    query.isLoading,
    revealSourceMatch,
    truncated,
  ]);

  return (
    <WorkspaceMarkdownLinkProvider
      tabId={props.viewTabId}
      hostId={node.hostId}
      workspacePath={node.workspacePath}
      filePath={node.filePath}
    >
      <div className="flex h-full min-h-0 flex-col bg-canvas text-canvas-foreground">
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-canvas-border/70 px-3">
          <StartTruncatedText className="min-w-0 flex-1 text-ui-xs text-muted-foreground">
            {node.filePath}
          </StartTruncatedText>
          {truncated ? (
            <span className="shrink-0 text-badge text-muted-foreground">
              Preview truncated
            </span>
          ) : null}
          {markdownFile ? (
            <MarkdownViewModeToggle
              previewDisabled={markdownPreviewDisabled}
              mode={effectiveViewMode}
              onModeChange={setViewMode}
            />
          ) : null}
        </div>
        <div
          ref={scrollContainerRef}
          onScroll={onScroll}
          className={cn(
            "relative min-h-0 flex-1 overflow-auto",
            props.isActive && "selection:bg-primary/25",
          )}
        >
          <WorkspaceFilePreviewContent
            content={content}
            displayError={displayError}
            fileName={node.name}
            isLoading={query.isLoading}
            language={language}
            viewMode={effectiveViewMode}
            viewTabId={props.viewTabId}
            contentId={node.id}
            revealLine={revealTarget?.line ?? null}
            revealNonce={revealTarget?.nonce ?? null}
            sourceFindTarget={sourceFindTarget}
            onMarkdownPreviewRootChange={handleMarkdownPreviewRootChange}
          />
        </div>
      </div>
    </WorkspaceMarkdownLinkProvider>
  );
}

function readFileContent(
  data: { readonly content?: string | null } | undefined,
): string | null {
  return data?.content ?? null;
}

function readFilePayloadError(
  data: { readonly error?: string | null } | undefined,
): string | null {
  return data?.error ?? null;
}

function readFileTruncated(
  data: { readonly truncated?: boolean | null } | undefined,
): boolean {
  return data?.truncated === true;
}

function readFileDisplayError(
  payloadError: string | null,
  isTransportError: boolean,
  error: unknown,
): string | null {
  if (payloadError !== null) return payloadError;
  if (!isTransportError) return null;
  return transportErrorMessage(error);
}

function WorkspaceFilePreviewContent(props: {
  readonly content: string | null;
  readonly displayError: string | null;
  readonly fileName: string;
  readonly isLoading: boolean;
  readonly language: string;
  readonly viewMode: WorkspaceFileViewMode;
  readonly viewTabId: string;
  readonly contentId: string;
  readonly revealLine: number | null;
  readonly revealNonce: number | null;
  readonly sourceFindTarget: WorkspaceFileSourceFindTargetWithNonce | null;
  readonly onMarkdownPreviewRootChange: (root: HTMLElement | null) => void;
}) {
  if (props.isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
        />
      </div>
    );
  }

  if (props.displayError !== null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-ui-sm text-muted-foreground">
        <p>{props.displayError}</p>
        <ReportIssueAction
          context={createReportIssueContext({
            title: "Workspace file could not be read",
            message: "The workspace file preview could not be loaded.",
            code: null,
            source: "Workspace file",
          })}
          presentation="text"
          className={undefined}
        />
      </div>
    );
  }

  if (props.content === null) return null;

  if (props.viewMode === "preview") {
    return (
      <MarkdownFilePreview
        markdown={props.content}
        fileName={props.fileName}
        onRootChange={props.onMarkdownPreviewRootChange}
      />
    );
  }

  return (
    <CodeEditorPreview
      code={props.content}
      language={props.language}
      fileName={props.fileName}
      viewTabId={props.viewTabId}
      contentId={props.contentId}
      revealLine={props.revealLine}
      revealNonce={props.revealNonce}
      findTarget={props.sourceFindTarget}
    />
  );
}

function transportErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return "Couldn't load file preview from the host.";
}

function MarkdownViewModeToggle(props: {
  readonly mode: WorkspaceFileViewMode;
  readonly previewDisabled: boolean;
  readonly onModeChange: (mode: WorkspaceFileViewMode) => void;
}) {
  return (
    <div
      className="flex shrink-0 items-center gap-1"
      role="toolbar"
      aria-label="Markdown view mode"
    >
      {MARKDOWN_VIEW_MODE_OPTIONS.map((option) => {
        const active = props.mode === option.mode;
        const disabled = option.mode === "preview" && props.previewDisabled;
        return (
          <button
            key={option.mode}
            type="button"
            aria-pressed={active}
            disabled={disabled}
            title={
              disabled ? "Preview unavailable - file is too large" : undefined
            }
            className={cn(
              "inline-flex h-6 items-center rounded-[3px] px-1.5 text-ui-xs leading-none font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
              disabled &&
                "cursor-not-allowed opacity-45 hover:text-muted-foreground",
              active && "bg-muted text-foreground",
            )}
            onClick={() => {
              props.onModeChange(option.mode);
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function MarkdownFilePreview(props: {
  readonly markdown: string;
  readonly fileName: string;
  readonly onRootChange: (root: HTMLElement | null) => void;
}) {
  const { fileName, markdown, onRootChange } = props;
  const handleRootChange = useCallback(
    (root: HTMLElement | null): void => {
      onRootChange(root);
    },
    [onRootChange],
  );

  return (
    <section
      ref={handleRootChange}
      className="min-size-full bg-canvas px-6 py-5"
      aria-label={`${fileName} markdown preview`}
    >
      <TraycerMarkdown
        className="mx-auto w-full max-w-4xl text-foreground"
        proseSize="normal"
        components={null}
        remarkPlugins={null}
        rehypePlugins={null}
        quotable={false}
        isStreaming={false}
      >
        {markdown}
      </TraycerMarkdown>
    </section>
  );
}

function CodeEditorPreview(props: {
  readonly code: string;
  readonly language: string;
  readonly fileName: string;
  readonly viewTabId: string;
  readonly contentId: string;
  readonly revealLine: number | null;
  readonly revealNonce: number | null;
  readonly findTarget: WorkspaceFileSourceFindTargetWithNonce | null;
}) {
  const { highlighter, theme, themesVersion } = useShikiHighlighter();
  // Shared MRU-cached highlight path. The `MAX_HIGHLIGHT_CHARS` guard lives
  // inside the hook - a large file falls back to the plain `<pre>` below.
  const highlightedNodes = useThrottledCodeHighlight({
    highlighter,
    theme,
    themesVersion,
    code: props.code,
    language: props.language,
    isStreaming: false,
  });

  const lines = useMemo(() => lineNumbers(props.code), [props.code]);

  const [lineHighlight, setLineHighlight] =
    useState<WorkspaceFileLineHighlight | null>(null);
  const gutterRowRefs = useRef<Array<HTMLDivElement | null>>([]);
  const codeContentRef = useRef<HTMLDivElement | null>(null);

  // Reveal sync (legitimate DOM/external-store sync, not derived state): scroll
  // the targeted line into view, paint a transient highlight band, then CONSUME
  // the channel entry (G4) so a later remount does not re-scroll a stale line.
  // Keyed on the nonce so re-clicking the same line still re-fires before the
  // entry is consumed.
  useEffect(() => {
    if (props.revealLine === null || props.revealNonce === null) return;
    const clampedLine = Math.min(Math.max(props.revealLine, 1), lines.length);
    const row = gutterRowRefs.current[clampedLine - 1];
    if (row !== null) {
      if (typeof row.scrollIntoView === "function") {
        row.scrollIntoView({ block: "center", behavior: "auto" });
      }
      setLineHighlight({
        line: clampedLine,
        top: row.offsetTop,
        height: row.offsetHeight,
      });
    }
    clearWorkspaceFileRevealTarget(props.viewTabId, props.contentId);
  }, [
    props.revealNonce,
    props.revealLine,
    props.viewTabId,
    props.contentId,
    lines.length,
  ]);

  useEffect(() => {
    if (props.findTarget === null) return;
    const clampedLine = Math.min(
      Math.max(props.findTarget.active.line, 1),
      lines.length,
    );
    const row = gutterRowRefs.current[clampedLine - 1];
    if (row === null) return;
    if (typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ block: "center", behavior: "auto" });
    }
  }, [props.findTarget, lines.length]);

  // Paint the matched text spans over the rendered code. Re-runs when the
  // active match changes (new target) and when the rendered DOM swaps between
  // the Shiki output and the plain `<pre>` fallback (`highlightedNodes`), since
  // either invalidates the offset-to-text-node mapping the painter relies on.
  useEffect(() => {
    const root = codeContentRef.current;
    if (root === null) return;
    if (props.findTarget === null) {
      clearSourceFindHighlights(root);
      return;
    }
    paintSourceFindHighlights({
      root,
      matches: props.findTarget.matches,
      activeOffset: props.findTarget.active.offset,
    });
    return () => {
      clearSourceFindHighlights(root);
    };
  }, [props.findTarget, highlightedNodes]);

  return (
    <div className="min-h-full w-max min-w-full bg-canvas font-mono text-code leading-relaxed">
      <div className="relative flex min-h-full items-stretch">
        <div
          aria-hidden
          // No z-index: as a `sticky` (positioned) element the gutter already
          // paints above the non-positioned code on horizontal scroll. Giving it
          // a z-index creates a stacking context that escapes the tile and pokes
          // through the canvas drag interaction shield during a drag.
          className="sticky left-0 select-none border-r border-canvas-border/50 bg-canvas px-3 py-4 text-right text-code text-muted-foreground/55"
        >
          {lines.map((line, index) => (
            <div
              key={line}
              ref={(el) => {
                gutterRowRefs.current[index] = el;
              }}
              data-workspace-file-line={line}
              data-workspace-file-find-active={
                props.findTarget !== null &&
                props.findTarget.active.line === line
                  ? "true"
                  : undefined
              }
              data-workspace-file-find-column={
                props.findTarget !== null &&
                props.findTarget.active.line === line
                  ? props.findTarget.active.column
                  : undefined
              }
              className={cn(
                "tabular-nums",
                (line === lineHighlight?.line ||
                  line === props.findTarget?.active.line) &&
                  "font-medium text-primary",
              )}
            >
              {line}
            </div>
          ))}
        </div>
        {lineHighlight !== null ? (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bg-primary/10"
            style={{ top: lineHighlight.top, height: lineHighlight.height }}
          />
        ) : null}
        <div ref={codeContentRef} className="min-w-0 flex-1 p-4">
          {highlightedNodes !== null ? (
            <div
              className="traycer-md-shiki"
              aria-label={`${props.fileName} source`}
            >
              {highlightedNodes}
            </div>
          ) : (
            <pre className="m-0 whitespace-pre bg-transparent p-0">
              <code className="font-mono text-code text-foreground/85">
                {props.code}
              </code>
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

function computeViewMode(
  hasRevealTarget: boolean,
  markdownFile: boolean,
  viewMode: WorkspaceFileViewMode,
  markdownPreviewDisabled: boolean,
): WorkspaceFileViewMode {
  // A line target always wins: rendered markdown can't address a line.
  if (hasRevealTarget) return "source";
  if (markdownFile && viewMode === "preview" && !markdownPreviewDisabled) {
    return "preview";
  }
  return "source";
}

function lineNumbers(code: string): ReadonlyArray<number> {
  const lineCount = code.length === 0 ? 1 : code.split("\n").length;
  return Array.from({ length: lineCount }, (_, index) => index + 1);
}

function normalizeWorkspaceFileContent(content: string): string {
  return content.replace(/\r\n?/g, "\n");
}

function languageForFileName(fileName: string): string {
  // Extension-less names (`Dockerfile`, `Makefile`) get an exact-name
  // mapping; everything else defers to the shared extension table.
  return (
    EXACT_LANGUAGE_BY_FILE_NAME[fileName.toLowerCase()] ??
    languageFromFilePath(fileName)
  );
}

function isMarkdownFileName(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  const extensionIndex = lower.lastIndexOf(".");
  if (extensionIndex === -1 || extensionIndex === lower.length - 1) {
    return false;
  }
  const extension = lower.slice(extensionIndex + 1);
  return extension === "md" || extension === "markdown";
}

const EXACT_LANGUAGE_BY_FILE_NAME: Readonly<Partial<Record<string, string>>> = {
  dockerfile: "dockerfile",
  makefile: "make",
};
