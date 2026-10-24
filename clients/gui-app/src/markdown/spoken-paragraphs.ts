import { remarkDisableIndentedCode } from "@tailmark/react";
import type { Element, ElementContent, Root, RootContent } from "hast";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { extendAssistantImageSanitizeSchema } from "./plugins/rehype-sanitize-schema";

/**
 * A reply's prose, as the paragraphs to read aloud.
 *
 * SPEECH READS THE RENDERED REPLY. The text comes from the same parse the
 * message renderer runs (Tailmark's `StreamingMarkdown`): remark with GFM and
 * indented code disabled, then rehype-raw, then the assistant sanitize schema.
 * Raw HTML is therefore read by a real HTML parser - quoted `>` in attributes,
 * comments and CDATA, `/>` on non-void tags, raw-text elements ending at
 * their first close tag, elements left open closing with their container -
 * rather than by a scan that keeps drifting from what the reader sees.
 *
 * WHAT IS NOT READ, even when it is on screen:
 * - code blocks (`pre`) and images; inline code is read, as it is prose;
 * - any element written as raw HTML, with everything inside it - an author's
 *   `<span>`, `<div>` or `<details>` is markup, not the reply's prose. An
 *   unknown tag the sanitizer unwraps (`Vec<String>`) leaves its text in the
 *   paragraph, where it is read;
 * - the bodies of `style` and the other raw-text elements, which the
 *   renderer would otherwise show as text; `script` the sanitizer drops.
 * Link targets and definitions never reach the tree as text.
 */
export function markdownToSpokenParagraphs(markdown: string): string[] {
  const rawHtmlRanges: Array<readonly [number, number]> = [];
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkDisableIndentedCode)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(() => (tree: Root) => {
      recordRawHtmlRanges(tree, rawHtmlRanges);
    })
    .use(rehypeRaw)
    .use(rehypeSanitize, SPEECH_SANITIZE_SCHEMA);
  const tree = processor.runSync(processor.parse(markdown));
  return spokenParagraphs(tree, rawHtmlRanges);
}

/** Raw-text elements: their contents are never prose. */
const NON_PROSE_ELEMENTS = [
  "iframe",
  "noembed",
  "noframes",
  "noscript",
  "plaintext",
  "style",
  "template",
  "textarea",
  "title",
  "xmp",
];

const SPEECH_SANITIZE_SCHEMA = extendAssistantImageSanitizeSchema({
  ...defaultSchema,
  strip: [...(defaultSchema.strip ?? []), ...NON_PROSE_ELEMENTS],
});

const SKIPPED_ELEMENTS: ReadonlySet<string> = new Set(["img", "pre"]);

/** Elements that start and end a spoken paragraph. */
const BLOCK_ELEMENTS: ReadonlySet<string> = new Set([
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
]);

/**
 * The source ranges of raw HTML, read from the `raw` nodes remark-rehype
 * leaves for rehype-raw. An element rehype-raw builds from them starts inside
 * one; an element built from markdown never does.
 */
function recordRawHtmlRanges(
  tree: Root,
  ranges: Array<readonly [number, number]>,
): void {
  visit(tree, (node) => {
    if (node.type !== "raw") return;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start !== undefined && end !== undefined) ranges.push([start, end]);
  });
}

function writtenAsRawHtml(
  element: Element,
  ranges: ReadonlyArray<readonly [number, number]>,
): boolean {
  const offset = element.position?.start.offset;
  if (offset === undefined) return false;
  // `ranges` is in document order and never overlaps.
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const [start, end] = ranges[middle];
    if (offset < start) high = middle - 1;
    else if (offset >= end) low = middle + 1;
    else return true;
  }
  return false;
}

function spokenParagraphs(
  tree: Root,
  rawHtmlRanges: ReadonlyArray<readonly [number, number]>,
): string[] {
  const paragraphs: string[] = [];
  let current = "";
  const flush = (): void => {
    const paragraph = current.replace(/\s+/g, " ").trim();
    if (paragraph.length > 0) paragraphs.push(paragraph);
    current = "";
  };
  const walk = (nodes: ReadonlyArray<RootContent | ElementContent>): void => {
    for (const node of nodes) {
      if (node.type === "text") {
        current += node.value;
        continue;
      }
      if (node.type !== "element") continue;
      if (SKIPPED_ELEMENTS.has(node.tagName)) continue;
      if (writtenAsRawHtml(node, rawHtmlRanges)) continue;
      if (node.tagName === "br") {
        current += " ";
        continue;
      }
      const block = BLOCK_ELEMENTS.has(node.tagName);
      if (block) flush();
      walk(node.children);
      if (block) flush();
    }
  };
  walk(tree.children);
  flush();
  return paragraphs;
}
