import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { FileContents } from "@pierre/diffs";
import type { EditorOptions } from "@pierre/diffs/edit";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
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
  type FileEditRuntime,
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

interface EditSeed {
  readonly hydration: GitDiffHydration;
  /** Whether this seed was captured while the runtime reported `"conflict"`. */
  readonly conflicted: boolean;
  readonly content: string;
}

/**
 * Pure decision for the render-phase `editSeed` state adjustment: whether
 * `editRuntime`'s current draft should be captured as the frozen seed for
 * this `hydration` cycle. `null` means no capture is due yet (already
 * captured for this cycle/conflict state, or the runtime hasn't attached
 * yet).
 *
 * A `"conflict"` runtime (recovered draft built on a disk baseline this
 * hydration cycle's fresh content no longer matches - e.g. an external
 * reset) must NOT have its draft fed into the structural diff model: the
 * hunks in `hydration.pinnedDiff` were parsed against the FRESH content, so
 * pairing them with stale draft text produces an internally inconsistent
 * model that crashes the Diffs renderer (a "trailing context mismatch").
 * Seed from the fresh content instead in that case - the draft itself is
 * untouched in `editRuntime.store`, so `keepMine`/`useDisk` can still act on
 * it, and re-capturing whenever `conflicted` flips (not just when
 * `hydration` changes) picks the resolved draft back up afterward instead of
 * leaving the editor stuck showing the fresh content post-resolution.
 */
function computeEditSeedCapture(
  hydration: GitDiffHydration | null,
  editRuntime: FileEditRuntime | null,
  editSeed: EditSeed | null,
): EditSeed | null {
  if (hydration === null || editRuntime === null) return null;
  const state = editRuntime.store.getState();
  const conflicted = state.status === "conflict";
  if (
    editSeed !== null &&
    editSeed.hydration === hydration &&
    editSeed.conflicted === conflicted
  ) {
    return null;
  }
  const content = conflicted ? hydration.newFile.contents : state.draftContent;
  return { hydration, conflicted, content };
}

/** Exponential backoff for the drift-comparison retry, capped at 30s. */
export const DRIFT_RETRY_BASE_DELAY_MS = 2_000;
export const DRIFT_RETRY_MAX_DELAY_MS = 30_000;

/**
 * Full baseline file contents for the active edit session, stable for as
 * long as `hydration` doesn't change. Passed to `DiffContentPrimitive` so it
 * can hydrate the parsed diff synchronously instead of relying on
 * `@pierre/diffs`' own async (and single-attempt) `loadDiffFiles` path.
 */
export interface EditableDiffFiles {
  readonly oldFile: FileContents | null;
  readonly newFile: FileContents;
}

/** The `editSession` prop shape `DiffContentPrimitive`/`FileDiffContent` expect. */
export interface GitDiffEditSession {
  readonly editorOptions: EditorOptions<undefined>;
  readonly oldFile: FileContents | null;
  readonly newFile: FileContents;
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
  readonly editableFiles: EditableDiffFiles | null;
  /**
   * Ready-to-pass `editSession` for `FileDiffContent`/`DiffContentPrimitive`:
   * `undefined` whenever editing isn't active/hydrated yet, otherwise the
   * same `editorOptions`/`oldFile`/`newFile` every surface used to construct
   * itself from `active`/`hydrated`/`editableFiles`. Centralized here so the
   * gating rule for "is this diff actually editable right now" lives in one
   * place instead of being duplicated at each rendering surface.
   */
  readonly editSession: GitDiffEditSession | undefined;
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
      const validated = validateGitEditContents(result, args.file.stage);
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
      args.file.stage,
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

  useGitDiffDriftRetry({
    active,
    hydration,
    currentComparisonIdentity: args.currentComparisonIdentity,
    contentsQuery,
    editRuntime: fileSession.runtime,
    setStaleIdentity,
  });

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
  // Captures the seed `newFile.contents` exactly once per `hydration` object
  // identity, as a render-phase state adjustment (React's documented
  // "storing information from previous renders" pattern -
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders)
  // rather than inside the memo below: reading external mutable state (the
  // zustand store) inside a `useMemo` body makes it impure, since React may
  // re-invoke that body for reasons unrelated to the dependency list (a
  // discarded render, a Strict Mode double-invoke) and observe a different,
  // now-typed `draftContent` each time. Calling `setState` directly during
  // render like this - guarded so it only fires when `hydration`/`editRuntime`
  // genuinely changed since the last capture - lets React restart the render
  // immediately with the new state before ever committing, so it does not
  // cost an extra visible frame or cascading effect the way scheduling this
  // same read from a `useEffect` would. It runs once the runtime is actually
  // attached (so a resumed detached draft's live content is read correctly,
  // rather than the disk baseline `begin` fetched before activation
  // finished), then the state it sets stays fixed until a genuinely new
  // `hydration` cycle starts.
  const [editSeed, setEditSeed] = useState<EditSeed | null>(null);
  const capturedEditSeed = computeEditSeedCapture(
    hydration,
    editRuntime,
    editSeed,
  );
  if (capturedEditSeed !== null) setEditSeed(capturedEditSeed);
  const editableFiles = useMemo<EditableDiffFiles | null>(() => {
    if (hydration === null || hydratedNewFile === undefined) return null;
    // Activation hasn't attached a runtime yet (the capture above hasn't run
    // for this cycle) - use the disk baseline for now; the re-render once it
    // attaches picks up the captured seed instead.
    const seedContent =
      editSeed !== null && editSeed.hydration === hydration
        ? editSeed.content
        : hydratedNewFile.contents;
    return {
      oldFile: hydratedOldFile ?? null,
      newFile: { ...hydratedNewFile, contents: seedContent },
    };
  }, [editSeed, hydration, hydratedNewFile, hydratedOldFile]);

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

  const gitDiffEditSession = computeGitDiffEditSession(
    active,
    hydration !== null,
    editableFiles,
    editAdapter.editorOptions,
  );

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
    editableFiles,
    editSession: gitDiffEditSession,
    retry: fileSession.retry,
    keepMine,
    useDisk,
  };
}

