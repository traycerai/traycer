import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";
import { buildChatLinkPolicy } from "@/components/chat/build-chat-link-policy";
import type { OpenableArtifactLink } from "@/editor-core";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useRunnerOpenExternalLink } from "@/hooks/runner/use-open-external-link-mutation";
import { useWorktreeListBindingsForEpicForClient } from "@/hooks/worktree/use-worktree-list-bindings-for-epic-query";
import { useArtifactFolderChain } from "@/lib/epic-selectors";
import { useHostClient } from "@/lib/host";
import { isAbsolutePath } from "@/lib/path/cross-platform-path";
import { isBrowsable } from "@/lib/worktree/worktree-row-browsable";
import { artifactEpicIdFromLinkPath } from "@/markdown/links/artifact-link-path";
import {
  isArtifactFolderHref,
  resolveArtifactRelativeLinkPath,
} from "@/markdown/links/resolve-artifact-relative-link";
import { EPIC_ARTIFACT_INDEX_FILENAME } from "@traycer/protocol/common/artifact-path";
import { useOpenEpicHandle } from "@/providers/use-open-epic-handle";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";

export interface ArtifactLinkOpener {
  readonly openLink: (link: OpenableArtifactLink) => void;
  readonly isExternalPending: boolean;
}

function withArtifactIndexSuffix(path: string): string {
  if (path.endsWith(`/${EPIC_ARTIFACT_INDEX_FILENAME}`)) return path;
  return `${path.endsWith("/") ? path : `${path}/`}${EPIC_ARTIFACT_INDEX_FILENAME}`;
}

/**
 * A directory-shaped absolute artifact href (no explicit `/index.md`
 * suffix) is canonicalized the same way a relative one already is - only
 * when appending the suffix would make the result structurally match the
 * artifact-path marker, so an unrelated absolute directory reference (a
 * plain workspace folder) is never mangled.
 */
function canonicalizeAbsoluteArtifactHref(path: string): string {
  if (artifactEpicIdFromLinkPath(path) !== null) return path;
  const withSuffix = withArtifactIndexSuffix(path);
  return artifactEpicIdFromLinkPath(withSuffix) !== null ? withSuffix : path;
}

/**
 * Resolves an artifact-editor-authored href to the path `openFile` should
 * act on: an absolute href is canonicalized (directory -> index.md) and
 * passed through; a RELATIVE href that navigates the artifact folder tree
 * (`isArtifactFolderHref`) is rewritten against `selfFolderChain`; anything
 * else (a relative href with a non-index.md file extension, e.g.
 * `../src/main.ts`) is left UNCHANGED so `openFile`'s existing relative-path
 * branch resolves it as a normal workspace file instead of coercing it into
 * `name/index.md`.
 */
function resolveArtifactLinkPath(
  epicId: string,
  selfFolderChain: readonly string[] | null,
  path: string,
): string | null {
  if (isAbsolutePath(path)) return canonicalizeAbsoluteArtifactHref(path);
  if (!isArtifactFolderHref(path)) return path;
  if (selfFolderChain === null) return null;
  return resolveArtifactRelativeLinkPath(epicId, selfFolderChain, path);
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

  const openFile = useMemo(() => {
    if (workspaceRoots === null) return null;
    return buildChatLinkPolicy({
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
    });
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
      if (openFile === null) {
        toast(
          worktrees.isError
            ? "Couldn't open link"
            : "Workspace links are still loading",
        );
        return;
      }
      // A relative href is authored from the artifact tree's own point of
      // view (`./`, `../`, bare folder names), NOT the code workspace -
      // rewrite it against this artifact's own on-disk directory before
      // handing off to the shared absolute-path-capable resolve+open flow.
      // An unresolvable relative href (chain data unavailable, or the
      // navigation walks above the epic's artifacts root) fails the click
      // directly rather than falling through to workspace-root resolution.
      const resolvedPath = resolveArtifactLinkPath(
        args.epicId,
        selfFolderChain,
        link.path,
      );
      if (resolvedPath === null) {
        toast("Couldn't open link");
        return;
      }
      const opened = openFile(
        {
          path: resolvedPath,
          line: link.line,
          col: link.col,
          isDirectory: false,
        },
        {
          isDisposed: () => disposedRef.current,
          getPendingProjectedOpenCancel: () =>
            pendingProjectedOpenCancelRef.current,
          setPendingProjectedOpenCancel: (cancel) => {
            pendingProjectedOpenCancelRef.current = cancel;
          },
          beginClick: supersedePending,
          isCurrent: (token) => token === clickTokenRef.current,
          onAsyncFailure: () => toast("Couldn't open link"),
        },
      );
      if (!opened) toast("Couldn't open link");
    },
    [
      args.epicId,
      openExternalLink,
      openFile,
      selfFolderChain,
      supersedePending,
      worktrees.isError,
    ],
  );

  return { openLink, isExternalPending };
}
