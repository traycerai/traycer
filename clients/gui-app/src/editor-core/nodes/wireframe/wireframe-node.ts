import { mergeAttributes, Node } from "@tiptap/core";
import type { MarkdownToken, MarkdownParseHelpers } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { WireframeNodeView } from "./wireframe-node-view";
import {
  matchesFenceLanguage,
  renderFencedBlock,
} from "../shared/markdown-fence-serializer";

const FENCE_LANGUAGE = "wireframe";
const DEFAULT_TITLE = "UI Preview";

export interface WireframeAttrs {
  readonly htmlContent: string;
  readonly title: string;
}

/**
 * Atom block that renders a sandboxed HTML preview. Persisted as a
 * ` ```wireframe ` fence in markdown, matching the convention used by
 * the legacy Traycer views editor. HTML output uses a `<div
 * data-type="ui-preview-block">` wrapper so cross-editor paste round-
 * trips.
 */
export const WireframeNode = Node.create({
  name: "uiPreviewBlock",

  group: "block",
  atom: true,
  isolating: true,
  defining: true,
  draggable: false,
  selectable: true,

  addAttributes() {
    return {
      htmlContent: {
        default: "",
        parseHTML: (element): string => {
          const data = element.getAttribute("data-html");
          if (data !== null) return data;
          const codeEl = element.querySelector("code");
          // `textContent` is non-null on `HTMLElement`. See mermaid-node.ts.
          if (codeEl !== null) return codeEl.textContent;
          return element.textContent;
        },
        renderHTML: (attrs) => {
          const value = (attrs as { htmlContent: string | undefined })
            .htmlContent;
          return { "data-html": value === undefined ? "" : value };
        },
      },
      title: {
        default: DEFAULT_TITLE,
        parseHTML: (element): string => {
          const raw = element.getAttribute("data-title");
          return raw === null ? DEFAULT_TITLE : raw;
        },
        renderHTML: (attrs) => {
          const raw = (attrs as { title: string | undefined }).title;
          return { "data-title": raw === undefined ? DEFAULT_TITLE : raw };
        },
      },
    };
  },

  parseHTML() {
    return [
      { tag: 'div[data-type="ui-preview-block"]' },
      {
        tag: "pre",
        getAttrs: (node): false | Record<string, string> => {
          if (!(node instanceof HTMLElement)) return false;
          const codeEl = node.querySelector("code");
          if (codeEl === null) return false;
          const cls = codeEl.getAttribute("class") ?? "";
          if (!/language-wireframe\b/.test(cls)) return false;
          return { "data-html": codeEl.textContent };
        },
      },
      { tag: "traycer-ui-preview" },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const rawHtml = (node.attrs as { htmlContent: string | undefined })
      .htmlContent;
    const html = rawHtml === undefined ? "" : rawHtml;
    const rawTitle = (node.attrs as { title: string | undefined }).title;
    const title = rawTitle === undefined ? DEFAULT_TITLE : rawTitle;
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-type": "ui-preview-block",
        "data-html": html,
        "data-title": title,
      }),
      ["pre", {}, ["code", { class: `language-${FENCE_LANGUAGE}` }, html]],
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(WireframeNodeView, {
      stopEvent: () => true,
      ignoreMutation: () => true,
    });
  },

  markdownTokenName: "code",

  parseMarkdown: (token: MarkdownToken, helpers: MarkdownParseHelpers) => {
    if (!matchesFenceLanguage(token, FENCE_LANGUAGE)) return [];
    const text = typeof token.text === "string" ? token.text : "";
    return helpers.createNode(
      "uiPreviewBlock",
      { htmlContent: text, title: DEFAULT_TITLE },
      [],
    );
  },

  renderMarkdown: (node): string => {
    const attrs = (node as { attrs?: { htmlContent?: string } }).attrs;
    const html =
      attrs && typeof attrs.htmlContent === "string" ? attrs.htmlContent : "";
    return renderFencedBlock(FENCE_LANGUAGE, html);
  },
});
