import { defaultUrlTransform } from "react-markdown";

// Remend / Tailmark sentinel for incomplete link destinations mid-stream.
// Must survive urlTransform so the default anchor can strip the dead href.
const INCOMPLETE_LINK_PLACEHOLDER = "streamdown:incomplete-link";

const FILE_URL_PATTERN = /^file:/i;
// A bare Windows drive href (`C:\…` or `C:/…`). `defaultUrlTransform` reads the
// `C:` as an unsafe scheme and empties the href, so the click becomes a no-op;
// bypass it the same way as `file:` so the drive path reaches `classifyHref`,
// which routes a single-letter scheme as a native file path. The sanitize layer
// runs earlier in the pipeline and must allow the drive scheme too - see the
// single-letter schemes added to `href` in `rehype-sanitize-schema.ts`.
//
// `%5C` matters as much as the literal separators: the markdown parser
// percent-encodes a link destination before any transform sees it, so the
// NATIVE form an agent writes on Windows (`C:\Users\…`) arrives here as
// `C:%5CUsers%5C…`. Matching only the literal `\` let that fall through to
// `defaultUrlTransform`, which emptied the href - and an empty href is a real
// navigation to the current document, i.e. a full renderer reload.
const DRIVE_LETTER_PATTERN = /^[a-zA-Z]:(?:[\\/]|%5c)/i;

export function markdownUrlTransform(url: string, key: string): string {
  if (url === INCOMPLETE_LINK_PLACEHOLDER) return url;
  if (
    key === "href" &&
    (FILE_URL_PATTERN.test(url) || DRIVE_LETTER_PATTERN.test(url))
  ) {
    return url;
  }
  return defaultUrlTransform(url);
}
