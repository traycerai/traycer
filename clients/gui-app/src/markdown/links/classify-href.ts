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
  // that leave the current document/surface.
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
// `line`/`col`.
function fileHref(path: string): ClassifiedHref {
  const match = LINE_SUFFIX_PATTERN.exec(path);
  if (match === null) {
    // A location-less href with no path is degenerate (nothing to open).
    // `ignore` - not `default` - so the anchor still `preventDefault`s the
    // click rather than letting the browser navigate the bare href and unload
    // the SPA.
    return path.length === 0
      ? { kind: "ignore" }
      : { kind: "file", path, line: null, col: null };
  }
  const barePath = path.slice(0, match.index);
  // A trailing location with no file in front of it (`:99`, `:0`) is degenerate.
  // Reject it here rather than emitting an empty-path file link that a consumer
  // would have to special-case.
  if (barePath.length === 0) return { kind: "ignore" };
  const line = Number.parseInt(match[1], 10);
  // A non-positive line is not a valid 1-based location. Drop the bogus target
  // and open the real file at the top instead of relying on a downstream clamp.
  if (line < 1) return { kind: "file", path: barePath, line: null, col: null };
  // `.at()` is `string | undefined` (the col group is optional), unlike index
  // access which the lib types as a bare `string`.
  const colRaw = match.at(2);
  const col = colRaw === undefined ? null : Number.parseInt(colRaw, 10);
  return { kind: "file", path: barePath, line, col };
}

function fileUrlToPath(href: string): string {
  const withoutScheme = href.replace(/^file:\/\//i, "");
  // `file:///C:/x` → `/C:/x`; drop the leading slash before a drive letter so
  // the host sees a native Windows path.
  const nativePath = /^\/[a-zA-Z]:/.test(withoutScheme)
    ? withoutScheme.slice(1)
    : withoutScheme;
  return decodeFileUrlPath(nativePath);
}

function decodeFileUrlPath(path: string): string {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

function stripFragment(path: string): string {
  const hashIndex = path.indexOf("#");
  return hashIndex === -1 ? path : path.slice(0, hashIndex);
}
