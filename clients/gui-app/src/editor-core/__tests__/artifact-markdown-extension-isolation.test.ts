import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { marked } from "marked";
import type { AnyExtension } from "@tiptap/core";
import type { CollabUser } from "../awareness/derive-collab-user";
import {
  artifactDocumentBundle,
  createArtifactMarkdownExtension,
} from "../artifact-document-bundle";
import {
  buildArtifactExtensions,
  type BuildArtifactExtensionsParams,
} from "../extensions/build-artifact-extensions";

/**
 * `AnyExtension.options` is `any`; read the one option under test through a
 * narrowing so the assertions compare real values rather than `any`.
 */
function markedOptionOf(extension: AnyExtension): unknown {
  const options: unknown = extension.options;
  if (typeof options !== "object" || options === null) return undefined;
  return "marked" in options ? options.marked : undefined;
}

function buildParams(): BuildArtifactExtensionsParams {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment("default");
  const awareness = new Awareness(doc);
  const user: CollabUser = { name: "t", color: "#000" };
  return {
    doc,
    fragment,
    awareness,
    user,
    onCommentShortcut: null,
    placeholderText: "Start writing…",
    titlePlaceholderText: "Untitled",
  };
}

describe("createArtifactMarkdownExtension", () => {
  it("returns distinct extensions with distinct private marked instances, never the real singleton", () => {
    const first = createArtifactMarkdownExtension();
    const second = createArtifactMarkdownExtension();

    expect(first).not.toBe(second);
    expect(markedOptionOf(first)).toBeDefined();
    expect(markedOptionOf(first)).not.toBe(markedOptionOf(second));
    expect(markedOptionOf(first)).not.toBe(marked);
    expect(markedOptionOf(second)).not.toBe(marked);
  });
});

describe("buildArtifactExtensions markdown swap", () => {
  it("swaps in exactly one private markdown extension per call, distinct from the bare template", () => {
    const templateMarkdown = artifactDocumentBundle.extensions.find(
      (extension) => extension.name === "markdown",
    );
    expect(templateMarkdown).toBeDefined();

    const result1 = buildArtifactExtensions(buildParams());
    const markdownExtensions1 = result1.filter(
      (extension) => extension.name === "markdown",
    );
    expect(markdownExtensions1).toHaveLength(1);
    const markdownExtension1 = markdownExtensions1[0];
    expect(markdownExtension1).not.toBe(templateMarkdown);

    const result2 = buildArtifactExtensions(buildParams());
    const markdownExtensions2 = result2.filter(
      (extension) => extension.name === "markdown",
    );
    expect(markdownExtensions2).toHaveLength(1);
    const markdownExtension2 = markdownExtensions2[0];

    expect(markedOptionOf(markdownExtension1)).toBeDefined();
    expect(markedOptionOf(markdownExtension1)).not.toBe(
      markedOptionOf(markdownExtension2),
    );
  });

  it("keeps the shared markdownManager parsing markdown correctly through its private instance", () => {
    const parsed =
      artifactDocumentBundle.markdownManager.parse("# Title\n\nbody");

    const headingNode = parsed.content?.find((node) => node.type === "heading");
    expect(headingNode).toBeDefined();
  });
});
