import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { FileContents, FileDiffContentsLoader } from "@pierre/diffs";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  GitChangedFile,
  GitGetFileDiffResponse,
  HostRpcRegistry,
} from "@traycer/protocol/host";
import {
  DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET,
  WORKSPACE_WRITE_FILE_MAX_CHARS,
} from "@traycer/protocol/host";
import { preloadDiffEditProvider } from "@/components/diff/diff-edit-provider-loader";
import {
  useDiffClickToEdit,
  type DiffClickToEditAdapter,
  type DiffEditActivationRequest,
  type DiffEditActivationResult,
} from "@/components/diff/use-diff-click-to-edit";
import { useGitGetFileContentsQuery } from "@/hooks/git/use-git-get-file-contents-query";
import { useGitGetFileDiffQuery } from "@/hooks/git/use-git-get-file-diff-query";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import { useFileEditSession } from "@/hooks/workspace/use-file-edit-session";
import { hostQueryKeys } from "@/lib/query-keys";
import { gitQueryKeys } from "@/lib/query-keys/git-query-keys";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { reportableErrorToast } from "@/lib/reportable-error-toast";
import {
  fileEditIdentityKey,
  type FileEditRuntimeState,
} from "@/lib/workspace/file-edit-runtime";
import { fileEditRuntimeRegistry } from "@/lib/workspace/file-edit-runtime-registry";
import { useAuthStore } from "@/stores/auth/auth-store";
import { fileDiffLoadFullIdentity } from "./git-diff-tile-shared";

interface GitDiffHydration {
  readonly oldFile: FileContents | null;
  readonly newFile: FileContents;
  readonly worktreeContent: string;
  readonly comparisonIdentity: string;
  readonly pinnedDiff: GitGetFileDiffResponse;
}

export interface GitDiffEditingModel {
  readonly canOfferEdit: boolean;
  readonly active: boolean;
  readonly hydrated: boolean;
  readonly stale: boolean;
  readonly pinnedDiff: GitGetFileDiffResponse | null;
  readonly notice: string | null;
  readonly loading: boolean;
  readonly editAdapter: DiffClickToEditAdapter;
  readonly state: FileEditRuntimeState | null;
  readonly loadDiffFiles: FileDiffContentsLoader;
  readonly retry: () => void;
  readonly keepMine: () => void;
  readonly useDisk: () => void;
}

interface UseGitDiffEditingArgs {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string;
  readonly runningDir: string;
  readonly file: GitChangedFile;
  readonly surfaceId: string;
  /**
   * Raw tab visibility, distinct from `interactionEnabled` below: the latter
   * also goes false for reasons unrelated to the tab being hidden (the diff
   * query pending/erroring, a binary/truncated diff) and must never release
   * an in-progress edit session over those. Only an actually inactive
   * (LRU-hidden) tab should release ownership.
   */
  readonly isActive: boolean;
  readonly interactionEnabled: boolean;
  readonly currentDiff: GitGetFileDiffResponse | null;
  readonly currentComparisonIdentity: string;
  readonly resumeDetachedDraft: boolean;
}

