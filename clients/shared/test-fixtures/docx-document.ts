/**
 * A real, minimal Word document, built from a description of its text.
 *
 * The `.docx` preview pipeline has three layers that each want different
 * things from a fixture: the host sniffs the ZIP header and streams the
 * bytes, the client reassembles them byte for byte, and the renderer unpacks
 * the OOXML package and lays it out. A hand-assembled `PK\x03\x04` prefix
 * satisfies only the first; a binary checked in from Word satisfies all
 * three but cannot say WHAT it contains, so a test asserting that a phrase
 * split across two runs is found would be asserting against bytes nobody can
 * read. This builder writes the package itself - `[Content_Types].xml`, the
 * package relationships, `word/document.xml`, optionally one inline PNG -
 * as a STORED (uncompressed) ZIP, so the fixture is legible in the test that
 * uses it and needs no zip dependency in either tree that imports it.
 *
 * Platform-neutral on purpose: it runs in the host-side e2e suites under
 * Node and in the browser regression fixture under Chrome, so it uses only
 * `TextEncoder` and typed arrays.
 */

/** One paragraph, as the runs Word would split it into. */
export type DocxFixtureParagraph = readonly string[];

export interface DocxFixturePage {
  readonly paragraphs: readonly DocxFixtureParagraph[];
}

export interface DocxFixtureSpec {
  /** Pages, separated by explicit page breaks in the document body. */
  readonly pages: readonly DocxFixturePage[];
  /**
   * PNG bytes to embed as an inline picture at the end of the FIRST page,
   * or `null` for a text-only document. Embedded through the same
   * `word/media` + relationship + content-type triple Word writes, which is
   * what makes the renderer's image path reachable from a fixture.
   */
  readonly inlineImagePng: Uint8Array | null;
}

export interface ZipEntrySpec {
  readonly name: string;
  readonly bytes: Uint8Array;
}

const WORD_MAIN_NAMESPACE =
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const RELATIONSHIPS_NAMESPACE =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE_RELATIONSHIPS_NAMESPACE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const IMAGE_RELATIONSHIP_ID = "rIdImage1";

export function buildDocxFixture(spec: DocxFixtureSpec): Uint8Array {
  const encoder = new TextEncoder();
  const hasImage = spec.inlineImagePng !== null;
  const entries: ZipEntrySpec[] = [
    {
      name: "[Content_Types].xml",
      bytes: encoder.encode(contentTypesXml(hasImage)),
    },
    { name: "_rels/.rels", bytes: encoder.encode(packageRelationshipsXml()) },
    {
      name: "word/document.xml",
      bytes: encoder.encode(documentXml(spec.pages, hasImage)),
    },
  ];
  if (spec.inlineImagePng !== null) {
    entries.push({
      name: "word/_rels/document.xml.rels",
      bytes: encoder.encode(documentRelationshipsXml()),
    });
    entries.push({ name: "word/media/image1.png", bytes: spec.inlineImagePng });
  }
  return buildStoredZip(entries);
}

function contentTypesXml(hasImage: boolean): string {
  const png = hasImage
    ? '<Default Extension="png" ContentType="image/png"/>'
    : "";
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    png +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    "</Types>"
  );
}

function packageRelationshipsXml(): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<Relationships xmlns="${RELATIONSHIPS_NAMESPACE}">` +
    `<Relationship Id="rId1" Type="${OFFICE_RELATIONSHIPS_NAMESPACE}/officeDocument" Target="word/document.xml"/>` +
    "</Relationships>"
  );
}

function documentRelationshipsXml(): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<Relationships xmlns="${RELATIONSHIPS_NAMESPACE}">` +
    `<Relationship Id="${IMAGE_RELATIONSHIP_ID}" Type="${OFFICE_RELATIONSHIPS_NAMESPACE}/image" Target="media/image1.png"/>` +
    "</Relationships>"
  );
}

