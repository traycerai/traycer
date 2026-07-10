import type * as Y from "yjs";
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
  const normalized = title
    .normalize("NFKC")
    .split("")
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

function loadPdfMake(): Promise<typeof import("pdfmake")> {
  if (pdfMakePromise === null) {
    pdfMakePromise = Promise.all([
      import("pdfmake/build/pdfmake"),
      import("pdfmake/build/vfs_fonts"),
    ]).then(([pdfMakeModule, vfsModule]) => {
      pdfMakeModule.default.addVirtualFileSystem(vfsModule.default);
      return pdfMakeModule.default;
    });
  }
  return pdfMakePromise;
}

async function pdfBytes(markdown: string): Promise<Uint8Array<ArrayBuffer>> {
  const pdfMake = await loadPdfMake();
  const blob = await pdfMake
    .createPdf({
      content: [{ text: markdown, fontSize: 11, lineHeight: 1.25 }],
      defaultStyle: { font: "Roboto" },
    })
    .getBlob();
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
