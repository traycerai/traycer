/**
 * Surface-agnostic classification of a rendered markdown anchor's `href`.
 *
 * This only understands URL *scheme* plus a trailing editor-style
 * `:line[:col]` location. All Traycer-domain knowledge (workspace resolution,
 * artifact paths, navigation) lives in the host surface's link policy, so this
 * stays reusable across every markdown surface.
 */
export type ClassifiedHref =
  | { readonly kind: "external"; readonly url: string }
  | {
      readonly kind: "file";
      readonly path: string;
      readonly line: number | null;
      readonly col: number | null;
    }
  | { readonly kind: "default" }
  | { readonly kind: "ignore" };

// A URL scheme per RFC 3986: a letter followed by letters/digits/`+`/`-`/`.`,
// terminated by `:`. Used to tell schemed links apart from filesystem paths
// without constructing a `URL` (relative/rooted paths would throw).
const SCHEME_PATTERN = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

// Keep this in sync with desktop's safelyOpenExternal allow-list.
const EXTERNAL_SCHEMES = new Set(["http", "https", "mailto"]);

export function classifyHref(rawHref: string): ClassifiedHref {
  const href = rawHref.trim();
  // Empty or in-page anchors (`#heading`): this renderer only routes clicks
  // that leave the current document/surface. `default` means "not ours" - the
  // editor surface relies on it to let ProseMirror place the caret. Rendered
  // anchors must never carry an empty href in the first place (it resolves to
  // the current document, so a click reloads the SPA); `MarkdownAnchor` drops
  // the attribute rather than classifying its way out of it.
  if (href.length === 0 || href.startsWith("#")) return { kind: "default" };

  const schemeMatch = SCHEME_PATTERN.exec(href);
  if (schemeMatch === null) {
    // No scheme - a relative or rooted filesystem path.
    return fileHref(stripFragment(href));
  }

  const scheme = schemeMatch[1].toLowerCase();
  // A single-letter "scheme" is a Windows drive (`C:\Users\...`), not a URL.
  if (scheme.length === 1) return fileHref(stripFragment(href));
  if (scheme === "file") {
    return fileHref(stripFragment(fileUrlToPath(href)));
  }
  if (EXTERNAL_SCHEMES.has(scheme)) return { kind: "external", url: href };
  return { kind: "ignore" };
}

// A trailing editor-style location suffix: `:1177` (line) or `:1177:5`
// (line:col), anchored to the end so a drive colon (`C:\…`) or a mid-path / host
// port (`http://host:8080`, which never reaches this branch) is untouched.
const LINE_SUFFIX_PATTERN = /:(\d+)(?::(\d+))?$/;

// Builds a `file` classification, splitting off a trailing `:line[:col]` target
// so the bare path is what resolves to a file and the location travels in
// `line`/`col`. The split runs on the ENCODED href (so a `%23` in a filename is
// never mistaken for a fragment and a `%3A` never for a location), and only the
// resulting bare path is decoded.
function fileHref(encodedPath: string): ClassifiedHref {
  const match = LINE_SUFFIX_PATTERN.exec(encodedPath);
  const barePath =
    match === null ? encodedPath : encodedPath.slice(0, match.index);
  // Nothing to open: either a bare href with no path at all, or a trailing
  // location with no file in front of it (`:99`, `:0`). `ignore` - not
  // `default` - so the anchor still `preventDefault`s the click rather than
  // letting the browser navigate the href and unload the SPA.
  if (barePath.length === 0) return { kind: "ignore" };
  const path = decodePercentEncoding(barePath);
  if (match === null) return { kind: "file", path, line: null, col: null };
  const line = Number.parseInt(match[1], 10);
  // A non-positive line is not a valid 1-based location. Drop the bogus target
  // and open the real file at the top instead of relying on a downstream clamp.
  if (line < 1) return { kind: "file", path, line: null, col: null };
  // `.at()` is `string | undefined` (the col group is optional), unlike index
  // access which the lib types as a bare `string`.
  const colRaw = match.at(2);
  const col = colRaw === undefined ? null : Number.parseInt(colRaw, 10);
  return { kind: "file", path, line, col };
}

function fileUrlToPath(href: string): string {
  const withoutScheme = href.replace(/^file:\/\//i, "");
  // `file:///C:/x` → `/C:/x`; drop the leading slash before a drive letter so
  // the host sees a native Windows path.
  return /^\/[a-zA-Z]:/.test(withoutScheme)
    ? withoutScheme.slice(1)
    : withoutScheme;
}

/**
 * Every href reaching this module is percent-encoded - the markdown parser
 * normalizes a link destination on the way to the DOM, so a path with a space
 * or a Windows separator arrives as `…Traycer%20Dev%5Crepo…`. The surface
 * policies resolve against a real filesystem, so they need the native form.
 *
 * This is the ONE decode on a file path's way to a surface policy - consumers
 * (`resolveArtifactRelativeLinkPath`, the workspace-file candidates) take the
 * native path as given. A second decode downstream would eat a literal percent
 * escape in a real name (`my%20folder` authored as `my%2520folder`) and could
 * turn `%252E%252E` into a `..` that walks out of the linked folder.
 *
 * `decodeURIComponent`, not `decodeURI`: the latter preserves the reserved set,
 * so a filename's `%23` or `%3A` would reach the filesystem literally. Splitting
 * the `:line[:col]` suffix off the ENCODED href (see {@link fileHref}) is what
 * keeps those from being read as a fragment or a location in the first place.
 */
function decodePercentEncoding(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function stripFragment(path: string): string {
  const hashIndex = path.indexOf("#");
  return hashIndex === -1 ? path : path.slice(0, hashIndex);
}
