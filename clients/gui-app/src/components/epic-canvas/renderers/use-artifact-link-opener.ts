import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";
import {
  buildChatLinkPolicy,
  firstEagerlyTrueIndex,
  openResolvedArtifact,
  openResolvedWorkspaceTarget,
  type ChatLinkHandler,
  type ChatLinkLifecycle,
  type ChatLinkPolicyDeps,
} from "@/components/chat/build-chat-link-policy";
import { candidateWorkspaceFileRefsForRelativeLinkPath } from "@/components/epic-canvas/workspace-file/workspace-file-link-ref";
import type { ResolveArtifactByPathResult } from "@traycer/protocol/host/epic/unary-schemas";
import type { OpenableArtifactLink } from "@/editor-core";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useWorktreeListBindingsForEpicForClient } from "@/hooks/worktree/use-worktree-list-bindings-for-epic-query";
import { useArtifactFolderChain } from "@/lib/epic-selectors";
import { fetchResolveArtifactByPath } from "@/lib/host/resolve-artifact-by-path";
import { fetchWorkspaceFileExists } from "@/lib/host/probe-workspace-file-exists";
import type { LinkClickEvent } from "@/lib/links/open-link";
import { useOpenLinkWithPending } from "@/lib/links/open-link";
import { isAbsolutePath } from "@/lib/path/cross-platform-path";
import { isBrowsable } from "@/lib/worktree/worktree-row-browsable";
import { artifactEpicIdFromLinkPath } from "@/markdown/links/artifact-link-path";
import type { MarkdownFileLink } from "@/markdown/links/markdown-link-context";
import { resolveArtifactRelativeLinkPath } from "@/markdown/links/resolve-artifact-relative-link";
import { useOpenEpicHandle } from "@/providers/use-open-epic-handle";

export interface ArtifactLinkOpener {
  readonly openLink: (
    link: OpenableArtifactLink,
    event: LinkClickEvent,
  ) => void;
}

/**
 * Races the ARTIFACT-FOLDER interpretation of a relative href (resolved
 * against the folder chain it was written in - a markdown artifact's own
 * folder, or an html page's folder - confirmed via the read-only
 * `epic.resolveArtifactByPath` RPC) against its plain WORKSPACE-FILE
 * interpretation (resolved against the chat's bound roots, existence-probed
 * the same way a chat link is) - whichever resolves first, BY PRIORITY,
 * wins. The own-directory ARTIFACT candidate takes priority (listed FIRST in
 * the combined probe list): own-directory resolution is the corpus's
 * majority case (923/957 own-dir-only links are folder-shaped), so `[self
 * ](index.md)` or `./01-child/` must resolve to the artifact's OWN
 * sub-artifact when one exists there, not to a same-named file that happens
 * to also exist somewhere in the chat's bound workspace roots - a
 * lower-priority candidate is only even considered once the higher-priority
 * one is known to have missed (`firstEagerlyTrueIndex` only blocks a LATER
 * candidate on an EARLIER one still being pending, never the reverse, so the
 * artifact candidate winning never waits on a slower file probe either).
 *
 * This replaces guessing folder-vs-file from the href's spelling (a real
 * file literally named `README`, `LICENSE`, or `.env`, or a dotted folder
 * like `v1.2`, defeats any such guess - see the corpus report) with an
 * actual existence check on both interpretations. The file candidates still
 * fire concurrently even when the artifact candidate is likely to win; the
 * wasted round-trips are the accepted cost of not re-introducing a
 * spelling-based skip that would regress the `v1.2`-style dotted-folder
 * case.
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
    /** `false` races the folder candidate alone, for a link that may name only the artifacts tree. */
    readonly workspaceFiles: boolean;
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
  const fileCandidates = context.workspaceFiles
    ? (candidateWorkspaceFileRefsForRelativeLinkPath(
        hostId,
        deps.workspaceRoots,
        link.path,
      ) ?? [])
    : [];
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
  // Retains the resolved artifact (or `null` on a miss/transport rejection)
  // so the winner branch below can use it directly - `firstEagerlyTrueIndex`
  // only reports WHICH candidate won, not the value it resolved to, and a
  // second RPC call just to re-derive that value would be a wasted
  // round-trip. A rejection maps to `null`/`false` here explicitly (rather
  // than relying solely on `firstEagerlyTrueIndex`'s own rejection handling)
  // so this retained value stays in sync with what the race actually saw.
  let folderArtifactResult: ResolveArtifactByPathResult | null = null;
  const folderProbe: Promise<boolean> =
    folderCandidatePath === null || resolveHostId === null
      ? Promise.resolve(false)
      : fetchResolveArtifactByPath({
          queryClient: deps.queryClient,
          client: deps.client,
          hostId: resolveHostId,
          epicId,
          filePath: folderCandidatePath,
        })
          .then((artifact) => {
            folderArtifactResult = artifact;
            return artifact !== null;
          })
          .catch(() => false);
  const probes = [folderProbe, ...fileProbes];
  const folderIndex = 0;
  return firstEagerlyTrueIndex(probes).then((winningIndex) => {
    if (lifecycle.isDisposed()) return;
    if (!lifecycle.isCurrent(clickToken)) return;
    if (winningIndex === -1) {
      lifecycle.onAsyncFailure();
      return;
    }
    if (winningIndex !== folderIndex) {
      openResolvedWorkspaceTarget(deps, lifecycle, link, {
        ref: fileCandidates[winningIndex - 1],
        clickToken,
      });
      return;
    }
    if (folderArtifactResult === null || resolveHostId === null) {
      lifecycle.onAsyncFailure();
      return;
    }
    openResolvedArtifact(deps, lifecycle, {
      artifact: folderArtifactResult,
      target: { artifactEpicId: epicId, resolveHostId, clickToken },
      onUnavailable: () => lifecycle.onAsyncFailure(),
    });
  });
}

