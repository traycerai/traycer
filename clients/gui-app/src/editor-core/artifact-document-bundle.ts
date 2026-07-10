import { getSchema, type AnyExtension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";
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

const extensions: AnyExtension[] = [
  StarterKit.configure({
    undoRedo: false,
    codeBlock: false,
  }),
  Markdown,
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

interface ArtifactMarkdownJsonContent {
  readonly type: string;
  readonly attrs: Readonly<Record<string, unknown>> | undefined;
  readonly content: ArtifactMarkdownJsonContent[] | undefined;
  readonly marks:
    | Array<{
        readonly type: string;
        readonly attrs: Readonly<Record<string, unknown>>;
      }>
    | undefined;
  readonly text: string | undefined;
}

function proseMirrorNodeToMarkdownJson(
  node: ProseMirrorNode,
): ArtifactMarkdownJsonContent {
  return {
    type: node.type.name,
    attrs: Object.keys(node.attrs).length > 0 ? node.attrs : undefined,
    content:
      node.childCount > 0
        ? node.content.content.map(proseMirrorNodeToMarkdownJson)
        : undefined,
    marks:
      node.marks.length > 0
        ? node.marks.map((mark) => ({
            type: mark.type.name,
            attrs: mark.attrs,
          }))
        : undefined,
    text: node.text ?? undefined,
  };
}

export const artifactDocumentBundle = {
  extensions,
  schema,
  markdownManager,
  markdown: {
    serialize(fragment: Y.XmlFragment): string {
      const root = yXmlFragmentToProseMirrorRootNode(fragment, schema);
      return markdownManager.serialize(proseMirrorNodeToMarkdownJson(root));
    },
  },
};
