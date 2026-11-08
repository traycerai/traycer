import { describe, expect, it } from "vitest";
import { prosemirrorJSONToYXmlFragment } from "@tiptap/y-tiptap";
import * as Y from "yjs";
import { serializeArtifactMarkdown } from "@/lib/artifacts/artifact-export";
import { artifactDocumentBundle } from "@/editor-core";
import { createArtifactExport } from "@/lib/artifacts";
import { unzipSync } from "fflate";

/**
 * Still round-trips through a real `Y.XmlFragment` rather than handing the
 * builder its input string back: the export used to serialize the fragment
 * itself, so parsing and re-serializing here keeps these expectations pinned to
 * the same bytes that change moved OUT of the builder.
 */
function createBody(markdown: string): string {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment("artifact-body");
  prosemirrorJSONToYXmlFragment(
    artifactDocumentBundle.schema,
    artifactDocumentBundle.markdownManager.parse(markdown),
    fragment,
  );
  return serializeArtifactMarkdown(fragment);
}

describe("createArtifactExport", () => {
  it("requires at least one artifact", async () => {
    await expect(
      createArtifactExport({
        artifacts: [],
        format: "markdown",
        archive: true,
        archiveTitle: "Empty",
      }),
    ).rejects.toThrow("Select at least one artifact to export.");
  });

  it("rejects multiple artifacts without an archive", async () => {
    await expect(
      createArtifactExport({
        artifacts: [
          {
            id: "artifact-1",
            title: "First",
            markdown: createBody("# First"),
            parentId: null,
          },
          {
            id: "artifact-2",
            title: "Second",
            markdown: createBody("# Second"),
            parentId: null,
          },
        ],
        format: "markdown",
        archive: false,
        archiveTitle: "ignored",
      }),
    ).rejects.toThrow("Individual export requires exactly one artifact.");
  });

  it("exports one artifact as canonical Markdown", async () => {
    const result = await createArtifactExport({
      artifacts: [
        {
          id: "artifact-1",
          title: "Release plan",
          markdown: createBody("# Release plan\n\n- [ ] Ship it"),
          parentId: null,
        },
      ],
      format: "markdown",
      archive: false,
      archiveTitle: "ignored",
    });

    expect(result.suggestedName).toBe("Release plan.md");
    expect(result.blob.type).toBe("text/markdown;charset=utf-8");
    expect(await result.blob.text()).toBe("# Release plan\n\n- [ ] Ship it");
  });

  it("creates cross-platform-safe, collision-deduped ZIP entries in selected order", async () => {
    const result = await createArtifactExport({
      artifacts: [
        {
          id: "parent",
          title: "Roadmap?/Q3",
          markdown: createBody("# Parent"),
          parentId: null,
        },
        {
          id: "child",
          title: "roadmap:/q3",
          markdown: createBody("# Child"),
          parentId: null,
        },
        {
          id: "reserved",
          title: "CON",
          markdown: createBody("# Reserved"),
          parentId: null,
        },
      ],
      format: "markdown",
      archive: true,
      archiveTitle: "../Quarter: 3",
    });

    expect(result.suggestedName).toBe("Quarter 3.zip");
    expect(result.blob.type).toBe("application/zip");
    const entries = unzipSync(new Uint8Array(await result.blob.arrayBuffer()));
    expect(Object.keys(entries)).toEqual([
      "Roadmap Q3.md",
      "roadmap q3 (2).md",
      "_CON.md",
    ]);
    expect(new TextDecoder().decode(entries["Roadmap Q3.md"])).toBe("# Parent");
    expect(new TextDecoder().decode(entries["roadmap q3 (2).md"])).toBe(
      "# Child",
    );
    expect(new TextDecoder().decode(entries["_CON.md"])).toBe("# Reserved");
  });

  it("lays nested artifacts out as folders under their parent", async () => {
    const source = (
      id: string,
      title: string,
      parentId: string | null,
    ): {
      id: string;
      title: string;
      parentId: string | null;
      markdown: string;
    } => ({ id, title, parentId, markdown: `# ${id}` });
    const result = await createArtifactExport({
      artifacts: [
        source("spec", "Spec", null),
        source("story", "Story", "spec"),
        source("ticket", "Ticket", "story"),
        // Same stem as its parent: claims a distinct name in that folder.
        source("echo", "spec", "spec"),
        source("loose", "Loose", "not-in-export"),
        // A parent cycle has no root; its members surface at the top level.
        source("cycle-a", "Cycle A", "cycle-b"),
        source("cycle-b", "Cycle B", "cycle-a"),
      ],
      format: "markdown",
      archive: true,
      archiveTitle: "Epic",
    });

    const entries = unzipSync(new Uint8Array(await result.blob.arrayBuffer()));
    expect(
      Object.fromEntries(
        Object.entries(entries).map(([path, bytes]) => [
          path,
          new TextDecoder().decode(bytes),
        ]),
      ),
    ).toEqual({
      "Spec/Spec.md": "# spec",
      "Spec/Story/Story.md": "# story",
      "Spec/Story/Ticket.md": "# ticket",
      "Spec/spec (2).md": "# echo",
      "Loose.md": "# loose",
      "Cycle A/Cycle A.md": "# cycle-a",
      "Cycle A/Cycle B.md": "# cycle-b",
    });
  });

  it("never gives a folder and a file the same archive path", async () => {
    const result = await createArtifactExport({
      artifacts: [
        { id: "parent", title: "Plan.md", parentId: null, markdown: "# p" },
        { id: "kid", title: "Kid", parentId: "parent", markdown: "# k" },
        // Written `Plan.md`, which is the folder's name above.
        { id: "leaf", title: "Plan", parentId: null, markdown: "# l" },
        // Written `Spec.md`: a different name from the folder `Spec/` - kept.
        { id: "spec", title: "Spec", parentId: null, markdown: "# s" },
        { id: "spec-kid", title: "Kid", parentId: "spec", markdown: "# sk" },
        { id: "spec-twin", title: "Spec", parentId: null, markdown: "# st" },
      ],
      format: "markdown",
      archive: true,
      archiveTitle: "Epic",
    });

    const entries = unzipSync(new Uint8Array(await result.blob.arrayBuffer()));
    expect(Object.keys(entries).sort()).toEqual([
      "Plan (2).md",
      "Plan.md/Kid.md",
      "Plan.md/Plan.md.md",
      "Spec.md",
      "Spec/Kid.md",
      "Spec/Spec.md",
    ]);
  });

  it("keeps deeply nested paths within the Windows path budget", async () => {
    const longTitle = (label: string): string => `${label} ${"x".repeat(150)}`;
    const chain = Array.from({ length: 6 }, (_, depth) => ({
      id: `level-${depth}`,
      title: longTitle(`Level ${depth}`),
      parentId: depth === 0 ? null : `level-${depth - 1}`,
      markdown: `# ${depth}`,
    }));
    const result = await createArtifactExport({
      artifacts: chain,
      format: "pdf",
      archive: true,
      archiveTitle: "Deep",
    });

    const paths = Object.keys(
      unzipSync(new Uint8Array(await result.blob.arrayBuffer())),
    );
    expect(paths).toHaveLength(chain.length);
    for (const path of paths) {
      expect(path.length).toBeLessThanOrEqual(200);
    }
    // A flat export keeps its full-length stems.
    const flat = await createArtifactExport({
      artifacts: [{ ...chain[0], parentId: null }],
      format: "markdown",
      archive: false,
      archiveTitle: "ignored",
    });
    expect(flat.suggestedName).toBe(`${"Level 0 " + "x".repeat(112)}.md`);
  });

  it("keeps a long parent title whole when only files sit under it", async () => {
    const title = `Parent ${"p".repeat(83)}`;
    const result = await createArtifactExport({
      artifacts: [
        { id: "parent", title, parentId: null, markdown: "# p" },
        { id: "kid", title: "Kid", parentId: "parent", markdown: "# k" },
      ],
      format: "markdown",
      archive: true,
      archiveTitle: "Epic",
    });

    const entries = unzipSync(new Uint8Array(await result.blob.arrayBuffer()));
    expect(Object.keys(entries).sort()).toEqual([
      `${title}/Kid.md`,
      `${title}/${title}.md`,
    ]);
  });

  it("preserves complete Unicode code points in exported filenames", async () => {
    const result = await createArtifactExport({
      artifacts: [
        {
          id: "unicode",
          title: `${"a".repeat(119)}🐇tail`,
          markdown: createBody("Unicode"),
          parentId: null,
        },
      ],
      format: "markdown",
      archive: false,
      archiveTitle: "ignored",
    });

    expect(result.suggestedName).toBe(`${"a".repeat(119)}🐇.md`);

    // 120 code points, not 120 UTF-16 units: a single file is not held to
    // the archive path budget.
    const astral = await createArtifactExport({
      artifacts: [
        {
          id: "astral",
          title: "🐇".repeat(130),
          markdown: createBody("Astral"),
          parentId: null,
        },
      ],
      format: "markdown",
      archive: false,
      archiveTitle: "ignored",
    });
    expect(astral.suggestedName).toBe(`${"🐇".repeat(120)}.md`);
  });

  it("exports a PDF Blob with a valid PDF signature", async () => {
    const result = await createArtifactExport({
      artifacts: [
        {
          id: "artifact-pdf",
          title: "Design",
          markdown: createBody("# Design\n\nPortable content"),
          parentId: null,
        },
      ],
      format: "pdf",
      archive: false,
      archiveTitle: "ignored",
    });

    expect(result.suggestedName).toBe("Design.pdf");
    expect(result.blob.type).toBe("application/pdf");
    const signature = new TextDecoder().decode(
      new Uint8Array(await result.blob.arrayBuffer()).slice(0, 5),
    );
    expect(signature).toBe("%PDF-");
  });

  it("reports which selected artifact is unavailable", async () => {
    await expect(
      createArtifactExport({
        artifacts: [
          {
            id: "missing",
            title: "Missing review",
            markdown: null,
            parentId: null,
          },
        ],
        format: "markdown",
        archive: true,
        archiveTitle: "Reviews",
      }),
    ).rejects.toThrow('Artifact "Missing review" is unavailable for export.');
  });
});
