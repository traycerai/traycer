import { mergeAttributes, Node } from "@tiptap/core";
import type { MarkdownToken, MarkdownParseHelpers } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { MermaidNodeView } from "./mermaid-node-view";
import {
  matchesFenceLanguage,
  renderFencedBlock,
} from "../shared/markdown-fence-serializer";

const FENCE_LANGUAGE = "mermaid";

export interface MermaidAttrs {
  readonly code: string;
}

/**
 * Mermaid atom block. Persisted as a mermaid fence; HTML paste uses `data-type="mermaid-block"`. Atom, isolating, defining, draggable.
 */
export const MermaidNode = Node.create({
  name: "mermaidBlock",

  group: "block",
  atom: true,
  isolating: true,
  defining: true,
  draggable: false,
  selectable: true,

  addAttributes() {
    return {
      code: {
        default: "",
        parseHTML: (element): string => {
          const dataCode = element.getAttribute("data-code");
          if (dataCode !== null) return dataCode;
          // Fallback - read body text for the legacy `<pre><code
          // class="language-mermaid">` shape emitted by server-side
          // markdown renderers.
          const codeEl = element.querySelector("code");
          // `textContent` is typed as non-null here - `element` is an
          // `HTMLElement` and for HTML elements the property is always a
          // string. Null-checking it would be dead code.
          if (codeEl !== null) return codeEl.textContent;
          return element.textContent;
        },
        renderHTML: (attrs) => {
          const value = (attrs as { code: string | undefined }).code;
          return { "data-code": value === undefined ? "" : value };
        },
      },
    };
  },

  parseHTML() {
    return [
      { tag: 'div[data-type="mermaid-block"]' },
      {
        tag: "pre",
        getAttrs: (node): false | Record<string, string> => {
          if (!(node instanceof HTMLElement)) return false;
          const codeEl = node.querySelector("code");
          if (codeEl === null) return false;
          const cls = codeEl.getAttribute("class") ?? "";
          if (!/language-mermaid\b/.test(cls)) return false;
          return { "data-code": codeEl.textContent };
        },
      },
      { tag: "traycer-mermaid" },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const rawCode = (node.attrs as { code: string | undefined }).code;
    const code = rawCode === undefined ? "" : rawCode;
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-type": "mermaid-block",
        "data-code": code,
      }),
      ["pre", {}, ["code", { class: `language-${FENCE_LANGUAGE}` }, code]],
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(MermaidNodeView, {
      // CodeMirror in the NodeView is not a doc mutation. Stop ProseMirror
      // from treating its focus/input as one.
      stopEvent: () => true,
      // Let the NodeView handle its own DOM updates; ProseMirror's
      // attribute-driven re-render through React is the source of truth.
      ignoreMutation: () => true,
    });
  },

  markdownTokenName: "code",

  parseMarkdown: (token: MarkdownToken, helpers: MarkdownParseHelpers) => {
    if (!matchesFenceLanguage(token, FENCE_LANGUAGE)) return [];
    const text = typeof token.text === "string" ? token.text : "";
    return helpers.createNode("mermaidBlock", { code: text }, []);
  },

  renderMarkdown: (node): string => {
    const attrs = (node as { attrs?: { code?: string } }).attrs;
    const code = attrs && typeof attrs.code === "string" ? attrs.code : "";
    return renderFencedBlock(FENCE_LANGUAGE, code);
  },
});
