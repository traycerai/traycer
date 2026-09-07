import { defaultUrlTransform } from "react-markdown";

// Remend / Tailmark sentinel for incomplete link destinations mid-stream.
// Must survive urlTransform so the default anchor can strip the dead href.
const INCOMPLETE_LINK_PLACEHOLDER = "streamdown:incomplete-link";

const FILE_URL_PATTERN = /^file:/i;
// Bypass `defaultUrlTransform` for a Windows drive href, including percent-encoded `%5C`. An emptied href navigates to the current document.
const DRIVE_LETTER_PATTERN = /^[a-zA-Z]:(?:[\\/]|%5c)/i;
const ASSISTANT_IMAGE_DATA_PATTERN =
  /^data:image\/(?:png|jpeg|gif|webp|svg\+xml)(?:[;,])/i;

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

export function assistantMarkdownUrlTransform(
  url: string,
  key: string,
): string {
  if (
    key === "src" &&
    (ASSISTANT_IMAGE_DATA_PATTERN.test(url) ||
      FILE_URL_PATTERN.test(url) ||
      DRIVE_LETTER_PATTERN.test(url))
  ) {
    return url;
  }
  return markdownUrlTransform(url, key);
}
