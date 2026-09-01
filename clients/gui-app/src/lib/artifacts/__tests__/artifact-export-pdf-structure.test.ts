import { beforeEach, describe, expect, it, vi } from "vitest";
import { prosemirrorJSONToYXmlFragment } from "@tiptap/y-tiptap";
import * as Y from "yjs";
import { serializeArtifactMarkdown } from "@/lib/artifacts/artifact-export";
import { artifactDocumentBundle } from "@/editor-core";
import type { TDocumentDefinitions } from "pdfmake/interfaces";

interface PdfMakeTestState {
  definition: TDocumentDefinitions | null;
}

const pdfMake = vi.hoisted(() => {
  const state: PdfMakeTestState = { definition: null };
  return {
    state,
    addVirtualFileSystem: vi.fn(),
    createPdf: vi.fn((definition: TDocumentDefinitions) => {
      state.definition = definition;
      return {
        getBlob: () => Promise.resolve(new Blob(["%PDF-mocked"])),
      };
    }),
  };
});

vi.mock("pdfmake/build/pdfmake", () => ({ default: pdfMake }));
vi.mock("pdfmake/build/vfs_fonts", () => ({
  "Roboto-Bold.ttf": "bold-font-data",
  "Roboto-Regular.ttf": "regular-font-data",
}));

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

describe("PDF artifact export", () => {
  beforeEach(() => {
    vi.resetModules();
    pdfMake.addVirtualFileSystem.mockClear();
    pdfMake.createPdf.mockClear();
    pdfMake.state.definition = null;
  });

  it("retries PDF initialization after a transient font-loading failure", async () => {
    pdfMake.addVirtualFileSystem
      .mockImplementationOnce(() => {
        throw new Error("temporary font-loading failure");
      })
      .mockImplementationOnce(() => undefined);
    const { createArtifactExport } = await import("@/lib/artifacts");
    const request = {
      artifacts: [
        {
          id: "retry-pdf",
          title: "Retry PDF",
          markdown: createBody("# Retry"),
        },
      ],
      format: "pdf" as const,
      archive: false,
      archiveTitle: "ignored",
    };

    await expect(createArtifactExport(request)).rejects.toThrow(
      "temporary font-loading failure",
    );
    await expect(createArtifactExport(request)).resolves.toMatchObject({
      suggestedName: "Retry PDF.pdf",
    });
    expect(pdfMake.addVirtualFileSystem).toHaveBeenCalledTimes(2);
  });

  it("renders Markdown semantics as structured PDF content", async () => {
    const { createArtifactExport } = await import("@/lib/artifacts");

    await createArtifactExport({
      artifacts: [
        {
          id: "structured-pdf",
          title: "Structured PDF",
          markdown: createBody(
            "# Design\n\nA **bold** and *italic* paragraph.\n\n- One\n- Two\n\n| A | B |\n| - | - |\n| 1 | 2 |",
          ),
        },
      ],
      format: "pdf",
      archive: false,
      archiveTitle: "ignored",
    });

    expect(pdfMake.addVirtualFileSystem).toHaveBeenCalledWith({
      "Roboto-Bold.ttf": "bold-font-data",
      "Roboto-Regular.ttf": "regular-font-data",
    });
    expect(pdfMake.state.definition).toMatchObject({
      content: [
        {
          style: "heading1",
          text: [{ text: "Design" }],
        },
        {
          text: [
            { text: "A " },
            { text: "bold", bold: true },
            { text: " and " },
            { text: "italic", italics: true },
            { text: " paragraph." },
          ],
        },
        {
          ul: [{}, {}],
        },
        {
          table: {
            headerRows: 1,
            body: [
              [
                { bold: true, text: [{ text: "A" }] },
                { bold: true, text: [{ text: "B" }] },
              ],
              [{ text: [{ text: "1" }] }, { text: [{ text: "2" }] }],
            ],
          },
        },
      ],
    });
  });

  it("preserves Mermaid and wireframe sources as labeled code blocks", async () => {
    const { createArtifactExport } = await import("@/lib/artifacts");
    const mermaidSource = "flowchart TD\n  A --> B";
    const wireframeSource =
      '<div data-kind="hero">\n  <h1>Exact wireframe</h1>\n</div>';

    await createArtifactExport({
      artifacts: [
        {
          id: "visual-pdf",
          title: "Visual PDF",
          markdown: createBody(
            `\`\`\`mermaid\n${mermaidSource}\n\`\`\`\n\n\`\`\`wireframe\n${wireframeSource}\n\`\`\``,
          ),
        },
      ],
      format: "pdf",
      archive: false,
      archiveTitle: "ignored",
    });

    expect(pdfMake.state.definition).toMatchObject({
      content: [
        {
          stack: [
            { text: "Mermaid source", bold: true },
            {
              text: mermaidSource,
              fontSize: 9,
              background: "#f3f4f6",
              preserveLeadingSpaces: true,
            },
          ],
        },
        {
          stack: [
            { text: "UI preview source", bold: true },
            {
              text: wireframeSource,
              fontSize: 9,
              background: "#f3f4f6",
              preserveLeadingSpaces: true,
            },
          ],
        },
      ],
    });
  });

  it("renders nested task lists as markerless stacks with inline checkboxes", async () => {
    const { createArtifactExport } = await import("@/lib/artifacts");

    await createArtifactExport({
      artifacts: [
        {
          id: "tasks-pdf",
          title: "Tasks PDF",
          markdown: createBody(
            "- [ ] Draft copy\n- [x] Ship release\n  - [ ] Notify team",
          ),
        },
      ],
      format: "pdf",
      archive: false,
      archiveTitle: "ignored",
    });

    expect(pdfMake.state.definition).toMatchObject({
      content: [
        {
          stack: [
            {
              stack: [
                {
                  text: [{ text: "☐ " }, { text: "Draft copy" }],
                },
              ],
            },
            {
              stack: [
                {
                  text: [{ text: "☑ " }, { text: "Ship release" }],
                },
                {
                  stack: [
                    {
                      stack: [
                        {
                          text: [{ text: "☐ " }, { text: "Notify team" }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(pdfMake.state.definition)).not.toContain('"ul"');
  });
});