export function useGitDiffEditing(
  args: UseGitDiffEditingArgs,
): GitDiffEditingModel {
  const queryClient = useQueryClient();
  const userId = useAuthStore((state) => state.contextMetadata?.userId ?? null);
  const supportsFileContents = useHostSupportsMethod(
    args.hostId,
    "git.getFileContents",
  );
  const supportsWorkspaceWrite = useHostSupportsMethod(
    args.hostId,
    "workspace.writeFile",
  );
  const canOfferEdit = canOfferGitDiffEdit({
    interactionEnabled: args.interactionEnabled,
    supportsFileContents,
    supportsWorkspaceWrite,
    stage: args.file.stage,
    deleted: args.file.status === "deleted",
  });
  const contentsQuery = useGitGetFileContentsQuery({
    client: args.client,
    hostId: args.hostId,
    runningDir: args.runningDir,
    filePath: args.file.path,
    previousPath: args.file.previousPath,
    stage: args.file.stage,
    enabled: false,
  });
  const [hydration, setHydration] = useState<GitDiffHydration | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [staleIdentity, setStaleIdentity] = useState<string | null>(null);
  const identity = useMemo(
    () => ({
      userId,
      hostId: args.hostId,
      workspacePath: args.runningDir,
      filePath: args.file.path,
    }),
    [args.file.path, args.hostId, args.runningDir, userId],
  );
  const identityKey = useMemo(() => fileEditIdentityKey(identity), [identity]);
  const fileSession = useFileEditSession({
    client: args.client,
    identity,
    diskContent: hydration?.worktreeContent ?? null,
    surfaceId: args.surfaceId,
    autoAttach: false,
  });
  const active = fileSession.state?.ownerSurfaceId === args.surfaceId;

  // An LRU keep-alive tab hides an inactive Git-diff surface instead of
  // unmounting it, and this session always passes `autoAttach: false` above -
  // so the auto-release effect in `useFileEditSession` (gated to attachments
  // it created itself) never re-runs here. Without this, a tab that was
  // actively editing before going inactive would keep owning the runtime
  // forever, and a freshly opened visible tab for the same file would keep
  // hitting `focus-owner` until the hidden tab eventually unmounts.
  useEffect(() => {
    if (args.isActive || !active) return;
    fileSession.runtime?.releaseOwnership(args.surfaceId);
  }, [active, args.isActive, args.surfaceId, fileSession.runtime]);

  const begin = useCallback(
    async (
      request: DiffEditActivationRequest,
    ): Promise<DiffEditActivationResult> => {
      if (!canOfferEdit || args.currentDiff === null) {
        return { kind: "rejected" };
      }
      setNotice(null);
      const [result] = await Promise.all([
        contentsQuery.refetch(),
        request.editorReady,
      ]);
      if (!request.isCurrent()) return { kind: "rejected" };
      const validated = validateGitEditContents(result);
      if (validated.kind === "error") {
        setNotice(validated.message);
        return { kind: "rejected" };
      }
      const contents = validated.contents;
      const cacheKey = fileEditIdentityKey(identity);
      setHydration({
        oldFile:
          contents.oldFile === null
            ? null
            : { ...contents.oldFile, cacheKey: `${cacheKey}:old` },
        newFile: { ...contents.newFile, cacheKey },
        worktreeContent: contents.worktreeFile.contents,
        comparisonIdentity: args.currentComparisonIdentity,
        pinnedDiff: args.currentDiff,
      });
      setStaleIdentity(null);
      return fileSession.activate(request, contents.worktreeFile.contents);
    },
    [
      args.currentComparisonIdentity,
      args.currentDiff,
      canOfferEdit,
      contentsQuery,
      fileSession,
      identity,
    ],
  );

  const beginRef = useRef(begin);
  useLayoutEffect(() => {
    beginRef.current = begin;
  }, [begin]);
  const resumeAttemptRef = useRef<string | null>(null);
  const driftAttemptRef = useRef<string | null>(null);
  const hasCurrentDiff = args.currentDiff !== null;
  useEffect(() => {
    if (
      !args.resumeDetachedDraft ||
      !canOfferEdit ||
      !hasCurrentDiff ||
      active
    ) {
      return;
    }
    const runtime = fileEditRuntimeRegistry.get(identity);
    if (runtime === null) return;
    const state = runtime.store.getState();
    if (
      !state.isDirty ||
      (state.ownerSurfaceId !== null && state.ownerSurfaceId !== args.surfaceId)
    ) {
      return;
    }
    const attemptKey = `${identityKey}:${state.contentRevision}`;
    if (resumeAttemptRef.current === attemptKey) return;
    resumeAttemptRef.current = attemptKey;
    let cancelled = false;
    const request: DiffEditActivationRequest = {
      caret: { lineNumber: 1, character: 0 },
      isCurrent: () => !cancelled,
      editorReady: preloadDiffEditProvider(),
    };
    // `begin` awaits `request.editorReady` (this same preload) inside its own
    // `Promise.all` - unlike the click-driven path, which routes through
    // `useDiffClickToEdit`'s internal `.catch()` into `onActivationError`,
    // nothing awaits this fire-and-forget call. A preload rejection (e.g. a
    // chunk load failure) would otherwise surface as an unhandled promise
    // rejection, and `resumeAttemptRef` would stay pinned to this content
    // revision forever, permanently skipping the automatic resume for it.
    void beginRef.current(request).catch((error: unknown) => {
      if (resumeAttemptRef.current === attemptKey) {
        resumeAttemptRef.current = null;
      }
      if (!cancelled) {
        reportableErrorToast(
          "Couldn’t resume editing this diff.",
          undefined,
          createReportIssueContext({
            title: "Could not resume editing this diff",
            message: error instanceof Error ? error.message : null,
            code: null,
            source: "Git diff edit",
          }),
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, [
    active,
    args.resumeDetachedDraft,
    args.surfaceId,
    canOfferEdit,
    hasCurrentDiff,
    identity,
    identityKey,
  ]);

  useEffect(() => {
    if (
      !active ||
      hydration === null ||
      hydration.comparisonIdentity === args.currentComparisonIdentity ||
      // `contentsQuery` (a TanStack Query result) is not referentially
      // stable across renders, so this effect can re-run many times before
      // the refetch below ever resolves and marks `hydration.comparisonIdentity`
      // caught up. Without this synchronous guard, each of those re-runs
      // would start another overlapping `git.getFileContents` RPC for the
      // same stale identity - mirrors `resumeAttemptRef` above.
      driftAttemptRef.current === args.currentComparisonIdentity
    ) {
      return;
    }
    const attemptIdentity = args.currentComparisonIdentity;
    driftAttemptRef.current = attemptIdentity;
    void contentsQuery
      .refetch()
      .then((result) => {
        // A ref-based check, not a `cancelled` closure torn down by effect
        // cleanup: `contentsQuery` changing (e.g. its own `isFetching` flip
        // while THIS refetch is in flight) re-runs this effect and would tear
        // down a closure-scoped flag long before the request resolves,
        // discarding a still-relevant result. `driftAttemptRef` only moves
        // when a genuinely different comparison identity supersedes this one.
        if (driftAttemptRef.current !== attemptIdentity) return;
        // A transport failure (`result.error`, the same field
        // `validateGitEditContents` below checks) or a payload-level error
        // (RPC succeeded but reported one) means this comparison never
        // actually ran - `worktreeFile` is absent either way. Treating that
        // the same as "checked, content differs" would flag a
        // merely-unreachable host as genuine worktree drift. Leave the ref
        // unset (not "checked") so the next render - `contentsQuery` is not
        // referentially stable, so there always is one - retries the same
        // identity instead of treating a failed check as a completed one.
        if (result.error !== null || (result.data?.error ?? null) !== null) {
          driftAttemptRef.current = null;
          return;
        }
        const latestContent = result.data?.worktreeFile?.contents;
        const matchesBaseline =
          latestContent !== undefined &&
          latestContent ===
            fileSession.runtime?.store.getState().baselineContent;
        // Mark this comparison identity checked either way. Leaving it unmarked
        // on a genuine mismatch would keep `hydration.comparisonIdentity` stale
        // forever, and since this effect's own `refetch()` changes `contentsQuery`
        // identity, that would re-fire this effect (and re-hit the host) on
        // every render for as long as the file stays flagged stale.
        setHydration((current) =>
          current === null
            ? null
            : { ...current, comparisonIdentity: attemptIdentity },
        );
        setStaleIdentity(matchesBaseline ? null : attemptIdentity);
      })
      .catch(() => {
        if (driftAttemptRef.current === attemptIdentity) {
          driftAttemptRef.current = null;
        }
      });
  }, [
    active,
    args.currentComparisonIdentity,
    contentsQuery,
    fileSession.runtime,
    hydration,
  ]);

  const invalidatedSaveRef = useRef<number | null>(null);
  useEffect(() => {
    const savedAt = fileSession.state?.lastSavedAt ?? null;
    if (savedAt === null || invalidatedSaveRef.current === savedAt) return;
    invalidatedSaveRef.current = savedAt;
    void Promise.all([
      queryClient.invalidateQueries({
        predicate: (query) =>
          gitQueryKeys.matchFileDiff(
            query.queryKey,
            args.hostId,
            args.runningDir,
            new Set([args.file.path]),
          ),
      }),
      queryClient.invalidateQueries({
        queryKey: hostQueryKeys.methodScope(args.hostId, "git.getFileContents"),
      }),
      queryClient.invalidateQueries({
        queryKey: hostQueryKeys.methodScope(args.hostId, "workspace.readFile"),
      }),
    ]);
  }, [
    args.file.path,
    args.hostId,
    args.runningDir,
    fileSession.state?.lastSavedAt,
    queryClient,
  ]);

  const editAdapter = useDiffClickToEdit({
    surfaceId: args.surfaceId,
    enabled: canOfferEdit,
    active,
    onActivate: begin,
    onActivationError: () => {
      reportableErrorToast(
        "Couldn’t start editing this diff.",
        undefined,
        createReportIssueContext({
          title: "Could not start editing this diff",
          message: null,
          code: null,
          source: "Git diff edit",
        }),
      );
    },
    onChange: fileSession.setDraft,
    onBlur: fileSession.flush,
    onSaveShortcut: fileSession.flush,
  });

  const hydratedOldFile = hydration?.oldFile;
  const hydratedNewFile = hydration?.newFile;
  const editRuntime = fileSession.runtime;
  const loadDiffFiles = useCallback<FileDiffContentsLoader>(
    (fileDiff) => {
      if (hydratedNewFile === undefined) {
        return Promise.reject(
          new Error("The edit session ended before the diff was hydrated."),
        );
      }
      const newFile = {
        ...hydratedNewFile,
        contents:
          editRuntime?.store.getState().draftContent ??
          hydratedNewFile.contents,
      };
      if (fileDiff.type === "rename-pure") {
        return Promise.resolve({ oldFile: null, newFile });
      }
      return Promise.resolve({ oldFile: hydratedOldFile ?? null, newFile });
    },
    [editRuntime, hydratedNewFile, hydratedOldFile],
  );

  const conflictDiskContent = fileSession.state?.conflict?.diskContent ?? null;
  const readLatestDisk = useCallback(async (): Promise<string> => {
    if (conflictDiskContent !== null) return conflictDiskContent;
    const result = await contentsQuery.refetch();
    if (result.error !== null)
      throw new Error(gitEditErrorMessage(result.error));
    const contents = result.data;
    if (contents?.error !== null && contents?.error !== undefined) {
      throw new Error(contents.error);
    }
    const diskContent = contents?.worktreeFile?.contents;
    if (diskContent === undefined) {
      throw new Error(
        "Couldn't load the latest worktree file. Your recovered draft was kept.",
      );
    }
    return diskContent;
  }, [conflictDiskContent, contentsQuery]);
  const keepMine = useCallback((): void => {
    void readLatestDisk()
      .then(fileSession.resolveKeepMine)
      .catch((error: unknown) => {
        fileSession.reportConflictResolutionError(
          gitConflictResolutionErrorMessage(error),
        );
      });
  }, [fileSession, readLatestDisk]);
  const useDisk = useCallback((): void => {
    void readLatestDisk()
      .then(fileSession.resolveUseDisk)
      .catch((error: unknown) => {
        fileSession.reportConflictResolutionError(
          gitConflictResolutionErrorMessage(error),
        );
      });
  }, [fileSession, readLatestDisk]);

  return {
    canOfferEdit,
    active,
    hydrated: hydration !== null,
    stale: active && staleIdentity === args.currentComparisonIdentity,
    pinnedDiff: hydration?.pinnedDiff ?? null,
    notice,
    loading: contentsQuery.isFetching,
    editAdapter,
    state: fileSession.state,
    loadDiffFiles,
    retry: fileSession.retry,
    keepMine,
    useDisk,
  };
}

export interface EditableGitDiffSurfaceModel {
  readonly editing: GitDiffEditingModel;
  readonly displayedDiff: GitGetFileDiffResponse | undefined;
  readonly displayedDiffPending: boolean;
  readonly displayedDiffError: HostRpcError | null;
  readonly loadFull: () => void;
}

/** Canonical query, pinning, and edit lifecycle shared by file and bundle views. */
export function useEditableGitDiffSurface(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string;
  readonly runningDir: string;
  readonly file: GitChangedFile;
  readonly headSha: string;
  readonly ignoreWhitespace: boolean;
  readonly surfaceId: string;
  readonly isActive: boolean;
  readonly queryEnabled: boolean;
  readonly resumeDetachedDraft: boolean;
}): EditableGitDiffSurfaceModel {
  const diffIdentity = fileDiffLoadFullIdentity({
    runningDir: args.runningDir,
    filePath: args.file.path,
    previousPath: args.file.previousPath,
    stage: args.file.stage,
    headSha: args.headSha,
    stagedOid: args.file.stagedOid,
    worktreeOid: args.file.worktreeOid,
    ignoreWhitespace: args.ignoreWhitespace,
  });
  const [fullDiffIdentity, setFullDiffIdentity] = useState<string | null>(null);
  const diffQuery = useGitGetFileDiffQuery({
    hostId: args.hostId,
    runningDir: args.runningDir,
    filePath: args.file.path,
    previousPath: args.file.previousPath,
    stage: args.file.stage,
    headSha: args.headSha,
    stagedOid: args.file.stagedOid,
    worktreeOid: args.file.worktreeOid,
    ignoreWhitespace: args.ignoreWhitespace,
    byteBudget:
      fullDiffIdentity === diffIdentity
        ? null
        : DEFAULT_GIT_FILE_DIFF_BYTE_BUDGET,
    enabled: args.queryEnabled,
  });
  const editing = useGitDiffEditing({
    client: args.client,
    hostId: args.hostId,
    runningDir: args.runningDir,
    file: args.file,
    surfaceId: args.surfaceId,
    isActive: args.isActive,
    interactionEnabled: isGitDiffInteractionEnabled({
      isActive: args.isActive,
      fileIsBinary: args.file.isBinary,
      hasDiff: diffQuery.data !== undefined,
      hasError: diffQuery.error !== null,
      diffIsBinary: diffQuery.data?.isBinary === true,
      diffIsTruncated: diffQuery.data?.isTruncated === true,
    }),
    currentDiff: diffQuery.data ?? null,
    currentComparisonIdentity: diffIdentity,
    resumeDetachedDraft: args.resumeDetachedDraft,
  });
  const displayedDiff = displayedGitDiff(
    editing.active,
    editing.pinnedDiff,
    diffQuery.data,
  );
  const loadFull = useCallback((): void => {
    setFullDiffIdentity(diffIdentity);
  }, [diffIdentity]);

  return {
    editing,
    displayedDiff,
    displayedDiffPending: displayedDiff === undefined && diffQuery.isPending,
    displayedDiffError: displayedDiff === undefined ? diffQuery.error : null,
    loadFull,
  };
}

export function displayedGitDiff(
  active: boolean,
  pinnedDiff: GitGetFileDiffResponse | null,
  liveDiff: GitGetFileDiffResponse | undefined,
): GitGetFileDiffResponse | undefined {
  if (active && pinnedDiff !== null) return pinnedDiff;
  return liveDiff;
}

export function isGitDiffInteractionEnabled(args: {
  readonly isActive: boolean;
  readonly fileIsBinary: boolean;
  readonly hasDiff: boolean;
  readonly hasError: boolean;
  readonly diffIsBinary: boolean;
  readonly diffIsTruncated: boolean;
}): boolean {
  return (
    args.isActive &&
    !args.fileIsBinary &&
    args.hasDiff &&
    !args.hasError &&
    !args.diffIsBinary &&
    !args.diffIsTruncated
  );
}

function canOfferGitDiffEdit(args: {
  readonly interactionEnabled: boolean;
  readonly supportsFileContents: boolean;
  readonly supportsWorkspaceWrite: boolean;
  readonly stage: GitChangedFile["stage"];
  readonly deleted: boolean;
}): boolean {
  return (
    args.interactionEnabled &&
    args.supportsFileContents &&
    args.supportsWorkspaceWrite &&
    (args.stage === "unstaged" || args.stage === "untracked") &&
    !args.deleted
  );
}

function gitEditErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return "Couldn't load the file contents for editing.";
}

function gitConflictResolutionErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Couldn't load the latest worktree file. Your recovered draft was kept.";
}

interface GitEditContentsPayload {
  readonly oldFile: FileContents | null;
  readonly newFile: FileContents | null;
  readonly worktreeFile: FileContents | null;
  readonly error: string | null;
}

type ValidatedGitEditContents =
  | { readonly kind: "ready"; readonly contents: GitEditReadyContents }
  | { readonly kind: "error"; readonly message: string };

interface GitEditReadyContents {
  readonly oldFile: FileContents | null;
  readonly newFile: FileContents;
  readonly worktreeFile: FileContents;
}

function validateGitEditContents(result: {
  readonly error: unknown;
  readonly data: GitEditContentsPayload | undefined;
}): ValidatedGitEditContents {
  if (result.error !== null) {
    return { kind: "error", message: gitEditErrorMessage(result.error) };
  }
  const contents = result.data;
  if (contents === undefined) {
    return {
      kind: "error",
      message: "Couldn't load the file contents for editing.",
    };
  }
  if (contents.error !== null) {
    return { kind: "error", message: contents.error };
  }
  if (contents.newFile === null || contents.worktreeFile === null) {
    return {
      kind: "error",
      message: "This change has no editable worktree file.",
    };
  }
  if (contents.newFile.contents !== contents.worktreeFile.contents) {
    return {
      kind: "error",
      message:
        "The worktree has changed beyond this diff. Refresh before editing.",
    };
  }
  if (contents.worktreeFile.contents.length > WORKSPACE_WRITE_FILE_MAX_CHARS) {
    return {
      kind: "error",
      message: "This file is too large to edit.",
    };
  }
  return {
    kind: "ready",
    contents: {
      oldFile: contents.oldFile,
      newFile: contents.newFile,
      worktreeFile: contents.worktreeFile,
    },
  };
}
