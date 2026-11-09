import { use, useCallback, type ReactNode } from "react";
import { toast } from "sonner";
import { EPIC_ARTIFACT_INDEX_FILENAME } from "@traycer/protocol/common/artifact-path";
import { TabHostContext } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useArtifactTreeLinkOpener } from "@/components/epic-canvas/renderers/use-artifact-link-opener";
import type { OpenableArtifactLink } from "@/editor-core";
import type { LinkClickEvent } from "@/lib/links/open-link";
import type { SandboxArtifactLink } from "@/lib/sandbox/bridge-host";
import { artifactEpicIdFromLinkPath } from "@/markdown/links/artifact-link-path";
import { classifyHref } from "@/markdown/links/classify-href";
import { resolveArtifactRelativeLinkPath } from "@/markdown/links/resolve-artifact-relative-link";
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

/** The `scheme://authority` (or bare `//authority`) an href opens with. */
const ORIGIN_PREFIX = /^(?:[a-z][a-z\d+.-]*:)?\/\/[^/?#]*/iu;

/**
 * An href written out in full on the clicked page's own origin, spelled as the
 * rooted href it is. An artifact address carries the artifact and mount in its
 * host and the whole tree path in its URL path
 * (`traycer-artifact://artifact-a1--m1/research/index.html`, or on Android
 * `https://artifact-a1--m1.traycer-artifact.invalid/research/index.html`), so
 * cutting the origin off the href as written leaves that path from the tree
 * root, `../` and all. The origins are compared as the page's own URL reads
 * them; an href on any other origin is returned as written, and names no file.
 */
function rootedOnPageOrigin(href: string, pageUrl: string): string {
  const prefix = ORIGIN_PREFIX.exec(href);
  if (prefix === null) return href;
  let target: URL;
  let page: URL;
  try {
    page = new URL(pageUrl);
    target = new URL(href, page);
  } catch {
    return href;
  }
  if (target.protocol !== page.protocol || target.host !== page.host)
    return href;
  const rest = href.slice(prefix[0].length);
  return rest.startsWith("/") ? rest : `/${rest}`;
}

/**
 * The opener's view of a page's link: the authored href, and the folder it is
 * read from. A relative href is read from the page's own folder in the tree.
 * A rooted one (`/research/`), or one written out in full on the page's own
 * origin, is read from the tree's root, as the frame's own URL space reads it.
 * An href that names an artifact on disk (`…/epics/<id>/artifacts/…`) goes to
 * the opener as written, the way a markdown link's does, with no folder
 * (`null`). The result is `null` for an href that names no file.
 */
function treeLinkFor(link: SandboxArtifactLink): {
  readonly link: Extract<OpenableArtifactLink, { readonly kind: "file" }>;
  readonly folderChain: readonly string[] | null;
} | null {
  const href = rootedOnPageOrigin(link.href, link.pageUrl);
  // A query or fragment addresses a place inside the target; the tile opens
  // the target itself.
  const end = href.search(/[?#]/u);
  const classified = classifyHref(end === -1 ? href : href.slice(0, end));
  if (classified.kind !== "file") return null;
  const path = classified.path.replace(
    ENTRY_DOCUMENT,
    `$1${EPIC_ARTIFACT_INDEX_FILENAME}`,
  );
  if (artifactEpicIdFromLinkPath(path) !== null)
    return { link: { ...classified, path }, folderChain: null };
  if (path.startsWith("/")) {
    return {
      link: { ...classified, path: path.replace(/^\/+/u, "") },
      folderChain: [],
    };
  }
  return {
    link: { ...classified, path },
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
      // A page is an artifact, so a path it reads from the tree that walks
      // above the tree's root, or names the root itself, is a dead end: no
      // workspace file is probed in its place, as a markdown link's would be.
      if (
        target === null ||
        (target.folderChain !== null &&
          resolveArtifactRelativeLinkPath(
            props.epicId,
            target.folderChain,
            target.link.path,
          ) === null)
      ) {
        toast("Couldn't open link");
        return;
      }
      openTreeLink(target.link, PLAIN_CLICK, target.folderChain);
    },
    [openTreeLink, props.epicId],
  );
  return (
    <HtmlArtifactLinkContext value={openPageLink}>
      {props.children}
    </HtmlArtifactLinkContext>
  );
}
