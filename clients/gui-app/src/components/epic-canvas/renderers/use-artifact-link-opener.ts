import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";
import {
  buildChatLinkPolicy,
  firstEagerlyTrueIndex,
  openResolvedArtifact,
  openResolvedWorkspaceTarget,
  type ChatLinkLifecycle,
  type ChatLinkPolicyDeps,
} from "@/components/chat/build-chat-link-policy";
import { candidateWorkspaceFileRefsForRelativeLinkPath } from "@/components/epic-canvas/workspace-file/workspace-file-link-ref";
import type { ResolveArtifactByPathResult } from "@traycer/protocol/host/epic/unary-schemas";
import type { OpenableArtifactLink } from "@/editor-core";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useRunnerOpenExternalLink } from "@/hooks/runner/use-open-external-link-mutation";
import { useWorktreeListBindingsForEpicForClient } from "@/hooks/worktree/use-worktree-list-bindings-for-epic-query";
import { useArtifactFolderChain } from "@/lib/epic-selectors";
import { useHostClient } from "@/lib/host";
import { fetchResolveArtifactByPath } from "@/lib/host/resolve-artifact-by-path";
import { fetchWorkspaceFileExists } from "@/lib/host/probe-workspace-file-exists";
import { isAbsolutePath } from "@/lib/path/cross-platform-path";
import { isBrowsable } from "@/lib/worktree/worktree-row-browsable";
import type { MarkdownFileLink } from "@/markdown/links/markdown-link-context";
import { resolveArtifactRelativeLinkPath } from "@/markdown/links/resolve-artifact-relative-link";
import { useOpenEpicHandle } from "@/providers/use-open-epic-handle";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";

export interface ArtifactLinkOpener {
  readonly openLink: (link: OpenableArtifactLink) => void;
  readonly isExternalPending: boolean;
}

/**
 * Races the ARTIFACT-FOLDER interpretation of a relative href (resolved
 * against THIS artifact's own folder chain, confirmed via the read-only
 * `epic.resolveArtifactByPath` RPC) against its plain WORKSPACE-FILE
 * interpretation (resolved against the chat's bound roots, existence-probed
 * the same way a chat link is) - whichever resolves first, BY PRIORITY,
 * wins. File candidates take priority (listed first in the combined probe
 * list): the corpus backing this design found extension-bearing targets are
 * always real workspace files, never sub-artifact references, so a fast,
 * common file hit is never held up waiting on the slower RPC-based folder
 * candidate to settle (`firstEagerlyTrueIndex` only blocks a LATER
 * candidate on an EARLIER one still being pending, never the reverse).
 *
 * This replaces guessing folder-vs-file from the href's spelling (a real
 * file literally named `README`, `LICENSE`, or `.env`, or a dotted folder
 * like `v1.2`, defeats any such guess - see the corpus report) with an
 * actual existence check on both interpretations. The RPC candidate still
 * fires even when a file candidate is likely to win first; the wasted
 * round-trip is the accepted cost of not re-introducing a spelling-based
 * skip that would regress the `v1.2`-style dotted-folder case.
 *
 * `resolveArtifactRelativeLinkPath` returning `null` (the href walks above
 * the epic's artifacts root) is a deliberate dead end, NOT a bug to route
 * around with a parent-directory or artifacts-root fallback: the corpus
 * backing this design found that walking one level too far almost always
 * lands on SOME real artifact - just the wrong one - so guessing a
 * different base would silently open an unrelated artifact instead of
 * failing visibly. The click still races the plain workspace-file
 * candidates in that case; it just has no folder candidate to race against,
 * so a genuine `../` depth miscount by the authoring agent surfaces as the
 * ordinary "Couldn't open link" toast rather than a silent wrong open.
 */
