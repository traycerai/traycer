import "../../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import {
  leadingDocTitle,
  nextTitleFollow,
} from "../use-artifact-doc-title-follow";

const editors: Editor[] = [];

function makeEditor(content: string): Editor {
  const editor = new Editor({
    extensions: [StarterKit],
    content,
  });
  editors.push(editor);
  return editor;
}

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy());
});

const DEFAULT_TITLE = "New spec";

/**
 * Mirrors the hook's state machine: threads `lastDocTitle` through a sequence
 * of edits and applies each rename to the simulated artifact title (as the
 * local Y.Doc rename does). `set:X` models an external rename (sidebar / other
 * client) that mutates the artifact title without a doc event.
 */
function drive(
  steps: ReadonlyArray<
    { readonly type: string | null } | { readonly set: string }
  >,
  opts: { readonly createdManually: boolean },
): string {
  let lastDocTitle: string | null = null;
  let artifactTitle = DEFAULT_TITLE;
  for (const step of steps) {
    if ("set" in step) {
      artifactTitle = step.set;
      continue;
    }
    const result = nextTitleFollow({
      nextDocTitle: step.type,
      lastDocTitle,
      artifactTitle,
      defaultTitle: DEFAULT_TITLE,
      createdManually: opts.createdManually,
    });
    lastDocTitle = result.lastDocTitle;
    if (result.renameTo !== null) artifactTitle = result.renameTo;
  }
  return artifactTitle;
}

describe("nextTitleFollow", () => {
  it("renames from the default title as the heading is first typed", () => {
    expect(drive([{ type: "Roadmap" }], { createdManually: true })).toBe(
      "Roadmap",
    );
  });

  it("keeps following across successive heading edits", () => {
    expect(
      drive([{ type: "Road" }, { type: "Roadmap" }, { type: "Roadmap 2026" }], {
        createdManually: true,
      }),
    ).toBe("Roadmap 2026");
  });

  it("follows again after the heading is cleared and retyped", () => {
    // The regression CodeRabbit flagged: clearing (null) must not sever the
    // link, so retyping renames the artifact rather than stranding the old title.
    expect(
      drive([{ type: "Foo" }, { type: null }, { type: "Bar" }], {
        createdManually: true,
      }),
    ).toBe("Bar");
  });

  it("keeps the last title while the heading is empty (never renames to empty)", () => {
    expect(
      drive([{ type: "Foo" }, { type: null }], { createdManually: true }),
    ).toBe("Foo");
  });

  it("stops following after an explicit external rename", () => {
    expect(
      drive([{ type: "Foo" }, { set: "Custom title" }, { type: "Foobar" }], {
        createdManually: true,
      }),
    ).toBe("Custom title");
  });

  it("does not revive the link when cleared and retyped after an external rename", () => {
    expect(
      drive(
        [
          { type: "Foo" },
          { set: "Custom title" },
          { type: null },
          { type: "Bar" },
        ],
        { createdManually: true },
      ),
    ).toBe("Custom title");
  });

  it("never renames an agent-created (not manually created) artifact", () => {
    expect(drive([{ type: "Roadmap" }], { createdManually: false })).toBe(
      DEFAULT_TITLE,
    );
  });
});

describe("leadingDocTitle", () => {
  it("reads a leading level-1 heading as the doc title, trimmed", () => {
    const editor = makeEditor("<h1>  Roadmap 2026 </h1><p>body</p>");
    expect(leadingDocTitle(editor)).toBe("Roadmap 2026");
  });

  it("flattens inline marks to plain heading text", () => {
    const editor = makeEditor("<h1>Road<strong>map</strong></h1>");
    expect(leadingDocTitle(editor)).toBe("Roadmap");
  });

  it("ignores a heading that is not the first block", () => {
    const editor = makeEditor("<p>intro</p><h1>Roadmap</h1>");
    expect(leadingDocTitle(editor)).toBeNull();
  });

  it("ignores a leading heading deeper than level 1", () => {
    const editor = makeEditor("<h2>Roadmap</h2>");
    expect(leadingDocTitle(editor)).toBeNull();
  });

  it("treats an empty or whitespace-only leading heading as no title", () => {
    const editor = makeEditor("<h1>   </h1><p>body</p>");
    expect(leadingDocTitle(editor)).toBeNull();
  });

  it("returns null for an empty document", () => {
    const editor = makeEditor("");
    expect(leadingDocTitle(editor)).toBeNull();
  });
});
