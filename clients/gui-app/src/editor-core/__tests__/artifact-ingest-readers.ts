import { type AnyExtension } from "@tiptap/core";
import { Schema } from "@tiptap/pm/model";
import { MarkdownManager } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { TableKit } from "@tiptap/extension-table";
import Image from "@tiptap/extension-image";
import {
  prosemirrorJSONToYDoc,
  prosemirrorJSONToYXmlFragment,
  yXmlFragmentToProseMirrorRootNode,
} from "@tiptap/y-tiptap";
import * as Y from "yjs";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { artifactDocumentBundle } from "../artifact-document-bundle";

/**
 * The two readers an artifact body is read back with, each as its real
 * ingest: the Markdown parse, then the conversion into an ATTACHED Yjs
 * document, then the stored document read back out of it. A detached fragment
 * reads back empty and proves nothing, so the fragment always belongs to a
 * `Y.Doc` here. The conversion is where the schema drops a node it does not
 * allow, so "kept" means "present in the document read back out of Yjs".
 *
 * - `gui`: the artifact editor's own manager and schema.
 * - `host schema (documentSchema)`: the host's STORAGE step over THIS
 *   install's parse. It parses with a stock `@tiptap/markdown` manager built
 *   from the host converter's options, stores with
 *   `prosemirrorJSONToYDoc(documentSchema, json, "content")` and reads back
 *   with `yXmlFragmentToProseMirrorRootNode(fragment, documentSchema)`
 *   (`markdown-to-yxml-converter.ts` in the internal repo).
 *
 * The limit: this install parses with the PATCHED tiptap 3.30.1
 * (`patches/@tiptap%2Fextension-list@3.30.1.patch`); the host itself parses
 * with the UNPATCHED 3.31.4, whose lexer reads some nested lists differently.
 * `withoutSynthesizedLeadingParagraph` below removes the one difference that
 * can be undone here. Against the host's real converter this reader agreed on
 * 174 of 180 readings (90 container markdowns, each escaped and raw). Two
 * containers (`bullet > ordered, later` and `ordered > bullet, later`) differ
 * in whether a raw image is kept - see `REAL_HOST_DROPS_OSS_READERS_KEEP` in
 * `artifact-image-fallback-differential.test.ts` - and four multiline rows
 * differ only in EMPTY-versus-DROP, never in a keep verdict. The authoritative
 * check against the real host is the internal repo's, not this file's.
 */

export interface IngestReader {
  readonly name: "gui" | "host schema (documentSchema)";
  /** The markdown parsed, before the conversion into Yjs. */
  readonly parse: (markdown: string) => JsonContent;
  /** The document the ingest stores for `markdown`. */
  readonly stored: (markdown: string) => JsonContent;
  /** The fragment the ingest writes, in an attached document. */
  readonly fragment: (markdown: string) => Y.XmlFragment;
}

function isJsonContent(value: unknown): value is JsonContent {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string"
  );
}

export function attachedFragmentOf(
  schema: Schema,
  json: JsonContent,
): Y.XmlFragment {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment("c");
  prosemirrorJSONToYXmlFragment(schema, json, fragment);
  return fragment;
}

export function storedDocumentOf(
  schema: Schema,
  fragment: Y.XmlFragment,
): JsonContent {
  const json: unknown = yXmlFragmentToProseMirrorRootNode(
    fragment,
    schema,
  ).toJSON();
  if (!isJsonContent(json)) {
    throw new Error("The fragment did not convert to a document.");
  }
  return json;
}

function readerOf(
  name: "gui" | "host schema (documentSchema)",
  parse: (markdown: string) => JsonContent,
  schema: Schema,
): IngestReader {
  const fragment = (markdown: string): Y.XmlFragment =>
    attachedFragmentOf(schema, parse(markdown));
  return {
    name,
    parse,
    fragment,
    stored: (markdown) => storedDocumentOf(schema, fragment(markdown)),
  };
}

const guiManager = artifactDocumentBundle.markdownManager;
const hostExtensions: AnyExtension[] = [
  StarterKit,
  TaskList,
  TaskItem,
  TableKit,
  Image,
];
const hostManager = new MarkdownManager({
  extensions: hostExtensions,
  markedOptions: { gfm: true, breaks: true, pedantic: false },
});

/** A schema attribute read as the string or null the copied toDOM wrote. */
function attrText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * A COPY, for test purposes, of the host's storage schema:
 * `packages/common/src/persistence/epic-persistence/document-schema.ts` in
 * the internal repo (`documentSchema`). It is copied rather than imported
 * because this repo cannot import the internal one, and because that import
 * would load a second prosemirror-model. Keep it in step with the original:
 * every content expression, group, attr, atom and inline flag below must match
 * it, since the differential tests read artifact bodies through it.
 */