function documentXml(
  pages: readonly DocxFixturePage[],
  hasImage: boolean,
): string {
  const body = pages
    .map((page, pageIndex) => {
      const paragraphs = page.paragraphs.map(paragraphXml).join("");
      const picture = hasImage && pageIndex === 0 ? inlinePictureXml() : "";
      const pageBreak =
        pageIndex < pages.length - 1
          ? '<w:p><w:r><w:br w:type="page"/></w:r></w:p>'
          : "";
      return paragraphs + picture + pageBreak;
    })
    .join("");
  // US Letter with one-inch margins, in twentieths of a point: the page
  // geometry the renderer lays out, and what fit-to-width measures against.
  const section =
    '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>' +
    '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>' +
    "</w:sectPr>";
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<w:document xmlns:w="${WORD_MAIN_NAMESPACE}" xmlns:r="${OFFICE_RELATIONSHIPS_NAMESPACE}"` +
    ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"' +
    ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"' +
    ' xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    `<w:body>${body}${section}</w:body></w:document>`
  );
}

/** Every run after the first is bold, so the split is a formatting boundary as it would be in Word. */
function paragraphXml(runs: DocxFixtureParagraph): string {
  const inner = runs
    .map((text, index) => {
      const properties = index === 0 ? "" : "<w:rPr><w:b/></w:rPr>";
      return `<w:r>${properties}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
    })
    .join("");
  return `<w:p>${inner}</w:p>`;
}

/** A one-inch square inline picture, in EMUs (914400 per inch). */
function inlinePictureXml(): string {
  return (
    "<w:p><w:r><w:drawing>" +
    '<wp:inline distT="0" distB="0" distL="0" distR="0">' +
    '<wp:extent cx="914400" cy="914400"/>' +
    '<wp:docPr id="1" name="Picture 1"/>' +
    "<a:graphic>" +
    '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    "<pic:pic>" +
    '<pic:nvPicPr><pic:cNvPr id="0" name="image1.png"/><pic:cNvPicPr/></pic:nvPicPr>' +
    `<pic:blipFill><a:blip r:embed="${IMAGE_RELATIONSHIP_ID}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm>' +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
    "</pic:pic></a:graphicData></a:graphic></wp:inline>" +
    "</w:drawing></w:r></w:p>"
  );
}

function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * A ZIP archive with every entry STORED, no compression.
 *
 * Exported on its own so a test can build an archive that is a valid ZIP but
 * NOT a Word document - the case the host admits on its `PK\x03\x04` sniff
 * and only the renderer can reject.
 */
export function buildStoredZip(entries: readonly ZipEntrySpec[]): Uint8Array {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.bytes);
    const local = new ByteWriter(30 + name.byteLength);
    local.u32(0x04034b50);
    local.u16(20); // version needed: 2.0
    local.u16(0); // flags
    local.u16(0); // method: stored
    local.u16(0); // modification time
    local.u16(0x0021); // modification date: 1980-01-01
    local.u32(crc);
    local.u32(entry.bytes.byteLength);
    local.u32(entry.bytes.byteLength);
    local.u16(name.byteLength);
    local.u16(0); // extra length
    local.bytes(name);
    localParts.push(local.done(), entry.bytes);

    const central = new ByteWriter(46 + name.byteLength);
    central.u32(0x02014b50);
    central.u16(20); // version made by
    central.u16(20); // version needed
    central.u16(0);
    central.u16(0);
    central.u16(0);
    central.u16(0x0021);
    central.u32(crc);
    central.u32(entry.bytes.byteLength);
    central.u32(entry.bytes.byteLength);
    central.u16(name.byteLength);
    central.u16(0); // extra length
    central.u16(0); // comment length
    central.u16(0); // disk number
    central.u16(0); // internal attributes
    central.u32(0); // external attributes
    central.u32(offset);
    central.bytes(name);
    centralParts.push(central.done());

    offset += 30 + name.byteLength + entry.bytes.byteLength;
  }
  const centralSize = centralParts.reduce(
    (total, part) => total + part.byteLength,
    0,
  );
  const end = new ByteWriter(22);
  end.u32(0x06054b50);
  end.u16(0);
  end.u16(0);
  end.u16(entries.length);
  end.u16(entries.length);
  end.u32(centralSize);
  end.u32(offset);
  end.u16(0);
  return concat([...localParts, ...centralParts, end.done()]);
}

class ByteWriter {
  private readonly view: DataView;
  private readonly buffer: Uint8Array;
  private position = 0;

  constructor(size: number) {
    this.buffer = new Uint8Array(size);
    this.view = new DataView(this.buffer.buffer);
  }

  u16(value: number): void {
    this.view.setUint16(this.position, value, true);
    this.position += 2;
  }

  u32(value: number): void {
    this.view.setUint32(this.position, value, true);
    this.position += 4;
  }

  bytes(value: Uint8Array): void {
    this.buffer.set(value, this.position);
    this.position += value.byteLength;
  }

  done(): Uint8Array {
    return this.buffer;
  }
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let position = 0;
  for (const part of parts) {
    out.set(part, position);
    position += part.byteLength;
  }
  return out;
}

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
