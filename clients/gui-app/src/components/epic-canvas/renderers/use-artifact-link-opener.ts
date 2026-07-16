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
import { useHostClient } from "@/lib/host";
import { isBrowsable } from "@/lib/worktree/worktree-row-browsable";
import { useOpenEpicHandle } from "@/providers/use-open-epic-handle";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";

export interface ArtifactLinkOpener {
  readonly openLink: (link: OpenableArtifactLink) => void;
  readonly isExternalPending: boolean;
}

export function useArtifactLinkOpener(args: {
  readonly epicId: string;
  readonly viewTabId: string;
}): ArtifactLinkOpener {
  const tabHostId = useTabHostId();
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
      const opened = openFile(
        {
          path: link.path,
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
    [openExternalLink, openFile, supersedePending, worktrees.isError],
  );

  return { openLink, isExternalPending };
}