const HOST_DOCUMENT_SCHEMA = new Schema({
  nodes: {
    doc: {
      content: "block+",
    },
    paragraph: {
      content: "inline*",
      group: "block",
      parseDOM: [{ tag: "p" }],
      toDOM() {
        return ["p", 0];
      },
    },
    text: {
      group: "inline",
    },
    hardBreak: {
      inline: true,
      group: "inline",
      selectable: false,
      parseDOM: [{ tag: "br" }],
      toDOM() {
        return ["br"];
      },
    },
    blockquote: {
      content: "block+",
      group: "block",
      parseDOM: [{ tag: "blockquote" }],
      toDOM() {
        return ["blockquote", 0];
      },
    },
    horizontalRule: {
      group: "block",
      parseDOM: [{ tag: "hr" }],
      toDOM() {
        return ["hr"];
      },
    },
    image: {
      group: "block",
      atom: true,
      draggable: true,
      attrs: {
        src: { default: null },
        alt: { default: null },
        // Collaboration-only lookup key. Portable markdown serializes only
        // src + alt; rendering resolves this hash from the attachment map.
        attachmentHash: { default: null },
        mediaType: { default: null },
      },
      parseDOM: [
        {
          tag: "img[src]",
          getAttrs(dom) {
            const element = dom as Element;
            return {
              src: element.getAttribute("src"),
              alt: element.getAttribute("alt"),
              attachmentHash: null,
              mediaType: null,
            };
          },
        },
      ],
      toDOM(node) {
        return [
          "img",
          { src: attrText(node.attrs.src), alt: attrText(node.attrs.alt) },
        ];
      },
    },
    heading: {
      attrs: { level: { default: null } },
      content: "inline*",
      group: "block",
      defining: true,
      parseDOM: [
        { tag: "h1" },
        { tag: "h2" },
        { tag: "h3" },
        { tag: "h4" },
        { tag: "h5" },
        { tag: "h6" },
      ],
      toDOM(node) {
        return [`h${node.attrs.level}`, 0];
      },
    },
    bulletList: {
      content: "listItem+",
      group: "block",
      parseDOM: [{ tag: "ul" }],
      toDOM() {
        return ["ul", 0];
      },
    },
    orderedList: {
      content: "listItem+",
      group: "block",
      attrs: { start: { default: null } },
      parseDOM: [{ tag: "ol" }],
      toDOM() {
        return ["ol", 0];
      },
    },
    listItem: {
      content: "paragraph block*",
      parseDOM: [{ tag: "li" }],
      toDOM() {
        return ["li", 0];
      },
      defining: true,
    },
    taskList: {
      content: "taskItem+",
      group: "block",
      parseDOM: [{ tag: "ul" }],
      toDOM() {
        return ["ul", 0];
      },
    },
    taskItem: {
      content: "(paragraph|taskList)+",
      attrs: { checked: { default: null } },
      defining: true,
      parseDOM: [{ tag: "li" }],
      toDOM() {
        return ["li", 0];
      },
    },
    codeBlock: {
      content: "text*",
      marks: "",
      group: "block",
      code: true,
      defining: true,
      attrs: { language: { default: null } },
      parseDOM: [{ tag: "pre" }],
      toDOM() {
        return ["pre", ["code", 0]];
      },
    },
    table: {
      content: "tableRow+",
      group: "block",
      tableRole: "table",
      isolating: true,
      parseDOM: [{ tag: "table" }],
      toDOM() {
        return ["table", ["tbody", 0]];
      },
    },
    tableRow: {
      content: "(tableCell|tableHeader)+",
      tableRole: "row",
      parseDOM: [{ tag: "tr" }],
      toDOM() {
        return ["tr", 0];
      },
    },
    tableCell: {
      content: "block+",
      attrs: {
        colspan: { default: null },
        rowspan: { default: null },
        colwidth: { default: null },
      },
      tableRole: "cell",
      isolating: true,
      parseDOM: [{ tag: "td" }],
      toDOM() {
        return ["td", 0];
      },
    },
    tableHeader: {
      content: "block+",
      attrs: {
        colspan: { default: null },
        rowspan: { default: null },
        colwidth: { default: null },
      },
      tableRole: "header_cell",
      isolating: true,
      parseDOM: [{ tag: "th" }],
      toDOM() {
        return ["th", 0];
      },
    },
    mermaidBlock: {
      group: "block",
      atom: true,
      attrs: { code: { default: "" } },
      parseDOM: [{ tag: "pre" }],
      toDOM() {
        return ["pre", ["code"]];
      },
    },
    uiPreviewBlock: {
      group: "block",
      atom: true,
      attrs: {
        htmlContent: { default: "" },
        title: { default: "UI Preview" },
        isCompleteHtml: { default: true },
      },
      parseDOM: [{ tag: "div" }],
      toDOM() {
        return ["div"];
      },
    },
    mention: {
      inline: true,
      group: "inline",
      atom: true,
      attrs: {
        contextType: { default: null },
        id: { default: null },
        epicId: { default: null },
        label: { default: null },
        path: { default: null },
        relPath: { default: null },
        artifactId: { default: null },
        artifactType: { default: null },
      },
      parseDOM: [{ tag: 'span[data-type="mention"]' }],
      toDOM() {
        return ["span", { "data-type": "mention" }];
      },
    },
  },
  marks: {
    bold: {
      parseDOM: [{ tag: "strong" }],
      toDOM() {
        return ["strong", 0];
      },
    },
    italic: {
      parseDOM: [{ tag: "em" }],
      toDOM() {
        return ["em", 0];
      },
    },
    strike: {
      parseDOM: [{ tag: "s" }],
      toDOM() {
        return ["s", 0];
      },
    },
    code: {
      parseDOM: [{ tag: "code" }],
      toDOM() {
        return ["code", 0];
      },
    },
    underline: {
      parseDOM: [{ tag: "u" }],
      toDOM() {
        return ["u", 0];
      },
    },
    link: {
      attrs: {
        href: { default: null },
        target: { default: null },
      },
      inclusive: false,
      parseDOM: [{ tag: "a" }],
      toDOM(mark) {
        return [
          "a",
          {
            href: attrText(mark.attrs.href),
            target: attrText(mark.attrs.target),
          },
          0,
        ];
      },
    },
    // Collaboration-only mark used to anchor artifact comments in the editor.
    // Markdown serialization intentionally ignores this mark so content reads
    // stay clean while preserving the anchored text itself.
    threadAnchor: {
      attrs: {
        threadId: { default: null },
      },
      inclusive: false,
      excludes: "",
      parseDOM: [
        {
          tag: "span[data-thread-id]",
          getAttrs(dom) {
            const element = dom as Element;
            return {
              threadId: element.getAttribute("data-thread-id"),
            };
          },
        },
      ],
      toDOM(mark) {
        return ["span", { "data-thread-id": attrText(mark.attrs.threadId) }, 0];
      },
    },
  },
});