function resolveAndOpenArtifactRelativeHref(
  deps: ChatLinkPolicyDeps,
  lifecycle: ChatLinkLifecycle,
  link: MarkdownFileLink,
  context: {
    readonly epicId: string;
    readonly selfFolderChain: readonly string[] | null;
  },
): Promise<void> {
  const { epicId, selfFolderChain } = context;
  const clickToken = lifecycle.beginClick();
  lifecycle.getPendingProjectedOpenCancel()?.();
  lifecycle.setPendingProjectedOpenCancel(null);
  if (deps.hostId === null || deps.workspaceClient === null) {
    lifecycle.onAsyncFailure();
    return Promise.resolve();
  }
  const hostId = deps.hostId;
  const workspaceClient = deps.workspaceClient;
  const fileCandidates =
    candidateWorkspaceFileRefsForRelativeLinkPath(
      hostId,
      deps.workspaceRoots,
      link.path,
    ) ?? [];
  const fileProbes = fileCandidates.map((ref) =>
    fetchWorkspaceFileExists({
      queryClient: deps.queryClient,
      client: workspaceClient,
      hostId,
      workspacePath: ref.workspacePath,
      filePath: ref.filePath,
    }),
  );
  const folderCandidatePath =
    selfFolderChain === null
      ? null
      : resolveArtifactRelativeLinkPath(epicId, selfFolderChain, link.path);
  const resolveHostId = deps.activeHostId;
  const fetchFolderArtifact =
    (): Promise<ResolveArtifactByPathResult | null> =>
      folderCandidatePath === null || resolveHostId === null
        ? Promise.resolve(null)
        : fetchResolveArtifactByPath({
            queryClient: deps.queryClient,
            client: deps.client,
            hostId: resolveHostId,
            epicId,
            filePath: folderCandidatePath,
          });
  const probes = [
    ...fileProbes,
    fetchFolderArtifact().then((artifact) => artifact !== null),
  ];
  const folderIndex = probes.length - 1;
  return firstEagerlyTrueIndex(probes).then((winningIndex) => {
    if (lifecycle.isDisposed()) return;
    if (!lifecycle.isCurrent(clickToken)) return;
    if (winningIndex === -1) {
      lifecycle.onAsyncFailure();
      return;
    }
    if (winningIndex !== folderIndex) {
      openResolvedWorkspaceTarget(deps, lifecycle, link, {
        ref: fileCandidates[winningIndex],
        clickToken,
      });
      return;
    }
    if (folderCandidatePath === null || resolveHostId === null) {
      lifecycle.onAsyncFailure();
      return;
    }
    // The winning probe already confirmed a real artifact exists; this
    // re-fetch is a cache hit (`fetchResolveArtifactByPath`'s query stays
    // fresh for 15s), not a second round-trip - `firstEagerlyTrueIndex`
    // only reports WHICH candidate won, not the value it resolved to.
    void fetchFolderArtifact().then((artifact) => {
      if (lifecycle.isDisposed() || !lifecycle.isCurrent(clickToken)) return;
      if (artifact === null) {
        lifecycle.onAsyncFailure();
        return;
      }
      openResolvedArtifact(deps, lifecycle, {
        artifact,
        target: { artifactEpicId: epicId, resolveHostId, clickToken },
        onUnavailable: () => lifecycle.onAsyncFailure(),
      });
    });
  });
}

