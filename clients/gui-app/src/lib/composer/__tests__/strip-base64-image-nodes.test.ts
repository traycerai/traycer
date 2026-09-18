import type { JsonContent } from "@traycer/protocol/common/registry";
import { describe, expect, it } from "vitest";

import {
  stripBase64ImageNodes,
  stripBase64ImageNodesWithSelection,
} from "@/lib/composer/strip-base64-image-nodes";
import { EMPTY_LANDING_DRAFT_CONTENT } from "@/stores/home/landing-draft-content";

type TestSelection = { readonly from: number; readonly to: number };

const SELECTION: TestSelection = { from: 7, to: 7 };

function pendingImage(id: string): JsonContent {
  return {
    type: "imageAttachment",
    attrs: { id, b64content: "data:image/png;base64,AAAA" },
  };
}

function hashOnlyImage(id: string): JsonContent {
  return { type: "imageAttachment", attrs: { id, sha256: "a".repeat(64) } };
}

function paragraph(text: string): JsonContent {
  return { type: "paragraph", content: [{ type: "text", text }] };
}

/**
 * The predicate this module used to key the caret on, kept here as a CONTROL.
 *
 * Every "the caret is dropped" case below is only meaningful if this returns
 * `false` for it - otherwise the assertion would have passed just as well
 * before the fix, and would be pinning nothing. The one case where the two
 * disagree is the empty `attachmentGroup`, and the test that covers it asserts
 * that disagreement explicitly rather than trusting it.
 */
function heldABase64Node(content: JsonContent): boolean {
  if (content.type === "imageAttachment") {
    return typeof content.attrs?.b64content === "string";
  }
  const children = content.content;
  if (children === undefined) return false;
  return children.some(heldABase64Node);
}

describe("stripBase64ImageNodes", () => {
  it("returns the input unchanged, by reference, when there is nothing to strip", () => {
    const doc: JsonContent = {
      type: "doc",
      content: [paragraph("hello"), hashOnlyImage("img-1")],
    };
    // Reference identity, not deep equality: the caret rule downstream is keyed
    // on it, so "unchanged" has to mean the same object and not merely an
    // equal one.
    expect(stripBase64ImageNodes(doc)).toBe(doc);
  });

  it("drops a pending b64 node and leaves its hash-only sibling alone", () => {
    const survivor = hashOnlyImage("img-keep");
    const doc: JsonContent = {
      type: "doc",
      content: [
        {
          type: "attachmentGroup",
          content: [pendingImage("img-drop"), survivor],
        },
        paragraph("caption"),
      ],
    };
    const stripped = stripBase64ImageNodes(doc);
    expect(stripped).not.toBe(doc);
    expect(stripped.content?.[0]).toEqual({
      type: "attachmentGroup",
      content: [survivor],
    });
  });

  it("drops an attachmentGroup that arrives already empty", () => {
    const doc: JsonContent = {
      type: "doc",
      content: [{ type: "attachmentGroup", content: [] }, paragraph("body")],
    };
    const stripped = stripBase64ImageNodes(doc);
    expect(stripped.content).toEqual([paragraph("body")]);
    // The shape has no b64 node anywhere - which is exactly why the old
    // predicate could not see this change.
    expect(heldABase64Node(doc)).toBe(false);
  });

  it("returns the empty draft when the root itself strips away", () => {
    // The root IS the group, so the walk returns null rather than an empty doc.
    const root: JsonContent = {
      type: "attachmentGroup",
      content: [pendingImage("img-1")],
    };
    expect(stripBase64ImageNodes(root)).toBe(EMPTY_LANDING_DRAFT_CONTENT);
  });

  it("returns the empty draft when a doc survives with no children left", () => {
    // `doc` declares `content: "block+"`, so `{ type: "doc", content: [] }` is a
    // document the editor's schema rejects: `useEditor` throws while building
    // it and the composer restoring this draft fails to MOUNT. The `null` arm
    // above cannot catch this one - an empty doc is not null.
    const doc: JsonContent = {
      type: "doc",
      content: [{ type: "attachmentGroup", content: [pendingImage("img-1")] }],
    };
    expect(stripBase64ImageNodes(doc)).toBe(EMPTY_LANDING_DRAFT_CONTENT);
    expect(stripBase64ImageNodes(doc)).not.toEqual({
      type: "doc",
      content: [],
    });
  });
});

describe("stripBase64ImageNodesWithSelection", () => {
  it("keeps the caret when the strip changes nothing", () => {
    const doc: JsonContent = {
      type: "doc",
      content: [paragraph("hello"), hashOnlyImage("img-1")],
    };
    const result = stripBase64ImageNodesWithSelection(doc, SELECTION);
    expect(result.content).toBe(doc);
    expect(result.selection).toBe(SELECTION);
  });

  it("keeps the caret for a document that is already the empty draft", () => {
    const result = stripBase64ImageNodesWithSelection(
      EMPTY_LANDING_DRAFT_CONTENT,
      SELECTION,
    );
    expect(result.content).toBe(EMPTY_LANDING_DRAFT_CONTENT);
    expect(result.selection).toBe(SELECTION);
  });

  it("drops the caret when a pending b64 node is removed", () => {
    const doc: JsonContent = {
      type: "doc",
      content: [
        { type: "attachmentGroup", content: [pendingImage("img-1")] },
        paragraph("body"),
      ],
    };
    expect(heldABase64Node(doc)).toBe(true);
    expect(
      stripBase64ImageNodesWithSelection(doc, SELECTION).selection,
    ).toBeNull();
  });

  it("drops the caret when an already-empty attachmentGroup is removed", () => {
    // The regression this pins. Positions count nodes, so removing the group
    // shifts every position after it; a caret persisted beside the stripped
    // document would restore against different content.
    const doc: JsonContent = {
      type: "doc",
      content: [{ type: "attachmentGroup", content: [] }, paragraph("body")],
    };
    const result = stripBase64ImageNodesWithSelection(doc, SELECTION);
    expect(result.content).not.toBe(doc);
    expect(result.selection).toBeNull();
    // Discrimination: the old predicate says "nothing to strip" here, so this
    // assertion fails against the previous implementation and passes against
    // this one. Without it the case would be indistinguishable from the b64
    // cases above, which agree under both rules.
    expect(heldABase64Node(doc)).toBe(false);
  });

  it("drops the caret when the document collapses to the empty draft", () => {
    const doc: JsonContent = {
      type: "doc",
      content: [{ type: "attachmentGroup", content: [pendingImage("img-1")] }],
    };
    const result = stripBase64ImageNodesWithSelection(doc, SELECTION);
    expect(result.content).toBe(EMPTY_LANDING_DRAFT_CONTENT);
    expect(result.selection).toBeNull();
  });
});
