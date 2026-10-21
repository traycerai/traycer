import { afterEach, describe, expect, it, vi } from "vitest";
import { commentAnchorStatus } from "@traycer/html-source";
import {
  commentAnchorForSelection,
  htmlCommentRootArtboard,
  literalCommentSelection,
  normalizeCommentTextRange,
  resolveHtmlCommentArtboard,
} from "@/lib/comments/frame-comment-anchor";
import {
  canvasElement,
  disposeBridges,
  realBridge,
  quotedSelection,
  textSelection,
} from "@/components/canvas-artifact/__tests__/canvas-edit-test-support";

describe("normalizeCommentTextRange", () => {
  it("maps raw offsets onto the whitespace-collapsed text", () => {
    const fullText = "Hello   brave   world";
    const quote = "brave   world";

    expect(
      normalizeCommentTextRange(fullText, { start: 8, end: 21, quote }),
    ).toEqual({ startOffset: 6, endOffset: 17, quotedText: "brave world" });
  });

  it("ignores leading whitespace of the element text", () => {
    expect(
      normalizeCommentTextRange("   Hello world", {
        start: 9,
        end: 14,
        quote: "world",
      }),
    ).toEqual({ startOffset: 6, endOffset: 11, quotedText: "world" });
  });

  it("picks the occurrence the raw offset points at when the quote repeats", () => {
    expect(
      normalizeCommentTextRange("ab ab", { start: 3, end: 5, quote: "ab" }),
    ).toEqual({ startOffset: 3, endOffset: 5, quotedText: "ab" });
  });
});

describe("literalCommentSelection", () => {
  afterEach(disposeBridges);

  it("re-targets a generated element to its nearest literal parent", async () => {
    const bridge = realBridge();
    const parent = canvasElement({ tid: "card", tagName: "section" });
    const lookup = vi
      .spyOn(bridge, "literalAncestor")
      .mockResolvedValue(parent);
    const selection = textSelection(
      { start: 0, end: 5 },
      {
        tid: "generated-child",
        generated: true,
      },
    );

    const result = await literalCommentSelection(selection, bridge);

    expect(lookup).toHaveBeenCalledWith({ tid: "generated-child" });
    expect(result?.retargeted).toBe(true);
    expect(result?.selection.element).toBe(parent);
    expect(result?.selection.textRange).toBeNull();
  });

  it("gives null when a generated element has no literal parent", async () => {
    const bridge = realBridge();
    vi.spyOn(bridge, "literalAncestor").mockResolvedValue(null);
    const selection = textSelection(null, { tid: null, generated: true });

    expect(await literalCommentSelection(selection, bridge)).toBeNull();
  });
});

describe("resolveHtmlCommentArtboard", () => {
  const folderArtifact = {
    layout: "folder",
    relativePath: undefined,
    folderName: "report",
  } as const;
  const fileArtifact = {
    layout: "file",
    relativePath: "notes/report.html",
    folderName: "report.html",
  } as const;

  it("stores a loose file's basename and resolves it back to the nested manifest entry", () => {
    const selection = {
      ...textSelection(null, { tid: "heading" }),
      boardPath: htmlCommentRootArtboard(fileArtifact),
    };
    const { anchor } = commentAnchorForSelection(selection, null, null);

    expect(anchor).toMatchObject({
      kind: "element",
      artboard: "report.html",
    });
    if (anchor.kind === "artifact")
      throw new Error("Expected an element anchor");
    expect(resolveHtmlCommentArtboard(fileArtifact, anchor.artboard)).toBe(
      "notes/report.html",
    );
    expect(resolveHtmlCommentArtboard(folderArtifact, anchor.artboard)).toBe(
      "index.html",
    );
  });

  it.each(["index.html", "report.html"])(
    "resolves the root name %s to index.html in a folder artifact",
    (artboard) => {
      expect(resolveHtmlCommentArtboard(folderArtifact, artboard)).toBe(
        "index.html",
      );
    },
  );

  it.each(["index.html", "report.html"])(
    "resolves the root name %s to the file's own path in a loose-file artifact",
    (artboard) => {
      expect(resolveHtmlCommentArtboard(fileArtifact, artboard)).toBe(
        "notes/report.html",
      );
    },
  );

  it.each(["about.html", "boards/main.html"])(
    "keeps the non-root path %s as written",
    (artboard) => {
      expect(resolveHtmlCommentArtboard(folderArtifact, artboard)).toBe(
        artboard,
      );
    },
  );
});

describe("commentAnchorForSelection", () => {
  it.each(["root", null])(
    "anchors script-built text to its literal container (tid %s)",
    (tid) => {
      const source =
        tid === null ? "<div></div>" : '<div data-tid="root"></div>';
      const selection = quotedSelection("Hello", 0, 5, {
        tid,
        marker: 0,
        tagName: "div",
        generated: false,
      });
      const draft = commentAnchorForSelection(selection, "Hello", source);

      expect(draft).toMatchObject({
        anchor: { kind: "element", elementId: tid, label: 'div "Hello"' },
        quotedText: 'div "Hello"',
        generatedText: true,
      });
      if (tid !== null)
        expect(
          commentAnchorStatus(source, { kind: "element", elementId: tid }),
        ).toBe("present");
      const literal = commentAnchorForSelection(
        selection,
        "Hello",
        source.replace("></div>", ">Hello</div>"),
      );
      expect(literal).toMatchObject({
        anchor: { kind: "text", elementId: tid, startOffset: 0, endOffset: 5 },
        quotedText: "Hello",
        generatedText: false,
      });
    },
  );
});