/**
 * Opens a link authored somewhere in the artifacts tree. A relative href
 * resolves against `folderChain`, the root-to-leaf folder names of the place
 * it was written; `null` gives it no folder candidate, as for an artifact
 * whose chain cannot be rebuilt.
 */
export type ArtifactTreeLinkOpener = (
  link: OpenableArtifactLink,
  event: LinkClickEvent,
  folderChain: readonly string[] | null,
) => void;

/**
 * Opens what `path`, read from `folderChain`, names in the artifacts tree, and
 * nothing outside it: no workspace or disk file, no other Epic.
 */
export type ArtifactTreeOnlyOpener = (
  path: string,
  folderChain: readonly string[],
) => void;

/** A markdown artifact's links, which are relative to its own folder. */
export function useArtifactLinkOpener(args: {
  readonly epicId: string;
  readonly artifactId: string;
  readonly viewTabId: string;
}): ArtifactLinkOpener {
  const selfFolderChain = useArtifactFolderChain(args.artifactId);
  const openTreeLink = useArtifactTreeLinkOpener({
    epicId: args.epicId,
    viewTabId: args.viewTabId,
  });
  const openLink = useCallback(
    (link: OpenableArtifactLink, event: LinkClickEvent): void =>
      openTreeLink(link, event, selfFolderChain),
    [openTreeLink, selfFolderChain],
  );
  return { openLink };
}

/** What both openers share: the tab's deps and the latest-click-wins lifecycle. */
interface TreeLinkRuntime {
  /** `null` until the Epic's worktrees have loaded. */
  readonly chatDeps: ChatLinkPolicyDeps | null;
  readonly openFile: ChatLinkHandler | null;
  /** Why a click finds `chatDeps` missing. */
  readonly unavailableMessage: string;
  readonly supersedePending: () => number;
  readonly newLifecycle: () => ChatLinkLifecycle;
}

function useTreeLinkRuntime(args: {
  readonly epicId: string;
  readonly viewTabId: string;
}): TreeLinkRuntime {
  const tabHostId = useTabHostId();
  const tabHostClient = useTabHostClient();
  const activeHostId = tabHostId;
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
  const { openTile } = useEpicTileNavigation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const epicHandle = useOpenEpicHandle();
  const pendingProjectedOpenCancelRef = useRef<(() => void) | null>(null);
  const disposedRef = useRef(false);
  const clickTokenRef = useRef(0);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
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

  const newLifecycle = useCallback(
    (): ChatLinkLifecycle => ({
      isDisposed: () => disposedRef.current,
      getPendingProjectedOpenCancel: () =>
        pendingProjectedOpenCancelRef.current,
      setPendingProjectedOpenCancel: (cancel) => {
        pendingProjectedOpenCancelRef.current = cancel;
      },
      beginClick: supersedePending,
      isCurrent: (token) => token === clickTokenRef.current,
      onAsyncFailure: () => toast("Couldn't open link"),
    }),
    [supersedePending],
  );

  const chatDeps = useMemo<ChatLinkPolicyDeps | null>(() => {
    if (workspaceRoots === null || tabHostClient === null) return null;
    return {
      tabId: args.viewTabId,
      hostId: tabHostId,
      workspaceRoots,
      activeHostId,
      openEpicId: args.epicId,
      epicHandle,
      queryClient,
      client: tabHostClient,
      workspaceClient: tabHostClient,
      navigate,
      // An artifact tile is a task's own, never a Tracy transcript.
      tracyOrigin: null,
      openTile,
    };
  }, [
    activeHostId,
    args.epicId,
    args.viewTabId,
    epicHandle,
    navigate,
    openTile,
    queryClient,
    tabHostClient,
    tabHostId,
    workspaceRoots,
  ]);

  const openFile = useMemo(
    () => (chatDeps === null ? null : buildChatLinkPolicy(chatDeps)),
    [chatDeps],
  );

  return {
    chatDeps,
    openFile,
    unavailableMessage: worktrees.isError
      ? "Couldn't open link"
      : "Folder links are still loading",
    supersedePending,
    newLifecycle,
  };
}

