import { defaultUrlTransform } from "react-markdown";

const FILE_URL_PATTERN = /^file:/i;
// A bare Windows drive href (`C:\…` or `C:/…`). `defaultUrlTransform` reads the
// `C:` as an unsafe scheme and empties the href, so the click becomes a no-op;
// bypass it the same way as `file:` so the drive path reaches `classifyHref`,
// which routes a single-letter scheme as a native file path. The sanitize layer
// runs earlier in the pipeline and must allow the drive scheme too — see the
// single-letter schemes added to `href` in `rehype-sanitize-schema.ts`.
const DRIVE_LETTER_PATTERN = /^[a-zA-Z]:[\\/]/;

export function markdownUrlTransform(url: string, key: string): string {
  if (
    key === "href" &&
    (FILE_URL_PATTERN.test(url) || DRIVE_LETTER_PATTERN.test(url))
  ) {
    return url;
  }
  return defaultUrlTransform(url);
}
