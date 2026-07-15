import { workspaceFileRefFromWorkspaceMarkdownLink } from "@/components/epic-canvas/workspace-file/workspace-file-link-ref";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import {
  MarkdownLinkContext,
  type MarkdownLinkPolicy,
} from "@/markdown/links/markdown-link-context";
import { useMemo, type ReactNode } from "react";

interface WorkspaceMarkdownLinkProviderProps {
  readonly tabId: string;
  readonly hostId: string;
  readonly workspacePath: string;
  readonly filePath: string;
  readonly children: ReactNode;
}

/**
 * Link policy for markdown rendered inside a workspace-file preview. Relative
 * links resolve beside the markdown file being previewed, not against the
 * process cwd or the app route.
 */
export function WorkspaceMarkdownLinkProvider(
  props: WorkspaceMarkdownLinkProviderProps,
) {
  const tileNavigation = useEpicTileNavigation();
  const linkPolicy = useMemo<MarkdownLinkPolicy>(
    () => ({
      supersedePendingFileLink: () => undefined,
      openFileLink: (link) => {
        // Intentional asymmetry: this workspace-file preview surface ignores
        // the link's `:line`/`:col` target, unlike chat (which records a reveal
        // request). The plan scopes line targeting to chat; a preview tile just
        // opens the file at the top. Do not wire the reveal channel here without
        // revisiting that decision.
        if (link.isDirectory) return false;
        const ref = workspaceFileRefFromWorkspaceMarkdownLink(
          props.hostId,
          props.workspacePath,
          props.filePath,
          link.path,
        );
        if (ref === null) return false;
        tileNavigation.openTilePreviewInTab(props.tabId, ref);
        return true;
      },
    }),
    [
      props.hostId,
      props.filePath,
      props.tabId,
      props.workspacePath,
      tileNavigation,
    ],
  );

  return (
    <MarkdownLinkContext.Provider value={linkPolicy}>
      {props.children}
    </MarkdownLinkContext.Provider>
  );
}
