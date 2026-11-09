import { use, useCallback, type ReactNode } from "react";
import { toast } from "sonner";
import { EPIC_ARTIFACT_INDEX_FILENAME } from "@traycer/protocol/common/artifact-path";
import { TabHostContext } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useArtifactTreeLinkOpener } from "@/components/epic-canvas/renderers/use-artifact-link-opener";
import type { OpenableArtifactLink } from "@/editor-core";
import type { LinkClickEvent } from "@/lib/links/open-link";
import type { SandboxArtifactLink } from "@/lib/sandbox/bridge-host";
import { classifyHref } from "@/markdown/links/classify-href";
import { useMaybeOpenEpicHandle } from "@/providers/use-open-epic-handle";
import { HtmlArtifactLinkContext } from "./html-artifact-link-context";

/** The page forwards no modifiers, and a tree link opens the same way without them. */
const PLAIN_CLICK: LinkClickEvent = {
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  button: 0,
};

/**
 * The entry document of an html or canvas artifact. A link to one names its
 * artifact, so it is spelled as a markdown link to that artifact would be: by
 * the folder's `index.md`, which the resolver reads as the folder itself.
 */
const ENTRY_DOCUMENT = /(^|[\\/])(?:index\.html|canvas\.json)$/u;

/**
 * The opener's view of a page's link: the authored href, and the folder it was
 * written in, which is the page's own folder in the tree. `null` for an href
 * that names no file.
 */
function treeLinkFor(link: SandboxArtifactLink): {
  readonly link: OpenableArtifactLink;
  readonly folderChain: readonly string[];
} | null {
  // A query or fragment addresses a place inside the target; the tile opens
  // the target itself.
  const end = link.href.search(/[?#]/u);
  const classified = classifyHref(
    end === -1 ? link.href : link.href.slice(0, end),
  );
  if (classified.kind !== "file") return null;
  return {
    link: {
      ...classified,
      path: classified.path.replace(
        ENTRY_DOCUMENT,
        `$1${EPIC_ARTIFACT_INDEX_FILENAME}`,
      ),
    },
    folderChain: link.pagePath.split("/").slice(0, -1),
  };
}

/**
 * Gives the html artifact frames inside it a way to open what their pages link
 * to elsewhere in the artifacts tree, the way a markdown artifact opens its
 * links. A surface outside an Epic's tab, or one with no task or tile host
 * around it, has no tree to resolve against and nowhere to open a tile, so its
 * frames are left without one.
 */
export function HtmlArtifactLinks(props: {
  readonly epicId: string;
  readonly viewTabId: string | null;
  readonly children: ReactNode;
}): ReactNode {
  const tileHost = use(TabHostContext);
  const epicHandle = useMaybeOpenEpicHandle();
  if (props.viewTabId === null || tileHost === null || epicHandle === null)
    return props.children;
  return (
    <TreeLinks epicId={props.epicId} viewTabId={props.viewTabId}>
      {props.children}
    </TreeLinks>
  );
}

function TreeLinks(props: {
  readonly epicId: string;
  readonly viewTabId: string;
  readonly children: ReactNode;
}) {
  const openTreeLink = useArtifactTreeLinkOpener({
    epicId: props.epicId,
    viewTabId: props.viewTabId,
  });
  const openPageLink = useCallback(
    (link: SandboxArtifactLink): void => {
      const target = treeLinkFor(link);
      if (target === null) {
        toast("Couldn't open link");
        return;
      }
      openTreeLink(target.link, PLAIN_CLICK, target.folderChain);
    },
    [openTreeLink],
  );
  return (
    <HtmlArtifactLinkContext value={openPageLink}>
      {props.children}
    </HtmlArtifactLinkContext>
  );
}
