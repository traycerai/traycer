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
import { resolveArtifactRelativeLinkPath } from "@/markdown/links/resolve-artifact-relative-link";
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

/**
 * Whitespace the frame and the tree read differently. The frame's URL parser
 * drops a tab, LF or CR anywhere and a C0 control or space at either end, and
 * keeps all other whitespace; `classifyHref` trims the ends with
 * `String.prototype.trim` and keeps the rest. So `../si<TAB>bling/` is
 * `a/sibling` to the frame and missing in the tree, and `<NBSP>/x` is a name
 * in the page's folder to the frame and the rooted `/x` in the tree. A C0
 * control anywhere is refused, and so is whitespace other than an ASCII space
 * at either end; both drop ASCII spaces at the ends.
 */
// eslint-disable-next-line no-control-regex -- the C0 controls the URL parser drops
const WHITESPACE_READ_OTHERWISE = /[\x00-\x1f]|^\s*[^\S ]|[^\S ]\s*$/u;

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
 * The cut is made only where the text begins with exactly the page's own
 * `protocol//host` (or `//host`), then `/`, `?`, `#` or nothing, which ends
 * the authority on every scheme, so the URL parser reads that same origin;
 * any other spelling of this origin, and any other origin, is `null`. The
 * href holds no backslash: the caller refused it.
 */
function hrefFromTreeRoot(href: string, pageUrl: string): string | null {
  if (!NAMES_ORIGIN.test(href)) return href;
  const page = parseUrl(pageUrl, undefined);
  if (page === null) return null;
  for (const origin of [`${page.protocol}//${page.host}`, `//${page.host}`]) {
    const rest = href.slice(origin.length);
    if (href.startsWith(origin) && /^(?:[/?#]|$)/u.test(rest))
      return rest.startsWith("/") ? rest : `/${rest}`;
  }
  return null;
}

const decodeName = (segment: string): string | null => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
};

/**
 * The path from the tree root the frame names for a link: its own URL parser
 * reads the href against the page's address, which spells the tree path in
 * its URL path one encoded name per segment, and each segment is decoded once,
 * as the tree reads a name. `null` for another origin, and for a segment that
 * does not decode or that decodes to a separator: the address never spells
 * either, and the artifact server refuses a URL that holds one.
 */
function framePathFor(link: SandboxArtifactLink): string | null {
  const page = parseUrl(link.pageUrl, undefined);
  const target = page === null ? null : parseUrl(link.href, page);
  if (
    page === null ||
    target === null ||
    target.protocol !== page.protocol ||
    target.host !== page.host
  )
    return null;
  const names: string[] = [];
  for (const segment of target.pathname.split("/")) {
    const name = decodeName(segment);
    if (name === null || /[\\/]/u.test(name)) return null;
    names.push(name);
  }
  return names
    .join("/")
    .replace(ENTRY_DOCUMENT, `$1${EPIC_ARTIFACT_INDEX_FILENAME}`);
}

/**
 * The place in the artifacts tree a page's link names: a path, and the folder
 * it is read from, or `null` for an href that names no place in this Epic's
 * tree. It is `null` for an href holding a separator or whitespace the frame
 * reads differently, and for one above the tree's root, which is decided from
 * the href as written because the URL parser stops `..` at the root.
 *
 * The last gate, for every route: the place the tree is about to look up must
 * be the place the frame names, or the link opens nothing. The path is read
 * from the href's text by markdown's classifier, which trims, splits off a
 * `:line` suffix and drops a query differently from the frame's URL parser, so
 * `/top ?x=1` (the frame's `/top%20`) or `/release:2026` would otherwise open
 * `top` or `release`.
 */
function treeLinkFor(
  link: SandboxArtifactLink,
  epicId: string,
): {
  readonly path: string;
  readonly folderChain: readonly string[];
} | null {
  if (
    SEPARATOR_READ_OTHERWISE.test(link.href) ||
    WHITESPACE_READ_OTHERWISE.test(link.href)
  )
    return null;
  const target = authoredTreeLinkFor(link);
  if (target === null) return null;
  const lookup = resolveArtifactRelativeLinkPath(
    epicId,
    target.folderChain,
    target.path,
  );
  const framePath = framePathFor(link);
  if (
    lookup === null ||
    framePath === null ||
    lookup !== resolveArtifactRelativeLinkPath(epicId, [], framePath)
  )
    return null;
  return target;
}

/**
 * The place {@link treeLinkFor} reads from the href as written. A relative
 * href is read from the page's own folder in the tree. A rooted one
 * (`/research/`), or one written out in full on the page's own origin, is read
 * from the tree's root, as the frame's own URL space reads it. An href that
 * names no file, or that markdown would read as an artifact's path on disk
 * (`…/epics/<id>/artifacts/…`), is `null`.
 */
function authoredTreeLinkFor(link: SandboxArtifactLink): {
  readonly path: string;
  readonly folderChain: readonly string[];
} | null {
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
  // The frame reads an artifact's path on disk as a path in the tree with
  // `epics/<id>/artifacts` inside it, which the gate would never let match.
  if (artifactLinkPathRootAgnostic(path, null) !== null) return null;
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