function markdownFileLink(
  link: Extract<OpenableArtifactLink, { readonly kind: "file" }>,
): MarkdownFileLink {
  return {
    path: link.path,
    line: link.line,
    col: link.col,
    isDirectory: false,
  };
}

export function useArtifactTreeLinkOpener(args: {
  readonly epicId: string;
  readonly viewTabId: string;
}): ArtifactTreeLinkOpener {
  const {
    chatDeps,
    openFile,
    unavailableMessage,
    supersedePending,
    newLifecycle,
  } = useTreeLinkRuntime(args);
  // `isPending` guards the egress the way the anchors do: each call
  // fires a fresh bridge request, so a double click would open two OS tabs.
  const { isPending: urlOpenPending, openLink: openUrl } =
    useOpenLinkWithPending();

  return useCallback(
    (
      link: OpenableArtifactLink,
      event: LinkClickEvent,
      folderChain: readonly string[] | null,
    ): void => {
      if (link.kind === "external") {
        if (urlOpenPending) return;
        supersedePending();
        // An artifact document's external link is markdown egress like any
        // other (A1): the `markdown` setting decides in-app vs the OS browser,
        // and the click's modifiers override it (A3).
        void openUrl(link.url, "markdown", event);
        return;
      }
      if (openFile === null || chatDeps === null) {
        // This is still a newer click. Invalidate any earlier async resolve or
        // projection wait before returning, otherwise that earlier click can
        // open after this one has already reported that links are unavailable.
        supersedePending();
        toast(unavailableMessage);
        return;
      }
      const lifecycle = newLifecycle();
      const fileLink = markdownFileLink(link);
      if (
        isAbsolutePath(link.path) ||
        artifactEpicIdFromLinkPath(link.path) !== null
      ) {
        // Absolute hrefs and rootless artifact-shaped hrefs are passed through
        // UNCHANGED. The shared policy resolves artifact paths before plain
        // file handling, so prefixing a rootless `epics/<id>/artifacts/...`
        // path with this artifact's folder chain would target the wrong item.
        if (!openFile(fileLink, lifecycle)) toast("Couldn't open link");
        return;
      }
      void resolveAndOpenArtifactRelativeHref(chatDeps, lifecycle, fileLink, {
        epicId: args.epicId,
        selfFolderChain: folderChain,
        workspaceFiles: true,
      });
    },
    [
      args.epicId,
      chatDeps,
      newLifecycle,
      openFile,
      openUrl,
      supersedePending,
      unavailableMessage,
      urlOpenPending,
    ],
  );
}

/**
 * The artifacts-tree half of the opener alone, for links a page's own script
 * may have written: the path only ever reaches this Epic's tree resolver,
 * whatever it spells (a drive, backslashes, another `epics/…/artifacts`), and
 * never the absolute-path, workspace-file or URL handling markdown links get.
 */
export function useArtifactTreeOnlyOpener(args: {
  readonly epicId: string;
  readonly viewTabId: string;
}): ArtifactTreeOnlyOpener {
  const { chatDeps, unavailableMessage, supersedePending, newLifecycle } =
    useTreeLinkRuntime(args);
  return useCallback(
    (path: string, folderChain: readonly string[]): void => {
      if (chatDeps === null) {
        supersedePending();
        toast(unavailableMessage);
        return;
      }
      void resolveAndOpenArtifactRelativeHref(
        chatDeps,
        newLifecycle(),
        { path, line: null, col: null, isDirectory: false },
        {
          epicId: args.epicId,
          selfFolderChain: folderChain,
          workspaceFiles: false,
        },
      );
    },
    [args.epicId, chatDeps, newLifecycle, supersedePending, unavailableMessage],
  );
}
