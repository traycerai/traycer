/** Scheme plus trailing :line[:col] only. Workspace/artifact/navigation live in the host surface's link policy. */
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
  // Empty or #heading: default so ProseMirror can place the caret. MarkdownAnchor
  // drops empty href rather than classifying it.
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

// Split :line[:col] on the encoded href so %23 is not a fragment and %3A is
// not a location. Decode only the bare path.
function fileHref(encodedPath: string): ClassifiedHref {
  const match = LINE_SUFFIX_PATTERN.exec(encodedPath);
  const barePath =
    match === null ? encodedPath : encodedPath.slice(0, match.index);
  // Bare or :line with no file: ignore, not default, so preventDefault still
  // runs and the SPA does not unload.
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
 * One decode (`decodeURIComponent`) on a file path's way to a surface policy. Split `:line[:col]` off the encoded href first.
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