export const guiReader: IngestReader = readerOf(
  "gui",
  (markdown) => guiManager.parse(markdown),
  artifactDocumentBundle.schema,
);

const HOST_FRAGMENT_KEY = "content";

/**
 * The host parses with the unpatched `@tiptap/markdown` 3.31.x; this repo
 * installs 3.30.1 with `patches/@tiptap%2Fextension-list@3.30.1.patch`, which
 * puts an empty paragraph in front of a list item whose first block is not a
 * paragraph (an image, a quote, a list). The unpatched parser does not, so
 * such an item reaches the host's `documentSchema` as `listItem(image)` -
 * which `listItem: "paragraph block*"` refuses, and the host drops the item.
 * This removes the synthesized paragraph so the host reader sees what the
 * host's parser produces. It was checked against the host's own converter on
 * every container in `artifact-image-fallback-differential.test.ts`, for both
 * alts, written escaped and written raw (see that file's header).
 */
function withoutSynthesizedLeadingParagraph(node: JsonContent): JsonContent {
  const content = node.content?.map(withoutSynthesizedLeadingParagraph);
  if (content === undefined) return node;
  const first = content[0];
  const synthesized =
    (node.type === "listItem" || node.type === "taskItem") &&
    content.length > 1 &&
    first.type === "paragraph" &&
    (first.content === undefined || first.content.length === 0);
  return { ...node, content: synthesized ? content.slice(1) : content };
}

function hostFragment(markdown: string): Y.XmlFragment {
  return prosemirrorJSONToYDoc(
    HOST_DOCUMENT_SCHEMA,
    withoutSynthesizedLeadingParagraph(hostManager.parse(markdown)),
    HOST_FRAGMENT_KEY,
  ).getXmlFragment(HOST_FRAGMENT_KEY);
}

export const hostReader: IngestReader = {
  name: "host schema (documentSchema)",
  parse: (markdown) =>
    withoutSynthesizedLeadingParagraph(hostManager.parse(markdown)),
  fragment: hostFragment,
  stored: (markdown) =>
    storedDocumentOf(HOST_DOCUMENT_SCHEMA, hostFragment(markdown)),
};

export const READERS: readonly IngestReader[] = [guiReader, hostReader];

/** The images a document holds, in document order. */
export function imagesOf(node: JsonContent): JsonContent[] {
  return (node.type === "image" ? [node] : []).concat(
    (node.content ?? []).flatMap(imagesOf),
  );
}

/** `{alt, src}` of each image a document holds. */
export function imageAttrsOf(
  node: JsonContent,
): { alt: unknown; src: unknown }[] {
  return imagesOf(node).map((image) => ({
    alt: image.attrs?.alt,
    src: image.attrs?.src,
  }));
}

/** The document's only block is one image (bare or alone in a paragraph). */
export function onlyImageOf(
  doc: JsonContent,
): { alt: unknown; src: unknown } | null {
  const blocks = doc.content ?? [];
  const only = blocks.length === 1 ? blocks[0] : undefined;
  if (only === undefined) return null;
  const inner =
    only.type === "paragraph" && only.content?.length === 1
      ? only.content[0]
      : only;
  if (inner.type !== "image") return null;
  return { alt: inner.attrs?.alt, src: inner.attrs?.src };
}

/** The text a document holds, depth first, one string per text node. */
export function textsOf(node: JsonContent): string[] {
  return (node.type === "text" ? [node.text ?? ""] : []).concat(
    (node.content ?? []).flatMap(textsOf),
  );
}
