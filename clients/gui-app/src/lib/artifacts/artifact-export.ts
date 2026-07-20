import type * as Y from "yjs";
import type { JSONContent } from "@tiptap/core";
import type {
  Content,
  ContentText,
  TableCell,
  TDocumentDefinitions,
} from "pdfmake/interfaces";
import { artifactDocumentBundle } from "@/editor-core";

export type ArtifactExportFormat = "markdown" | "pdf";

export interface ArtifactExportSource {
  readonly id: string;
  readonly title: string;
  readonly fragment: Y.XmlFragment | null;
}

export interface ArtifactExportRequest {
  readonly artifacts: ReadonlyArray<ArtifactExportSource>;
  readonly format: ArtifactExportFormat;
  readonly archive: boolean;
  readonly archiveTitle: string;
}

export interface ArtifactExportResult {
  readonly blob: Blob;
  readonly suggestedName: string;
}

const UNSAFE_FILENAME_CHARACTERS = new Set([
  "<",
  ">",
  ":",
  '"',
  "/",
  "\\",
  "|",
  "?",
  "*",
]);
const WINDOWS_RESERVED_FILENAME =
  /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function safeFileStem(title: string): string {
  const normalized = Array.from(title.normalize("NFKC"))
    .map((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint === undefined ||
        codePoint <= 31 ||
        codePoint === 127 ||
        UNSAFE_FILENAME_CHARACTERS.has(character)
        ? " "
        : character;
    })
    .join("")
    .replace(/\s+/g, " ")
    .replace(/^[. ]+|[. ]+$/g, "");
  const bounded = Array.from(normalized).slice(0, 120).join("");
  const stem = bounded || "artifact";
  return WINDOWS_RESERVED_FILENAME.test(stem) ? `_${stem}` : stem;
}

function collisionSafeFilenames(
  artifacts: ReadonlyArray<ArtifactExportSource>,
  extension: "md" | "pdf",
): string[] {
  const used = new Set<string>();
  return artifacts.map((artifact) => {
    const stem = safeFileStem(artifact.title);
    let candidate = stem;
    let suffix = 2;
    while (used.has(candidate.toLocaleLowerCase("en-US"))) {
      candidate = `${stem} (${suffix})`;
      suffix += 1;
    }
    used.add(candidate.toLocaleLowerCase("en-US"));
    return `${candidate}.${extension}`;
  });
}

function requireAvailableFragment(
  artifact: ArtifactExportSource,
): Y.XmlFragment {
  if (artifact.fragment === null) {
    throw new Error(`Artifact "${artifact.title}" is unavailable for export.`);
  }
  return artifact.fragment;
}

let pdfMakePromise: Promise<typeof import("pdfmake")> | null = null;