export function useArtifactLinkOpener(args: {
  readonly epicId: string;
  readonly artifactId: string;
  readonly viewTabId: string;
}): ArtifactLinkOpener {
  const tabHostId = useTabHostId();
  const selfFolderChain = useArtifactFolderChain(args.artifactId);
  const tabHostClient = useTabHostClient();
  const activeHostId = useReactiveActiveHostId();
  const worktrees = useWorktreeListBindingsForEpicForClient({
    client: tabHostClient,
    epicId: args.epicId,
    enabled: tabHostClient !== null,
  });
  const workspaceRoots = useMemo<ReadonlyArray<string> | null>(() => {
    if (worktrees.data === undefined) return null;
    const rows = worktrees.data.rows;
    return Array.from(
      new Set(
        rows.flatMap((row) => (isBrowsable(row) ? [row.runningDir] : [])),
      ),
    );
  }, [worktrees.data]);
  const tileNavigation = useEpicTileNavigation();
  const previewTileInTab = useCallback(
    (tabId: string, node: EpicCanvasTileRef): void => {
      tileNavigation.openTilePreviewInTab(tabId, node);
    },
    [tileNavigation],
  );
  const queryClient = useQueryClient();
  const client = useHostClient();
  const navigate = useNavigate();
  const epicHandle = useOpenEpicHandle();
  const { mutate: openExternalLink, isPending: isExternalPending } =
    useRunnerOpenExternalLink();
  const pendingProjectedOpenCancelRef = useRef<(() => void) | null>(null);
  const disposedRef = useRef(false);
  const clickTokenRef = useRef(0);
  const externalOpenInFlightRef = useRef(false);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      externalOpenInFlightRef.current = false;
      pendingProjectedOpenCancelRef.current?.();
      pendingProjectedOpenCancelRef.current = null;
    };
  }, []);

  const supersedePending = useCallback((): number => {
    clickTokenRef.current += 1;
    pendingProjectedOpenCancelRef.current?.();
    pendingProjectedOpenCancelRef.current = null;
    return clickTokenRef.current;
  }, []);

  const chatDeps = useMemo<ChatLinkPolicyDeps | null>(() => {
    if (workspaceRoots === null) return null;
    return {
      tabId: args.viewTabId,
      hostId: tabHostId,
      workspaceRoots,
      activeHostId,
      openEpicId: args.epicId,
      epicHandle,
      queryClient,
      client,
      workspaceClient: tabHostClient,
      navigate,
      previewTileInTab,
    };
  }, [
    activeHostId,
    args.epicId,
    args.viewTabId,
    client,
    epicHandle,
    navigate,
    previewTileInTab,
    queryClient,
    tabHostClient,
    tabHostId,
    workspaceRoots,
  ]);

  const openFile = useMemo(
    () => (chatDeps === null ? null : buildChatLinkPolicy(chatDeps)),
    [chatDeps],
  );

  const openLink = useCallback(
    (link: OpenableArtifactLink): void => {
      if (link.kind === "external") {
        supersedePending();
        if (externalOpenInFlightRef.current) return;
        externalOpenInFlightRef.current = true;
        openExternalLink(link.url, {
          onSettled: () => {
            externalOpenInFlightRef.current = false;
          },
        });
        return;
      }
      if (openFile === null || chatDeps === null) {
        toast(
          worktrees.isError
            ? "Couldn't open link"
            : "Workspace links are still loading",
        );
        return;
      }
      const lifecycle: ChatLinkLifecycle = {
        isDisposed: () => disposedRef.current,
        getPendingProjectedOpenCancel: () =>
          pendingProjectedOpenCancelRef.current,
        setPendingProjectedOpenCancel: (cancel) => {
          pendingProjectedOpenCancelRef.current = cancel;
        },
        beginClick: supersedePending,
        isCurrent: (token) => token === clickTokenRef.current,
        onAsyncFailure: () => toast("Couldn't open link"),
      };
      const markdownLink: MarkdownFileLink = {
        path: link.path,
        line: link.line,
        col: link.col,
        isDirectory: false,
      };
      if (isAbsolutePath(link.path)) {
        // An absolute href, authored inside an artifact, is passed through
        // UNCHANGED - `buildChatLinkPolicy`'s absolute resolution races the
        // direct file against its `index.md` fallback and reclassifies the
        // winner as an artifact when it turns out to be index.md-shaped (A,
        // C1), so no client-side canonicalization is needed here.
        if (!openFile(markdownLink, lifecycle)) toast("Couldn't open link");
        return;
      }
      void resolveAndOpenArtifactRelativeHref(
        chatDeps,
        lifecycle,
        markdownLink,
        {
          epicId: args.epicId,
          selfFolderChain,
        },
      );
    },
    [
      args.epicId,
      chatDeps,
      openExternalLink,
      openFile,
      selfFolderChain,
      supersedePending,
      worktrees.isError,
    ],
  );

  return { openLink, isExternalPending };
}
