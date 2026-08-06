import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { StartTruncatedText } from "@/components/ui/start-truncated-text";
import { useWorkspaceReadFile } from "@/hooks/workspace/use-read-file-query";
import { useFileEditSession } from "@/hooks/workspace/use-file-edit-session";
import { fileEditRuntimeRegistry } from "@/lib/workspace/file-edit-runtime-registry";
import type { FileEditRuntime } from "@/lib/workspace/file-edit-runtime";
import { languageFromFilePath } from "@/lib/file-change-diff-hunks";
import {
  createReportIssueContext,
  type ReportIssueContext,
} from "@/lib/report-issue-context";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { cn } from "@/lib/utils";
import { TraycerMarkdown } from "@/markdown";
import { useRegisterTileFindAdapter } from "@/components/epic-canvas/tile-find/tile-find-adapter-context";
import {
  createWorkspaceFileFindAdapter,
  type WorkspaceFileFindEnvironment,
  type WorkspaceFileSourceFindTarget,
} from "@/components/epic-canvas/workspace-file/workspace-file-find-adapter";
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
  type ReactNode,
} from "react";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import { useHostReachability } from "@/hooks/agent/use-host-reachability";
import { useNativeDivScrollRestoration } from "@/hooks/scroll/use-native-div-scroll-restoration";
import { WorkspaceFileDeadTileBanner } from "./dead-tile-banner";
import { WorkspaceMarkdownLinkProvider } from "@/components/epic-canvas/workspace-file/workspace-markdown-link-provider";
import { WorkspaceFileRenderer } from "@/components/epic-canvas/workspace-file/workspace-file-renderer";
import { FileAutosaveStatus } from "@/components/diff/file-autosave-status";
import {
  useDiffClickToEdit,
  type DiffClickToEditAdapter,
} from "@/components/diff/use-diff-click-to-edit";
import type { DiffContentFrameFileIdentity } from "@/components/diff/diff-content-primitive";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { hostQueryKeys } from "@/lib/query-keys";
import { useQueryClient } from "@tanstack/react-query";
import { reportableErrorToast } from "@/lib/reportable-error-toast";
import { useAuthStore } from "@/stores/auth/auth-store";
const MAX_MARKDOWN_PREVIEW_CHARS = 100_000;

type WorkspaceFileViewMode = "source" | "preview";

