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
  /**
   * The artifact's body, ALREADY SERIALIZED - not the live fragment.
   *
   * A fragment is only readable while its room is leased, so taking one here
   * made every selected body resident for the whole build: the caller had to
   * hold N leases at once, and a bulk export's memory grew with the combined
   * size of the selection. Text has no such lifetime, so the caller can
   * serialize and release one artifact at a time.
   *
   * `null` is "this client could not read it", and it still fails the export
   * by title rather than exporting an empty file.
   */
  readonly markdown: string | null;
  /**
   * The id of this artifact's parent WITHIN THE EXPORT, or `null` for a root.
   *
   * An archive places a parent's children in a folder named after it, next to
   * the parent's own file inside that folder, so a nested export unpacks as the
   * tree the sidebar shows. An id that names no other source in the request is
   * treated as a root, as is any source a malformed cycle would orphan. Every
   * `null` reproduces the flat archive.
   */
  readonly parentId: string | null;
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

/**
 * The longest archive path an entry may take, in UTF-16 code units (what
 * Windows counts). Extraction tools that are not long-path aware refuse a path
 * over MAX_PATH (260), and that count includes the folder the archive is
 * unpacked into, so this leaves 60 units for it.
 */
const ARCHIVE_PATH_BUDGET = 200;
/** Room kept for a ` (n)` collision suffix. */
const COLLISION_SUFFIX_RESERVE = 6;
/** Below this a stem stops being recognizable; deeper paths may then exceed the budget. */
const MIN_BUDGETED_STEM = 12;

/** `stem` cut to at most `maxUnits` UTF-16 units, on a code-point boundary. */
function truncateStem(stem: string, maxUnits: number): string {
  if (stem.length <= maxUnits) return stem;
  let truncated = "";
  for (const character of stem) {
    if (truncated.length + character.length > maxUnits) break;
    truncated += character;
  }
  return truncated.replace(/[. ]+$/g, "") || "artifact";
}

/**
 * Claims an entry in one directory and returns its stem, suffixing ` (2)`,
 * ` (3)`... on a clash. `used` holds the directory's ACTUAL entry names,
 * lower-cased: a folder is its stem, a file its stem plus `entrySuffix`. So a
 * folder titled `Plan.md` and a file titled `Plan` (written `Plan.md`) clash,
 * while a folder `Plan/` and a file `Plan.md` - different names on disk - do
 * not.
 */
function claimEntry(
  stem: string,
  entrySuffix: string,
  used: Set<string>,
): string {
  let candidate = stem;
  let suffix = 2;
  while (used.has(`${candidate}${entrySuffix}`.toLocaleLowerCase("en-US"))) {
    candidate = `${stem} (${suffix})`;
    suffix += 1;
  }
  used.add(`${candidate}${entrySuffix}`.toLocaleLowerCase("en-US"));
  return candidate;
}

/**
 * One archive path per source, in request order.
 *
 * A leaf is `<stem>.<ext>` in its parent's directory. A source with children
 * becomes a folder `<stem>/` holding its own `<stem>.<ext>` and its children,
 * so the parent travels with what is nested under it. Entry names are unique
 * per directory, case-insensitively, since most archives are unpacked onto
 * case-insensitive filesystems; a folder and a file are compared by the names
 * they actually take on disk.
 *
 * Stems shrink with depth so every path stays within `ARCHIVE_PATH_BUDGET`. A
 * leaf may take whatever its directory leaves; a folder's stem appears twice in
 * its own file's path and must leave room for its children, so it takes a third.
 * Shallow exports keep the 120-character stems a flat export has always had.
 */
function archivePaths(
  artifacts: ReadonlyArray<ArtifactExportSource>,
  extension: "md" | "pdf",
): string[] {
  const ids = new Set(artifacts.map((artifact) => artifact.id));
  const childrenByParent = new Map<string, number[]>();
  const rootIndexes: number[] = [];
  artifacts.forEach((artifact, index) => {
    const { parentId } = artifact;
    if (parentId === null || parentId === artifact.id || !ids.has(parentId)) {
      rootIndexes.push(index);
      return;
    }
    const siblings = childrenByParent.get(parentId);
    if (siblings === undefined) {
      childrenByParent.set(parentId, [index]);
    } else {
      siblings.push(index);
    }
  });

  // Every placed path is non-empty, so "" doubles as "not placed yet".
  const paths = artifacts.map(() => "");
  const foldered = new Set<string>();
  const place = (
    indexes: readonly number[],
    directory: string,
    used: Set<string>,
  ): void => {
    for (const index of indexes) {
      if (paths[index] !== "") continue;
      const artifact = artifacts[index];
      // A repeated id is one artifact: its children go under the first copy.
      // A child already placed (the far end of a cycle) earns no folder.
      const children = foldered.has(artifact.id)
        ? []
        : (childrenByParent.get(artifact.id) ?? []).filter(
            (child) => child !== index && paths[child] === "",
          );
      foldered.add(artifact.id);
      const fileSuffix = `.${extension}`;
      const available =
        ARCHIVE_PATH_BUDGET -
        directory.length -
        fileSuffix.length -
        COLLISION_SUFFIX_RESERVE;
      const isFolder = children.length > 0;
      const stemBudget = Math.max(
        MIN_BUDGETED_STEM,
        isFolder ? Math.floor((available - 1) / 3) : available,
      );
      const baseStem = truncateStem(safeFileStem(artifact.title), stemBudget);
      if (!isFolder) {
        const stem = claimEntry(baseStem, fileSuffix, used);
        paths[index] = `${directory}${stem}${fileSuffix}`;
        continue;
      }
      const stem = claimEntry(baseStem, "", used);
      const folder = `${directory}${stem}/`;
      paths[index] = `${folder}${stem}${fileSuffix}`;
      place(
        children,
        folder,
        new Set([`${stem}${fileSuffix}`.toLocaleLowerCase("en-US")]),
      );
    }
  };
  const rootNames = new Set<string>();
  place(rootIndexes, "", rootNames);
  // A parent cycle has no root to be reached from; its members export at the
  // top level rather than silently dropping out of the archive.
  place(
    artifacts.map((_, index) => index),
    "",
    rootNames,
  );
  return paths;
}

function requireAvailableMarkdown(artifact: ArtifactExportSource): string {
  if (artifact.markdown === null) {
    throw new Error(`Artifact "${artifact.title}" is unavailable for export.`);
  }
  return artifact.markdown;
}

/**
 * The body of one artifact, as the export format wants it.
 *
 * Exported because the read and the build are now separate steps: the caller
 * serializes each artifact while it holds that one lease, and hands the text
 * on. Same serializer the builder used inline before, so the bytes are
 * unchanged.
 */
export function serializeArtifactMarkdown(fragment: Y.XmlFragment): string {
  return artifactDocumentBundle.markdown.serialize(fragment);
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
  const filenames = archivePaths(request.artifacts, extension);
  const markdownFiles = request.artifacts.map((artifact) =>
    requireAvailableMarkdown(artifact),
  );
  // One conversion at a time: a nested export has no cap on its size, and
  // starting every PDF build together would make the whole selection's layout
  // work concurrent.
  const fileBytes: Uint8Array<ArrayBuffer>[] = [];
  for (const markdown of markdownFiles) {
    fileBytes.push(await exportFileBytes(request.format, markdown));
  }
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