/**
 * Re-checks worktree drift against a new comparison identity in the
 * background while an edit session is active, retrying a failed check on an
 * exponential backoff (capped at `DRIFT_RETRY_MAX_DELAY_MS`) instead of on
 * every incidental render - `contentsQuery` is not referentially stable, so
 * without the backoff a persistently unreachable host would be hit
 * continuously with no delay. A successful check still eventually detects
 * real drift once the host recovers.
 */
function useGitDiffDriftRetry(args: {
  readonly active: boolean;
  readonly hydration: GitDiffHydration | null;
  readonly currentComparisonIdentity: string;
  readonly contentsQuery: UseQueryResult<
    ResponseOfMethod<HostRpcRegistry, "git.getFileContents">,
    HostRpcError
  >;
  readonly editRuntime: FileEditRuntime | null;
  readonly setStaleIdentity: Dispatch<SetStateAction<string | null>>;
}): void {
  const {
    active,
    hydration,
    currentComparisonIdentity,
    contentsQuery,
    editRuntime,
    setStaleIdentity,
  } = args;
  const driftCheckedRef = useRef<{
    readonly hydration: GitDiffHydration;
    readonly comparisonIdentity: string | null;
  } | null>(null);
  const driftAttemptRef = useRef<string | null>(null);
  const driftBackoffRef = useRef<{
    readonly identity: string;
    readonly attempts: number;
  }>({ identity: "", attempts: 0 });
  const driftRetryTimerRef = useRef<number | null>(null);
  const [driftRetryGeneration, setDriftRetryGeneration] = useState(0);

  useEffect(() => {
    if (!active || hydration === null) return;
    let checked = driftCheckedRef.current;
    if (checked?.hydration !== hydration) {
      if (driftRetryTimerRef.current !== null) {
        window.clearTimeout(driftRetryTimerRef.current);
        driftRetryTimerRef.current = null;
      }
      driftAttemptRef.current = null;
      driftBackoffRef.current = { identity: "", attempts: 0 };
      checked = {
        hydration,
        comparisonIdentity: hydration.comparisonIdentity,
      };
      driftCheckedRef.current = checked;
    }
    if (
      driftAttemptRef.current !== null &&
      driftAttemptRef.current !== currentComparisonIdentity
    ) {
      if (driftRetryTimerRef.current !== null) {
        window.clearTimeout(driftRetryTimerRef.current);
        driftRetryTimerRef.current = null;
      }
      driftAttemptRef.current = null;
      driftBackoffRef.current = { identity: "", attempts: 0 };
      checked = { ...checked, comparisonIdentity: null };
      driftCheckedRef.current = checked;
    }
    if (
      checked.comparisonIdentity === currentComparisonIdentity ||
      // `contentsQuery` (a TanStack Query result) is not referentially
      // stable across renders, so this effect can re-run while the request is
      // in flight. Keep that identity separate from the last successful check
      // so neither case starts a duplicate `git.getFileContents` RPC.
      driftAttemptRef.current === currentComparisonIdentity
    ) {
      return;
    }
    const attemptHydration = hydration;
    const attemptIdentity = currentComparisonIdentity;
    driftAttemptRef.current = attemptIdentity;
    // A failed check schedules its own bounded retry below instead of
    // clearing `driftAttemptRef` immediately - clearing it right away would
    // let ANY subsequent render restart the RPC with no delay. Staleness is
    // checked purely through `driftAttemptRef`/`driftBackoffRef` (not a
    // closure-scoped `cancelled` flag torn down by effect cleanup): this
    // effect's cleanup runs on EVERY re-render `contentsQuery`'s referential
    // instability causes, including harmless ones that immediately hit the
    // guard above and never touch these refs - a `cancelled` flag would go
    // true on one of those and silently swallow the scheduled retry's
    // eventual generation bump, never firing again.
    const scheduleRetry = (): void => {
      const attempts =
        driftBackoffRef.current.identity === attemptIdentity
          ? driftBackoffRef.current.attempts + 1
          : 1;
      driftBackoffRef.current = { identity: attemptIdentity, attempts };
      const delayMs = Math.min(
        DRIFT_RETRY_BASE_DELAY_MS * 2 ** (attempts - 1),
        DRIFT_RETRY_MAX_DELAY_MS,
      );
      if (driftRetryTimerRef.current !== null) {
        window.clearTimeout(driftRetryTimerRef.current);
      }
      driftRetryTimerRef.current = window.setTimeout(() => {
        driftRetryTimerRef.current = null;
        // Only clear + retry if this scheduled attempt is still the
        // relevant one - a genuinely different identity may have since
        // superseded it and already reset the backoff itself.
        if (
          driftBackoffRef.current.identity === attemptIdentity &&
          driftAttemptRef.current === attemptIdentity &&
          driftCheckedRef.current?.hydration === attemptHydration
        ) {
          driftAttemptRef.current = null;
          setDriftRetryGeneration((generation) => generation + 1);
        }
      }, delayMs);
    };
    void contentsQuery
      .refetch()
      .then((result) => {
        // `driftAttemptRef` only moves when a genuinely different comparison
        // identity supersedes this one, so this correctly ignores a result
        // that arrived after that happened.
        if (
          driftAttemptRef.current !== attemptIdentity ||
          driftCheckedRef.current?.hydration !== attemptHydration
        ) {
          return;
        }
        // A transport failure (`result.error`, the same field
        // `validateGitEditContents` checks) or a payload-level error (RPC
        // succeeded but reported one) means this comparison never actually
        // ran - `worktreeFile` is absent either way. Treating that the same
        // as "checked, content differs" would flag a merely-unreachable host
        // as genuine worktree drift - retry on a backoff timer instead so a
        // persistently failing check eventually still detects real drift,
        // without spinning.
        if (result.error !== null || (result.data?.error ?? null) !== null) {
          scheduleRetry();
          return;
        }
        driftBackoffRef.current = { identity: "", attempts: 0 };
        const latestContent = result.data?.worktreeFile?.contents;
        const matchesBaseline =
          latestContent !== undefined &&
          latestContent === editRuntime?.store.getState().baselineContent;
        driftAttemptRef.current = null;
        // Keep the acknowledgement beside, rather than inside, the structural
        // hydration seed. A later return to an older identity is checked again
        // against the runtime's newer baseline, while successful checks do not
        // rebuild `fileDiffs` and detach the editor.
        driftCheckedRef.current = {
          hydration: attemptHydration,
          comparisonIdentity: attemptIdentity,
        };
        setStaleIdentity(matchesBaseline ? null : attemptIdentity);
      })
      .catch(() => {
        if (
          driftAttemptRef.current === attemptIdentity &&
          driftCheckedRef.current?.hydration === attemptHydration
        ) {
          scheduleRetry();
        }
      });
  }, [
    active,
    contentsQuery,
    currentComparisonIdentity,
    editRuntime,
    hydration,
    setStaleIdentity,
    driftRetryGeneration,
  ]);

  useEffect(() => {
    return () => {
      if (driftRetryTimerRef.current !== null) {
        window.clearTimeout(driftRetryTimerRef.current);
      }
    };
  }, []);
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
    // The surface's own client, which is the one addressing `args.hostId` -
    // both callers (`GitFileDiffPanel`, `BundleInlineDiff`) resolve it from
    // `useTabHostClient()`. Never the app-wide read (D15).
    client: args.client,
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

function computeGitDiffEditSession(
  active: boolean,
  hydrated: boolean,
  editableFiles: EditableDiffFiles | null,
  editorOptions: EditorOptions<undefined>,
): GitDiffEditSession | undefined {
  if (!active || !hydrated || editableFiles === null) return undefined;
  return {
    editorOptions,
    oldFile: editableFiles.oldFile,
    newFile: editableFiles.newFile,
  };
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

function validateGitEditContents(
  result: {
    readonly error: unknown;
    readonly data: GitEditContentsPayload | undefined;
  },
  stage: GitChangedFile["stage"],
): ValidatedGitEditContents {
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
  // At "untracked" stage a missing old side is the norm (there is no prior
  // committed/staged version at all). At "unstaged" stage - the only other
  // stage `canOfferGitDiffEdit` allows - a tracked file always has an index
  // entry, so a null old side here means the read genuinely failed to
  // resolve it (a race between the diff computation and this fetch, or a
  // host-side read failure `readEditableGitObject` couldn't distinguish).
  // Surface that as an error rather than silently letting the file diff stay
  // partial and un-editable with no explanation.
  if (contents.oldFile === null && stage !== "untracked") {
    return {
      kind: "error",
      message: "Couldn't load this change's original content.",
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
