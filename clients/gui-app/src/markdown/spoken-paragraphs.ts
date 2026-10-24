import { createLexSession } from "@tailmark/core";
import { remarkDisableIndentedCode } from "@tailmark/react";
import type { Element, ElementContent, Root, RootContent } from "hast";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import {
  TRAYCER_AGENT_TAG,
  TRAYCER_MERMAID_TAG,
  TRAYCER_WIREFRAME_TAG,
} from "./plugins/const";
import { PRODUCT_REHYPE_PLUGINS } from "./plugins/product-rehype-plugins";
import {
  isUuidReferenceCandidate,
  rehypeTraycerAgentReferences,
} from "./plugins/rehype-traycer-agent-references";
import { extendAssistantImageSanitizeSchema } from "./plugins/rehype-sanitize-schema";
import { parseTraycerNextStepsMarkdown } from "./traycer-next-steps";

/** The label an agent or role reference shows, or `null` when unresolved. */
export type AgentLabelResolver = (referenceId: string) => string | null;

/**
 * A reply's paragraphs, projected from its markdown for a row that does not
 * draw the reply itself - the stopped-boundary row, whose reply sits on
 * earlier rows of the turn that the virtualized transcript may not have
 * mounted. Every other row reads its own rendered DOM
 * (`spokenParagraphsFromRenderedReply`).
 *
 * It follows the render step by step so the two agree: `TextSegment` splits
 * next-step blocks out with `parseTraycerNextStepsMarkdown` and shows their
 * prose and option labels; Tailmark lexes each markdown part into top-level
 * blocks and parses each block on its own (remark with GFM and indented code
 * disabled, rehype-raw, the product plugins and the agent-reference plugin
 * `AgentReferenceMarkdown` adds, then the assistant sanitize schema); an agent
 * or role reference reads the chip's label, or the id as written when it
 * resolves to nothing. Code blocks, diagrams and images are not read; raw
 * HTML reads whatever the sanitized render keeps, and a closed `<details>`
 * only its summary.
 */
export function spokenParagraphsFromReplyMarkdown(
  markdowns: ReadonlyArray<string>,
  resolveAgentLabel: AgentLabelResolver,
): string[] {
  return markdowns.flatMap((markdown) =>
    parseTraycerNextStepsMarkdown(markdown, false).flatMap((part) =>
      part.kind === "markdown"
        ? spokenMarkdown(part.markdown, resolveAgentLabel)
        : [
            ...spokenMarkdown(part.prose, resolveAgentLabel),
            ...part.options.map((option) => option.prompt),
          ],
    ),
  );
}

const SPEECH_SANITIZE_SCHEMA =
  extendAssistantImageSanitizeSchema(defaultSchema);

const SKIPPED_ELEMENTS: ReadonlySet<string> = new Set([
  "img",
  "pre",
  TRAYCER_MERMAID_TAG,
  TRAYCER_WIREFRAME_TAG,
]);

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

// `StreamingMarkdown`'s per-block parse as `TraycerMarkdown` configures it.
const BLOCK_PROCESSOR = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkDisableIndentedCode)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(PRODUCT_REHYPE_PLUGINS)
  .use(rehypeTraycerAgentReferences)
  .use(rehypeSanitize, SPEECH_SANITIZE_SCHEMA)
  .freeze();

function spokenMarkdown(
  markdown: string,
  resolveAgentLabel: AgentLabelResolver,
): string[] {
  if (markdown.length === 0) return [];
  // Each block is its own document, as the render draws it: a reference
  // definition in one block does not resolve a link in another.
  return createLexSession()
    .update(markdown)
    .blocks.flatMap((block) => {
      const tree: Root = BLOCK_PROCESSOR.runSync(
        BLOCK_PROCESSOR.parse(block.raw),
      );
      return spokenParagraphs(tree, resolveAgentLabel);
    });
}

function textOf(nodes: ReadonlyArray<RootContent | ElementContent>): string {
  return nodes
    .map((node) => {
      if (node.type === "text") return node.value;
      if (node.type === "element") return textOf(node.children);
      return "";
    })
    .join("");
}

function spokenParagraphs(
  tree: Root,
  resolveAgentLabel: AgentLabelResolver,
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
      if (node.tagName === "br") {
        current += " ";
        continue;
      }
      // The chip in place of an agent or role id, as `AgentReferenceMarkdown`
      // draws it for a reference in prose and for one in inline code.
      const referenceId = agentReferenceId(node.tagName, node.properties, node);
      if (referenceId !== null) {
        current += resolveAgentLabel(referenceId) ?? referenceId;
        continue;
      }
      const block = BLOCK_ELEMENTS.has(node.tagName);
      if (block) flush();
      walk(shownChildren(node));
      if (block) flush();
    }
  };
  walk(tree.children);
  flush();
  return paragraphs;
}

/**
 * The children the render shows: a `<details>` written without `open` shows
 * only its summary. The rows this path stands in for may be unmounted, and a
 * toggle there does not survive it, so the written state is what they draw.
 */
function shownChildren(node: Element): ReadonlyArray<ElementContent> {
  if (node.tagName !== "details" || node.properties.open === true) {
    return node.children;
  }
  const summary = node.children.find(
    (child) => child.type === "element" && child.tagName === "summary",
  );
  return summary === undefined ? [] : [summary];
}

function agentReferenceId(
  tagName: string,
  properties: Readonly<Record<string, unknown>>,
  node: { readonly children: ReadonlyArray<ElementContent> },
): string | null {
  if (tagName === TRAYCER_AGENT_TAG) {
    const id = properties["data-agent-id"];
    return typeof id === "string" ? id : null;
  }
  if (tagName !== "code" || properties.className !== undefined) return null;
  const text = textOf(node.children).trim();
  return isUuidReferenceCandidate(text) ? text : null;
}
