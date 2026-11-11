import { use, useCallback, type ReactNode } from "react";
import { toast } from "sonner";
import {
  artifactLinkPathRootAgnostic,
  EPIC_ARTIFACT_INDEX_FILENAME,
} from "@traycer/protocol/common/artifact-path";
import { TabHostContext } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { useArtifactTreeOnlyOpener } from "@/components/epic-canvas/renderers/use-artifact-link-opener";
import type { SandboxArtifactLink } from "@/lib/sandbox/bridge-host";
import { classifyHref } from "@/markdown/links/classify-href";
import { useMaybeOpenEpicHandle } from "@/providers/use-open-epic-handle";
import { HtmlArtifactLinkContext } from "./html-artifact-link-context";

/**
 * The entry document of an html or canvas artifact. A link to one names its
 * artifact, so it is spelled as a markdown link to that artifact would be: by
 * the folder's `index.md`, which the resolver reads as the folder itself.
 */
const ENTRY_DOCUMENT = /(^|\/)(?:index\.html|canvas\.json)$/u;

/**
 * A separator the frame and the tree read differently. The frame's URL parser
 * reads a backslash as `/` on an https page (Android) and as part of a name on
 * a `traycer-artifact:` page, and reads `%5C` and `%2F` as part of a name; a
 * tree path is decoded once and split at both. So on Android `\x` is read from
 * the root by the frame and from the page's folder by the tree, and on every
 * page `..%2F..%2Fx` walks up in the tree and not in the frame.
 */
const SEPARATOR_READ_OTHERWISE = /\\|%(?:2f|5c)/iu;

/** An href that names an origin: a scheme, or a bare `//authority`. */
const NAMES_ORIGIN = /^(?:[a-z][a-z\d+.-]*:|\/\/)/iu;

const parseUrl = (href: string, base: string | URL | undefined): URL | null => {
  try {
    return new URL(href, base);
  } catch {
    return null;
  }
};

/**
 * The href a page's link is read by. One that names no origin is read as
 * written, `../` and all. One written out in full on the clicked page's own
 * origin is the rooted href it names: an artifact address carries the
 * artifact and mount in its host and the whole tree path in its URL path
 * (`traycer-artifact://artifact-a1--m1/research/index.html`, or on Android
 * `https://artifact-a1--m1.traycer-artifact.invalid/research/index.html`), so
 * cutting `protocol//host` off the href leaves the path from the tree root.
 * The cut is made only where the text begins with exactly the origin the URL
 * parser vetted, then `/`, `?`, `#` or nothing; otherwise the parser and the
 * cut could name different places, so any other spelling of this origin, and
 * any other origin, is `null`. The href holds no backslash: the caller refused
 * it.
 */
function hrefFromTreeRoot(href: string, pageUrl: string): string | null {
  if (!NAMES_ORIGIN.test(href)) return href;
  const page = parseUrl(pageUrl, undefined);
  const target = page === null ? null : parseUrl(href, page);
  if (
    page === null ||
    target === null ||
    target.protocol !== page.protocol ||
    target.host !== page.host
  )
    return null;
  for (const origin of [`${page.protocol}//${page.host}`, `//${page.host}`]) {
    const rest = href.slice(origin.length);
    if (href.startsWith(origin) && /^(?:[/?#]|$)/u.test(rest))
      return rest.startsWith("/") ? rest : `/${rest}`;
  }
  return null;
}

/**
 * The place in the artifacts tree a page's link names: a path, and the folder
 * it is read from. A relative href is read from the page's own folder in the
 * tree. A rooted one (`/research/`), or one written out in full on the page's
 * own origin, is read from the tree's root, as the frame's own URL space reads
 * it. An href that names an artifact of this Epic on disk
 * (`…/epics/<id>/artifacts/…`, by markdown's rule) is read as the tree path it
 * names. The result is `null` for an href that names no place in this Epic's
 * tree: one that names no file, or another Epic's artifact. It is `null` too
 * for an href holding a separator the frame reads differently, whose place the
 * two would disagree on.
 */
function treeLinkFor(
  link: SandboxArtifactLink,
  epicId: string,
): {
  readonly path: string;
  readonly folderChain: readonly string[];
} | null {
  if (SEPARATOR_READ_OTHERWISE.test(link.href)) return null;
  const href = hrefFromTreeRoot(link.href, link.pageUrl);
  if (href === null) return null;
  // A query or fragment addresses a place inside the target; the tile opens
  // the target itself.
  const end = href.search(/[?#]/u);
  const classified = classifyHref(end === -1 ? href : href.slice(0, end));
  if (classified.kind !== "file") return null;
  const path = classified.path.replace(
    ENTRY_DOCUMENT,
    `$1${EPIC_ARTIFACT_INDEX_FILENAME}`,
  );
  const onDisk = artifactLinkPathRootAgnostic(path, null);
  if (onDisk !== null) {
    if (onDisk.epicId !== epicId) return null;
    return { path: onDisk.segments.join("/"), folderChain: [] };
  }
  if (path.startsWith("/")) {
    return { path: path.replace(/^\/+/u, ""), folderChain: [] };
  }
  return { path, folderChain: link.pagePath.split("/").slice(0, -1) };
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
  // A page runs script of its own, so its links reach the artifacts tree and
  // nothing else: no workspace file is raced, as a markdown link's would be,
  // and a path above the tree's root names nothing.
  const openTreePath = useArtifactTreeOnlyOpener({
    epicId: props.epicId,
    viewTabId: props.viewTabId,
  });
  const openPageLink = useCallback(
    (link: SandboxArtifactLink): void => {
      const target = treeLinkFor(link, props.epicId);
      if (target === null) {
        toast("Couldn't open link");
        return;
      }
      openTreePath(target.path, target.folderChain);
    },
    [openTreePath, props.epicId],
  );
  return (
    <HtmlArtifactLinkContext value={openPageLink}>
      {props.children}
    </HtmlArtifactLinkContext>
  );
}