function isVirtualFileSystem(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function virtualFileSystemFromModule(value: unknown): Record<string, string> {
  if (isVirtualFileSystem(value)) return value;
  if (typeof value === "object" && value !== null && "default" in value) {
    const defaultExport: unknown = value.default;
    if (isVirtualFileSystem(defaultExport)) return defaultExport;
  }
  throw new Error("PDF font bundle did not expose a virtual file system.");
}

function loadPdfMake(): Promise<typeof import("pdfmake")> {
  if (pdfMakePromise === null) {
    pdfMakePromise = Promise.all([
      import("pdfmake/build/pdfmake"),
      import("pdfmake/build/vfs_fonts"),
    ])
      .then(([pdfMakeModule, vfsModule]) => {
        pdfMakeModule.default.addVirtualFileSystem(
          virtualFileSystemFromModule(vfsModule),
        );
        return pdfMakeModule.default;
      })
      .catch((error: unknown) => {
        pdfMakePromise = null;
        throw error;
      });
  }
  return pdfMakePromise;
}

function markAttribute(
  node: JSONContent,
  markType: string,
  attribute: string,
): unknown {
  return node.marks?.find((mark) => mark.type === markType)?.attrs?.[attribute];
}

function hasMark(node: JSONContent, markType: string): boolean {
  return node.marks?.some((mark) => mark.type === markType) ?? false;
}

function textDecoration(
  node: JSONContent,
  isLink: boolean,
): "lineThrough" | "underline" | undefined {
  if (hasMark(node, "strike")) return "lineThrough";
  if (isLink) return "underline";
  return undefined;
}

function inlineNodePdfContent(node: JSONContent): Content[] {
  if (node.type === "hardBreak") return ["\n"];
  if (node.type !== "text") return inlinePdfContent(node.content);

  const href = markAttribute(node, "link", "href");
  const isLink = typeof href === "string";
  const content: ContentText = {
    text: node.text ?? "",
    bold: hasMark(node, "bold") || undefined,
    italics: hasMark(node, "italic") || undefined,
    decoration: textDecoration(node, isLink),
    link: isLink ? href : undefined,
    color: isLink ? "#2563eb" : undefined,
    background: hasMark(node, "code") ? "#f3f4f6" : undefined,
  };
  return [content];
}

function inlinePdfContent(nodes: JSONContent[] | undefined): Content[] {
  return (nodes ?? []).flatMap(inlineNodePdfContent);
}

function listItemPdfContent(node: JSONContent): Content {
  return { stack: blockPdfContent(node.content) };
}

function taskListChildPdfContent(node: JSONContent): Content[] {
  if (node.type === "taskList") return taskListPdfContent(node, true);
  return blockNodePdfContent(node);
}

function taskItemPdfContent(node: JSONContent): Content {
  const children = node.content ?? [];
  const checkedValue: unknown = node.attrs?.checked;
  const checkbox: ContentText = {
    text: checkedValue === true ? "☑ " : "☐ ",
  };
  if (children.length > 0 && children[0].type === "paragraph") {
    const firstChild = children[0];
    return {
      stack: [
        { text: [checkbox, ...inlinePdfContent(firstChild.content)] },
        ...children.slice(1).flatMap(taskListChildPdfContent),
      ],
    };
  }
  return {
    stack: [{ text: [checkbox] }, ...children.flatMap(taskListChildPdfContent)],
  };
}

function taskListPdfContent(node: JSONContent, nested: boolean): Content[] {
  return [
    {
      stack: (node.content ?? []).map(taskItemPdfContent),
      margin: [nested ? 12 : 0, 0, 0, nested ? 0 : 8],
    },
  ];
}

function tableCellChildPdfContent(child: JSONContent): Content[] {
  if (child.type === "paragraph") return inlinePdfContent(child.content);
  return blockPdfContent([child]);
}

function tableCellPdfContent(node: JSONContent): TableCell {
  const inline = (node.content ?? []).flatMap(tableCellChildPdfContent);
  return {
    text: inline,
    bold: node.type === "tableHeader" || undefined,
    fillColor: node.type === "tableHeader" ? "#f3f4f6" : undefined,
  };
}

function headingPdfContent(node: JSONContent): Content[] {
  const levelValue: unknown = node.attrs?.level;
  const level =
    typeof levelValue === "number" && levelValue >= 1 && levelValue <= 6
      ? levelValue
      : 1;
  return [
    {
      text: inlinePdfContent(node.content),
      style: `heading${level}`,
      margin: [0, level === 1 ? 0 : 8, 0, 6],
    },
  ];
}

function orderedListPdfContent(node: JSONContent): Content[] {
  const startValue: unknown = node.attrs?.start;
  return [
    {
      ol: (node.content ?? []).map(listItemPdfContent),
      start: typeof startValue === "number" ? startValue : undefined,
      margin: [0, 0, 0, 8],
    },
  ];
}

function tablePdfContent(node: JSONContent): Content[] {
  const rows = node.content ?? [];
  const columnCount = rows[0]?.content?.length ?? 0;
  const hasHeader =
    rows[0]?.content?.some((cell) => cell.type === "tableHeader") ?? false;
  return [
    {
      table: {
        headerRows: hasHeader ? 1 : 0,
        widths: Array.from({ length: columnCount }, () => "*"),
        body: rows.map((row) => (row.content ?? []).map(tableCellPdfContent)),
      },
      layout: "lightHorizontalLines",
      margin: [0, 4, 0, 8],
    },
  ];
}

function stringAttribute(node: JSONContent, attribute: string): string {
  const value: unknown = node.attrs?.[attribute];
  return typeof value === "string" ? value : "";
}

function codeSourcePdfContent(source: string): ContentText {
  return {
    text: source,
    fontSize: 9,
    background: "#f3f4f6",
    preserveLeadingSpaces: true,
  };
}

function labeledSourcePdfContent(label: string, source: string): Content[] {
  return [
    {
      stack: [
        { text: label, bold: true, margin: [0, 4, 0, 4] },
        {
          ...codeSourcePdfContent(source),
          margin: [0, 0, 0, 8],
        },
      ],
    },
  ];
}

const LABELED_SOURCE_NODES = [
  {
    type: "mermaidBlock",
    label: "Mermaid source",
    sourceAttribute: "code",
  },
  {
    type: "uiPreviewBlock",
    label: "UI preview source",
    sourceAttribute: "htmlContent",
  },
] as const;

function blockNodePdfContent(node: JSONContent): Content[] {
  const labeledSourceConfig = LABELED_SOURCE_NODES.find(
    (config) => config.type === node.type,
  );
  if (labeledSourceConfig !== undefined) {
    return labeledSourcePdfContent(
      labeledSourceConfig.label,
      stringAttribute(node, labeledSourceConfig.sourceAttribute),
    );
  }

  switch (node.type) {
    case "doc":
      return blockPdfContent(node.content);
    case "heading":
      return headingPdfContent(node);
    case "paragraph":
      return [{ text: inlinePdfContent(node.content), margin: [0, 0, 0, 8] }];
    case "bulletList":
      return [
        {
          ul: (node.content ?? []).map(listItemPdfContent),
          margin: [0, 0, 0, 8],
        },
      ];
    case "taskList":
      return taskListPdfContent(node, false);
    case "orderedList":
      return orderedListPdfContent(node);
    case "blockquote":
      return [
        {
          stack: blockPdfContent(node.content),
          color: "#4b5563",
          margin: [12, 0, 0, 8],
        },
      ];
    case "codeBlock":
      return [
        {
          ...codeSourcePdfContent(
            node.content?.map((child) => child.text ?? "").join("") ?? "",
          ),
          margin: [0, 4, 0, 8],
        },
      ];
    case "horizontalRule":
      return [
        {
          canvas: [
            {
              type: "line",
              x1: 0,
              y1: 0,
              x2: 515,
              y2: 0,
              lineWidth: 1,
              lineColor: "#d1d5db",
            },
          ],
          margin: [0, 4, 0, 8],
        },
      ];
    case "table":
      return tablePdfContent(node);
    default:
      if (node.text !== undefined) return [{ text: node.text }];
      return blockPdfContent(node.content);
  }
}

function blockPdfContent(nodes: JSONContent[] | undefined): Content[] {
  return (nodes ?? []).flatMap(blockNodePdfContent);
}

const PDF_HEADING_STYLES = {
  heading1: { fontSize: 24, bold: true },
  heading2: { fontSize: 20, bold: true },
  heading3: { fontSize: 16, bold: true },
  heading4: { fontSize: 14, bold: true },
  heading5: { fontSize: 12, bold: true },
  heading6: { fontSize: 11, bold: true },
};

async function pdfBytes(markdown: string): Promise<Uint8Array<ArrayBuffer>> {
  const pdfMake = await loadPdfMake();
  const definition: TDocumentDefinitions = {
    content: blockPdfContent(
      artifactDocumentBundle.markdownManager.parse(markdown).content,
    ),
    defaultStyle: { font: "Roboto", fontSize: 11, lineHeight: 1.25 },
    styles: PDF_HEADING_STYLES,
  };
  const blob = await pdfMake.createPdf(definition).getBlob();
  return new Uint8Array(await blob.arrayBuffer());
}

async function exportFileBytes(
  format: ArtifactExportFormat,
  markdown: string,
): Promise<Uint8Array<ArrayBuffer>> {
  if (format === "pdf") {
    return pdfBytes(markdown);
  }
  return new TextEncoder().encode(markdown);
}

export async function createArtifactExport(
  request: ArtifactExportRequest,
): Promise<ArtifactExportResult> {
  if (request.artifacts.length === 0) {
    throw new Error("Select at least one artifact to export.");
  }
  if (!request.archive && request.artifacts.length !== 1) {
    throw new Error("Individual export requires exactly one artifact.");
  }
  const extension = request.format === "markdown" ? "md" : "pdf";
  const filenames = collisionSafeFilenames(request.artifacts, extension);
  const markdownFiles = request.artifacts.map((artifact) =>
    artifactDocumentBundle.markdown.serialize(
      requireAvailableFragment(artifact),
    ),
  );
  const fileBytes = await Promise.all(
    markdownFiles.map((markdown) => exportFileBytes(request.format, markdown)),
  );
  if (request.archive) {
    const { zipSync } = await import("fflate");
    const entries = fileBytes.reduce<Record<string, Uint8Array<ArrayBuffer>>>(
      (files, bytes, index) => {
        files[filenames[index]] = bytes;
        return files;
      },
      {},
    );
    return {
      blob: new Blob([zipSync(entries)], { type: "application/zip" }),
      suggestedName: `${safeFileStem(request.archiveTitle)}.zip`,
    };
  }

  const mimeType =
    request.format === "markdown"
      ? "text/markdown;charset=utf-8"
      : "application/pdf";
  return {
    blob: new Blob([Uint8Array.from(fileBytes[0])], { type: mimeType }),
    suggestedName: filenames[0],
  };
}
