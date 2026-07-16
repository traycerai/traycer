import {
  getSchema,
  mergeAttributes,
  type AnyExtension,
  type JSONContent,
} from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import { Markdown, MarkdownManager } from "@tiptap/markdown";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import {
  Table,
  TableRow,
  TableHeader,
  TableCell,
} from "@tiptap/extension-table";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap";
import { createLowlight, common } from "lowlight";
import type * as Y from "yjs";
import { MermaidNode } from "./nodes/mermaid/mermaid-node";
import { WireframeNode } from "./nodes/wireframe/wireframe-node";
import { ThreadAnchor } from "./extensions/thread-anchor";

const lowlight = createLowlight(common);

export const artifactLinkExtension = Link.extend({
  renderHTML({ HTMLAttributes }) {
    const rawHref =
      typeof HTMLAttributes.href === "string" ? HTMLAttributes.href : "";
    const normalizedHref = rawHref.trim();
    const viewer = this.editor?.isEditable === false;
    return [
      "a",
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        // Chromium's middle-click navigation cannot be reliably cancelled at
        // auxclick time. The mark remains the URL source of truth. Viewer hash
        // links retain native navigation; editable links use caret ownership
        // and have no focusable descendant inside the contentEditable root.
        href: viewer && normalizedHref.startsWith("#") ? normalizedHref : null,
        "data-link-href": rawHref,
        role: "link",
        tabindex: viewer ? "0" : null,
      }),
      0,
    ];
  },
}).configure({
  openOnClick: false,
  autolink: true,
  linkOnPaste: true,
  HTMLAttributes: {
    target: null,
    rel: null,
  },
});

const extensions: AnyExtension[] = [
  StarterKit.configure({
    undoRedo: false,
    codeBlock: false,
    link: false,
  }),
  Markdown,
  artifactLinkExtension,
  TaskList,
  TaskItem.configure({ nested: true }),
  Table.configure({ resizable: true }),
  TableRow,
  TableHeader,
  TableCell,
  MermaidNode,
  WireframeNode,
  CodeBlockLowlight.configure({ lowlight }),
  // Inline mark anchoring artifact comment threads. It belongs in the shared
  // document schema so editor and export serialization cannot drift.
  ThreadAnchor,
];

const schema = getSchema(extensions);
const markdownManager = new MarkdownManager({ extensions });

function isJsonContent(value: unknown): value is JSONContent {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return false;
  }
  if (typeof value.type !== "string") return false;
  if (!("content" in value) || value.content === undefined) return true;
  return Array.isArray(value.content) && value.content.every(isJsonContent);
}

export const artifactDocumentBundle = {
  extensions,
  schema,
  markdownManager,
  markdown: {
    serialize(fragment: Y.XmlFragment): string {
      const root = yXmlFragmentToProseMirrorRootNode(fragment, schema);
      const json: unknown = root.toJSON();
      if (!isJsonContent(json)) {
        throw new Error("Artifact document could not be serialized.");
      }
      return markdownManager.serialize(json);
    },
  },
};
