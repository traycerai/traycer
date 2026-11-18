/**
 * Elements that start and end a spoken paragraph, shared by both read-aloud
 * paths (the rendered DOM and the stopped-boundary projection) so they split
 * the same reply into the same paragraphs.
 */
export const SPOKEN_BLOCK_TAGS: ReadonlyArray<string> = [
  "address",
  "article",
  "aside",
  "blockquote",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "section",
  "summary",
  "table",
  "td",
  "th",
  "tr",
  "ul",
];