interface WorkspaceFileSourceFindTargetWithNonce extends WorkspaceFileSourceFindTarget {
  readonly nonce: number;
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
 * Reads and writes resolve through the per-tab host client. An unreachable
 * host cannot service the tile, so the outer gate keeps the live renderer and
 * its edit mutation unmounted until that same host is reachable again.
 */
export function WorkspaceFileTile(props: {
  readonly node: WorkspaceFileRef;
  readonly viewTabId: string;
  readonly isActive: boolean;
}) {
  const { node } = props;
  const tabHostId = useTabHostId();
  const reachability = useHostReachability(tabHostId);
  // Read the target here (not just in the live body) so the dead-tile / inactive
  // states - which return BEFORE the live preview mounts - can still evict a
  // stranded entry. Scoped to this tab so a click meant for one tab's preview
  // doesn't move another tab's preview of the same file (CL-6).
  const revealTarget = useWorkspaceFileRevealTarget(props.viewTabId, node.id);
  const isDeadTile = reachability.status === "unreachable";

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
  const tabHostId = useTabHostId();
  const tabHostClient = useTabHostClient();
  const supportsWrite = useHostSupportsMethod(tabHostId, "workspace.writeFile");
  const userId = useAuthStore((state) => state.contextMetadata?.userId ?? null);
  const queryClient = useQueryClient();
  const query = useWorkspaceReadFile(
    tabHostClient,
    node.workspacePath,
    node.filePath,
  );
  const rawContent = readFileContent(query.data);
  const payloadError = readFilePayloadError(query.data);
  const displayError = readFileDisplayError(
    payloadError,
    query.isError,
    query.error,
  );
  // The current cached payload reporting an error (e.g. a permission-denied
  // read) can still carry `content: ""` - empty-origin editing made "" a
  // meaningful, editable value, so it can no longer stand in for "no
  // content" the way `null` does. A payload error must never be treated as
  // valid disk content to seed or reconcile editing from; a transport-only
  // failure (query.isError with query.data retained from the last good
  // fetch) is unaffected, since that retained payload's own error is null.
  const validatedContent = payloadError === null ? rawContent : null;
  const reportContext = readFileReportContext(
    payloadError,
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
  const editIdentity = useMemo(
    () => ({
      userId,
      hostId: tabHostId,
      workspacePath: node.workspacePath,
      filePath: node.filePath,
    }),
    [node.filePath, node.workspacePath, tabHostId, userId],
  );
  const editSurfaceId = `${props.viewTabId}:workspace-file:${node.instanceId}`;
  // A later payload error must never yank ownership away from a surface that
  // already owns this file's runtime (an active or dirty draft) - only gate
  // the FIRST attach on payload validity. Read the registry directly (not
  // `editSession.state` below, computed from THIS same decision) to break
  // the circularity; `editSession`'s own subscription already guarantees a
  // re-render whenever this ownership changes, so this read is never stale.
  const editingProtected = isWorkspaceFileEditingProtected(
    fileEditRuntimeRegistry.get(editIdentity),
    editSurfaceId,
  );
  const editEnabled = isWorkspaceFileEditEnabled({
    isActive: props.isActive,
    hasContent: hasEditableWorkspaceFileContent(
      validatedContent,
      editingProtected,
    ),
    truncated,
    supportsWrite,
  });
  const editSession = useFileEditSession({
    client: tabHostClient,
    identity: editIdentity,
    diskContent: validatedContent,
    surfaceId: editSurfaceId,
    autoAttach: editEnabled,
  });
  const editing = editSession.state?.ownerSurfaceId === editSurfaceId;
  const editAdapter = useDiffClickToEdit({
    surfaceId: editSurfaceId,
    enabled: editEnabled,
    active: editing,
    onActivate: async (request) => {
      await request.editorReady;
      return editSession.activate(request, validatedContent ?? "");
    },
    onActivationError: () => {
      reportableErrorToast(
        "Couldn’t start editing this file.",
        undefined,
        createReportIssueContext({
          title: "Could not start editing this file",
          message: null,
          code: null,
          source: "Workspace file edit",
        }),
      );
    },
    onChange: editSession.setDraft,
    onBlur: editSession.flush,
    onSaveShortcut: editSession.flush,
  });
  // Stays byte-exact raw: this seeds the Diffs editor's own live buffer once
  // it mounts editable, and onChange later submits that buffer's full
  // content back for autosave. Normalizing it (or the fallback
  // `validatedContent`) here would make the very first edit silently rewrite
  // every CRLF/lone-CR line ending in the file. Only a read-only projection
  // (markdown preview, find) may normalize - never what's rendered/seeded.
  const renderedContent = editSession.state?.draftContent ?? validatedContent;
  // Find offsets are computed against this normalized copy so CRLF/lone-CR
  // don't throw off the match position, but it is never rendered or fed to
  // Diffs - see `renderedContent` above. Memoized: `normalizeWorkspaceFileContent`
  // scans the whole file with two regexes, and `renderedContent` changes on
  // every keystroke while actively editing.
  const findContent = useMemo(
    () =>
      renderedContent === null
        ? null
        : normalizeWorkspaceFileContent(renderedContent),
    [renderedContent],
  );
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
  // from - a host/payload error, or an empty/failed read (`renderedContent === null`).
  // Neither mounts the Diffs source renderer, so evict any pending target here rather
  // than strand it on the channel (CL-5). The loading state is excluded: the
  // content may still resolve to code and consume the target normally.
  const settledUnconsumable = isSettledUnconsumableWorkspaceFile({
    isLoading: query.isLoading,
    hasError: displayError !== null,
    hasContent: renderedContent !== null,
  });
  useEffect(() => {
    if (settledUnconsumable && revealTarget !== null) {
      clearWorkspaceFileRevealTarget(props.viewTabId, node.id);
    }
  }, [settledUnconsumable, revealTarget, props.viewTabId, node.id]);

  const markdownPreviewDisabled =
    renderedContent !== null &&
    renderedContent.length > MAX_MARKDOWN_PREVIEW_CHARS;
  // A pending line target forces source view so the line is addressable -
  // rendered markdown has none (G5). Purely derived: the child consumes the
  // target right after the scroll (G4), so a markdown file the user had on
  // preview returns to preview once the one-shot reveal completes. Line links
  // are almost always to code files, where source is the only view anyway.
  const effectiveViewMode = editing
    ? "source"
    : computeViewMode(
        revealTarget !== null,
        markdownFile,
        viewMode,
        markdownPreviewDisabled,
      );
  // Preserve scroll (both axes - long lines scroll horizontally) across epic
  // switches and remount, once the file content has loaded.
  const { scrollContainerRef, onScroll } = useNativeDivScrollRestoration(
    node.instanceId,
    renderedContent !== null && !query.isLoading,
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

  const invalidatedSaveRef = useRef<number | null>(null);
  useEffect(() => {
    const savedAt = editSession.state?.lastSavedAt ?? null;
    if (savedAt === null || invalidatedSaveRef.current === savedAt) return;
    invalidatedSaveRef.current = savedAt;
    void queryClient.invalidateQueries({
      queryKey: hostQueryKeys.methodScope(tabHostId, "workspace.readFile"),
    });
  }, [editSession.state?.lastSavedAt, queryClient, tabHostId]);

  // This tile is kept alive (not remounted) across an inactive/active toggle,
  // so `refetchOnMount` never re-fires when the user switches back to it -
  // only the false→true edge should force one fresh read past `staleTime`.
  const wasActiveRef = useRef(props.isActive);
  useEffect(() => {
    const wasActive = wasActiveRef.current;
    wasActiveRef.current = props.isActive;
    if (props.isActive && !wasActive) {
      void query.refetch();
    }
  }, [props.isActive, query]);

  const readLatestDiskContent = useCallback(async (): Promise<string> => {
    const conflictDiskContent = editSession.state?.conflict?.diskContent;
    if (conflictDiskContent !== null && conflictDiskContent !== undefined) {
      return conflictDiskContent;
    }
    const refreshed = await query.refetch();
    if (refreshed.error !== null) {
      throw new Error(transportErrorMessage(refreshed.error));
    }
    const payloadError = readFilePayloadError(refreshed.data);
    if (payloadError !== null) throw new Error(payloadError);
    if (readFileTruncated(refreshed.data)) {
      throw new Error(
        "The latest file is too large to load completely. Your recovered draft was kept.",
      );
    }
    const refreshedContent = readFileContent(refreshed.data);
    if (refreshedContent === null) {
      throw new Error(
        "Couldn't load the latest file from disk. Your recovered draft was kept.",
      );
    }
    return refreshedContent;
  }, [editSession.state?.conflict?.diskContent, query]);
  const handleKeepMine = useCallback(async (): Promise<void> => {
    try {
      await editSession.resolveKeepMine(await readLatestDiskContent());
    } catch (error) {
      editSession.reportConflictResolutionError(
        conflictResolutionErrorMessage(error),
      );
    }
  }, [editSession, readLatestDiskContent]);
  const handleUseDisk = useCallback(async (): Promise<void> => {
    try {
      await editSession.resolveUseDisk(await readLatestDiskContent());
    } catch (error) {
      editSession.reportConflictResolutionError(
        conflictResolutionErrorMessage(error),
      );
    }
  }, [editSession, readLatestDiskContent]);
  const handleRevealConsumed = useCallback((): void => {
    clearWorkspaceFileRevealTarget(props.viewTabId, node.id);
  }, [node.id, props.viewTabId]);

  useLayoutEffect(() => {
    findEnvironmentRef.current = {
      viewMode: effectiveViewMode,
      content: findContent,
      isLoading: query.isLoading,
      displayError,
      truncated,
      previewRoot: markdownPreviewRootRef.current,
      revealSourceMatch,
    };
    publishFindEnvironment();
  }, [
    displayError,
    effectiveViewMode,
    findContent,
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
        <WorkspaceFileToolbar
          filePath={node.filePath}
          truncated={truncated}
          markdownFile={markdownFile}
          markdownPreviewDisabled={markdownPreviewDisabled}
          viewMode={effectiveViewMode}
          editing={editing}
          onViewModeChange={setViewMode}
          status={
            <FileAutosaveStatus
              appearance="pill"
              state={editSession.state}
              onRetry={editSession.retry}
              onKeepMine={() => {
                void handleKeepMine();
              }}
              onUseDisk={() => {
                void handleUseDisk();
              }}
            />
          }
        />
        <div
          ref={scrollContainerRef}
          onScroll={onScroll}
          // Ctrl/Cmd+A selects the file body, not the whole window (#592).
          data-selection-root=""
          className={cn(
            "relative min-h-0 flex-1 overflow-auto",
            props.isActive && "selection:bg-primary/25",
          )}
        >
          <WorkspaceFilePreviewContent
            content={renderedContent}
            displayError={displayError}
            reportContext={reportContext}
            fileName={node.name}
            isLoading={query.isLoading}
            language={language}
            viewMode={effectiveViewMode}
            revealLine={revealTarget?.line ?? null}
            revealNonce={revealTarget?.nonce ?? null}
            sourceFindTarget={sourceFindTarget}
            editing={editing}
            editAdapter={editAdapter}
            fileIdentity={{
              findFilePath: node.filePath,
              bundleFindFileId: node.id,
            }}
            onMarkdownPreviewRootChange={handleMarkdownPreviewRootChange}
            onRevealConsumed={handleRevealConsumed}
          />
        </div>
      </div>
    </WorkspaceMarkdownLinkProvider>
  );
}

function WorkspaceFileToolbar(props: {
  readonly filePath: string;
  readonly truncated: boolean;
  readonly markdownFile: boolean;
  readonly markdownPreviewDisabled: boolean;
  readonly viewMode: WorkspaceFileViewMode;
  readonly editing: boolean;
  readonly onViewModeChange: (mode: WorkspaceFileViewMode) => void;
  readonly status: ReactNode;
}) {
  return (
    <div
      className="flex h-9 shrink-0 items-center gap-2 border-b border-canvas-border/70 px-3"
      data-testid="workspace-file-toolbar"
    >
      <StartTruncatedText className="min-w-0 flex-1 text-ui-xs text-muted-foreground">
        {props.filePath}
      </StartTruncatedText>
      {props.truncated ? (
        <span className="shrink-0 text-badge text-muted-foreground">
          Preview truncated
        </span>
      ) : null}
      {props.status}
      {props.markdownFile && !props.editing ? (
        <MarkdownViewModeToggle
          previewDisabled={props.markdownPreviewDisabled}
          mode={props.viewMode}
          onModeChange={props.onViewModeChange}
        />
      ) : null}
    </div>
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
  readonly reportContext: ReportIssueContext;
  readonly fileName: string;
  readonly isLoading: boolean;
  readonly language: string;
  readonly viewMode: WorkspaceFileViewMode;
  readonly revealLine: number | null;
  readonly revealNonce: number | null;
  readonly sourceFindTarget: WorkspaceFileSourceFindTargetWithNonce | null;
  readonly editing: boolean;
  readonly editAdapter: DiffClickToEditAdapter;
  readonly fileIdentity: DiffContentFrameFileIdentity | null;
  readonly onMarkdownPreviewRootChange: (root: HTMLElement | null) => void;
  readonly onRevealConsumed: () => void;
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

  // A background refetch (e.g. the post-save `workspace.readFile`
  // invalidation) can fail while TanStack Query still holds the last good
  // `content` and only flips `isError`. Content availability wins over that
  // stale error: an active editor keeps the runtime's ownership regardless,
  // so hiding it behind an error screen here would strand the tile
  // unrenderable while another surface for the same file still gets routed
  // to this invisible owner via `focus-owner`. A genuine load failure never
  // has content to fall back on, so this never masks it.
  if (props.content === null) {
    if (props.displayError !== null) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-ui-sm text-muted-foreground">
          <p>{props.displayError}</p>
          <ReportIssueAction
            context={props.reportContext}
            presentation="text"
            className={undefined}
          />
        </div>
      );
    }
    return null;
  }

  if (props.viewMode === "preview") {
    return (
      <MarkdownFilePreview
        // `props.content` is raw (see workspace-file-tile.tsx's
        // renderedContent) so the Diffs editor never receives normalized
        // text; the read-only markdown renderer still gets a normalized
        // copy, matching its prior behavior.
        markdown={normalizeWorkspaceFileContent(props.content)}
        fileName={props.fileName}
        onRootChange={props.onMarkdownPreviewRootChange}
      />
    );
  }

  return (
    <WorkspaceFileRenderer
      content={props.content}
      language={props.language}
      fileName={props.fileName}
      editing={props.editing}
      editAdapter={props.editAdapter}
      revealLine={props.revealLine}
      revealNonce={props.revealNonce}
      findTarget={props.sourceFindTarget}
      fileIdentity={props.fileIdentity}
      onRevealConsumed={props.onRevealConsumed}
    />
  );
}

function transportErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return "Couldn't load file preview from the host.";
}

/**
 * The preview fails in two unrelated ways, and the filed report has to say
 * which: a payload error means the host answered and named a file-level
 * problem, while a transport error means the request never reached a verdict
 * at all (host unreachable, session rejected, method unsupported). Reporting
 * the second as "could not be read" sent one field report's triage hunting an
 * `ENOENT` that never existed - the failure was an auth-plane outage.
 *
 * Neither arm may carry error text: `createReportIssueContext` deliberately
 * does not redact, the payload string can embed the user's absolute path, and
 * `HostRpcError.message` can carry host-supplied detail. Only fixed copy and
 * the stable wire code cross into a public issue.
 */
function readFileReportContext(
  payloadError: string | null,
  isTransportError: boolean,
  error: unknown,
): ReportIssueContext {
  if (payloadError === null && isTransportError) {
    return createReportIssueContext({
      title: "Workspace file preview failed to load from the host",
      message:
        "The app could not reach the Traycer host to load the file preview.",
      // Narrowed, never asserted: TanStack's error generic is an unchecked
      // cast, so a bare `Error` can occupy this channel.
      code: error instanceof HostRpcError ? error.code : null,
      source: "Host",
    });
  }
  return createReportIssueContext({
    title: "Workspace file could not be read",
    message: "The workspace file preview could not be loaded.",
    code: null,
    source: "Workspace file",
  });
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
          <TooltipWrapper
            key={option.mode}
            label={
              disabled ? "Preview unavailable - file is too large" : undefined
            }
            side="top"
            sideOffset={undefined}
            align={undefined}
          >
            <span className="inline-flex">
              <button
                type="button"
                aria-pressed={active}
                disabled={disabled}
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
            </span>
          </TooltipWrapper>
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

function normalizeWorkspaceFileContent(content: string): string {
  return content.replace(/\r\n?/g, "\n");
}

function isWorkspaceFileEditEnabled(args: {
  readonly isActive: boolean;
  readonly hasContent: boolean;
  readonly truncated: boolean;
  readonly supportsWrite: boolean;
}): boolean {
  return (
    args.isActive && args.hasContent && !args.truncated && args.supportsWrite
  );
}

function isWorkspaceFileEditingProtected(
  runtime: FileEditRuntime | null,
  surfaceId: string,
): boolean {
  return runtime?.store.getState().ownerSurfaceId === surfaceId;
}

function hasEditableWorkspaceFileContent(
  validatedContent: string | null,
  editingProtected: boolean,
): boolean {
  return validatedContent !== null || editingProtected;
}

function isSettledUnconsumableWorkspaceFile(args: {
  readonly isLoading: boolean;
  readonly hasError: boolean;
  readonly hasContent: boolean;
}): boolean {
  return !args.isLoading && (args.hasError || !args.hasContent);
}

function conflictResolutionErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Couldn't load the latest file from disk. Your recovered draft was kept.";
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
