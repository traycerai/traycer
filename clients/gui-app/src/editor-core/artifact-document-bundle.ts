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
import { yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap";
import { createLowlight, common } from "lowlight";
import type * as Y from "yjs";
import { createIsolatedMarked } from "@/lib/markdown/isolated-marked";
import { MermaidNode } from "./nodes/mermaid/mermaid-node";
import { WireframeNode } from "./nodes/wireframe/wireframe-node";
import { ThreadAnchor } from "./extensions/thread-anchor";
import { ArtifactImageNode } from "./nodes/image/artifact-image-node";
import { ArtifactCodeBlock } from "./nodes/code-block/artifact-code-block";

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

/**
 * The Markdown extension configured with its own private `marked`.
 *
 * `@tiptap/markdown` registers one tokenizer per extension into whatever
 * `marked` it is given and never unregisters them, and its default is the
 * module-level singleton - so every editor built on the bare extension stayed
 * reachable for the life of the window (see `createIsolatedMarked`). Anything
 * that creates an editor or a manager must call this and get a FRESH instance;
 * the shared `extensions` array below is a schema template, not an editor
 * configuration.
 */
export function createArtifactMarkdownExtension(): AnyExtension {
  return Markdown.configure({ marked: createIsolatedMarked() });
}

const extensions: AnyExtension[] = [
  StarterKit.configure({
    undoRedo: false,
    codeBlock: false,
    link: false,
  }),
  // Contributes no schema. Present so the template lists the whole document
  // bundle; editors swap it for `createArtifactMarkdownExtension()`.
  Markdown,
  artifactLinkExtension,
  TaskList,
  TaskItem.configure({ nested: true }),
  ArtifactImageNode,
  Table.configure({ resizable: true }),
  TableRow,
  TableHeader,
  TableCell,
  MermaidNode,
  WireframeNode,
  ArtifactCodeBlock.configure({ lowlight }),
  // Inline mark anchoring artifact comment threads. It belongs in the shared
  // document schema so editor and export serialization cannot drift.
  ThreadAnchor,
];

const schema = getSchema(extensions);
// One long-lived manager for export/import; its private `marked` keeps its
// tokenizer registrations off the module singleton like the editors do.
const markdownManager = new MarkdownManager({
  extensions,
  marked: createIsolatedMarked(),
});

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
