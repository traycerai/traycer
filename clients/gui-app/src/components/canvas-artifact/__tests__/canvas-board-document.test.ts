import { describe, expect, it, vi } from "vitest";
import { parseHtmlSource } from "@traycer/html-source";
import type { SandboxSource } from "@/components/sandbox/sandbox-frame";
import type { CanvasElement } from "@/lib/sandbox/canvas-bridge";
import {
  canvasSourceElement,
  canvasSourceOuterHtml,
  canvasTextDraftTarget,
  readCanvasBoardDocument,
  type CanvasBoardDocument,
} from "../canvas-board-document";

const RANGE_MAX = 4 * 1024 * 1024;
const TEXT_MAX = 25 * 1024 * 1024;
const OUTER_HTML_MAX = 65_536;
const ENTRY = "boards/home.html";

function documentOf(text: string): CanvasBoardDocument {
  return { sha256: "sha", text, parsed: parseHtmlSource(text) };
}

function pageElement(overrides: Partial<CanvasElement>): CanvasElement {
  return {
    marker: null,
    tid: null,
    tagName: "p",
    selector: "p",
    elementId: null,
    classNames: [],
    textPreview: "",
    inlineStyle: "",
    ariaRole: null,
    accessibleName: null,
    box: { x: 0, y: 0, width: 10, height: 10 },
    computedStyles: [],
    generated: false,
    ...overrides,
  };
}

/** The element a canvas page would report for the tag that starts at `needle`. */
function byMarker(
  text: string,
  needle: string,
  tagName: string,
): CanvasElement {
  const marker = text.indexOf(needle);
  if (marker < 0) throw new Error(`no ${needle} in the fixture`);
  return pageElement({ marker, tagName, generated: false });
}

const PAGE = [
  `<main>`,
  `<p data-tid="lead">Hello <b>big</b> world</p>`,
  `<p>Plain</p>`,
  `<h1 data-tid="title">Title <i>x</i></h1>`,
  `<p data-tid="empty"></p>`,
  `<img src="a.png">`,
  `<script>var a = 1;</script>`,
  `<p data-tid="twin">one</p><p data-tid="twin">two</p>`,
  `</main>`,
].join("");

describe("canvasSourceElement", () => {
  const board = documentOf(PAGE);

  it("finds an element by its tid", () => {
    const found = canvasSourceElement(board, pageElement({ tid: "lead" }));
    expect(found?.tagName).toBe("p");
    expect(found?.effectiveTid).toBe("lead");
  });

  it("finds an element without a tid by its source offset and tag", () => {
    const found = canvasSourceElement(board, byMarker(PAGE, "<p>Plain", "p"));
    expect(found?.startTag?.start).toBe(PAGE.indexOf("<p>Plain"));
  });

  it("prefers the tid over a marker that points elsewhere", () => {
    const found = canvasSourceElement(
      board,
      pageElement({ tid: "lead", marker: PAGE.indexOf("<p>Plain") }),
    );
    expect(found?.effectiveTid).toBe("lead");
  });

  it("refuses a marker whose tag does not match the source", () => {
    expect(
      canvasSourceElement(board, byMarker(PAGE, "<p>Plain", "div")),
    ).toBeNull();
  });

  it.each([
    ["an offset that starts no tag", pageElement({ marker: 3 })],
    ["no marker and no tid", pageElement({})],
    ["a tid the source does not have", pageElement({ tid: "missing" })],
    ["a tid shared by two elements", pageElement({ tid: "twin" })],
  ])("refuses %s", (_label, element) => {
    expect(canvasSourceElement(board, element)).toBeNull();
  });

  it("refuses an element the page generated, even when its tid exists", () => {
    expect(
      canvasSourceElement(board, pageElement({ tid: "lead", generated: true })),
    ).toBeNull();
  });

  it("refuses an element the parser had to imply", () => {
    // <tbody> is inserted by the parser; no source tag stands behind it.
    const table = documentOf("<table><tr><td>x</td></tr></table>");
    expect(
      canvasSourceElement(
        table,
        pageElement({ marker: null, tagName: "tbody" }),
      ),
    ).toBeNull();
  });
});

describe("canvasTextDraftTarget", () => {
  const board = documentOf(PAGE);
  const draftOf = (element: CanvasElement) => {
    const node = canvasSourceElement(board, element);
    if (node === null) throw new Error("fixture element not found");
    return canvasTextDraftTarget(node);
  };

  it("edits the whole text of an element that holds only text", () => {
    expect(draftOf(byMarker(PAGE, "<p>Plain", "p"))).toEqual({
      text: "Plain",
      textNodeIndex: null,
    });
  });

  it("edits an empty element as empty text", () => {
    expect(draftOf(pageElement({ tid: "empty" }))).toEqual({
      text: "",
      textNodeIndex: null,
    });
  });

  it("edits the single text node beside element children without touching them", () => {
    expect(draftOf(pageElement({ tid: "title", tagName: "h1" }))).toEqual({
      text: "Title ",
      textNodeIndex: 0,
    });
  });

  it("refuses text interleaved with elements, which one text box cannot rewrite", () => {
    expect(draftOf(pageElement({ tid: "lead" }))).toBeNull();
  });

  it("refuses a void element", () => {
    expect(draftOf(byMarker(PAGE, "<img", "img"))).toBeNull();
  });

  it("refuses an element whose contents are not markup", () => {
    expect(draftOf(byMarker(PAGE, "<script", "script"))).toBeNull();
  });

  it("refuses an element the source never closes", () => {
    const text = "<div><p>unclosed</div>";
    const open = documentOf(text);
    const node = canvasSourceElement(open, byMarker(text, "<p>", "p"));
    // The parser closes it implicitly, so no end tag stands in the source to
    // edit between.
    expect(node).not.toBeNull();
    expect(node === null ? null : canvasTextDraftTarget(node)).toBeNull();
  });
});

describe("canvasSourceOuterHtml", () => {
  it("returns the element exactly as authored, children included", () => {
    const board = documentOf(PAGE);
    expect(canvasSourceOuterHtml(board, pageElement({ tid: "lead" }))).toBe(
      `<p data-tid="lead">Hello <b>big</b> world</p>`,
    );
  });

  it("keeps the author's casing and quoting instead of the parser's", () => {
    const text = `<P CLASS='x' data-tid="odd">Hi</P>`;
    expect(
      canvasSourceOuterHtml(documentOf(text), pageElement({ tid: "odd" })),
    ).toBe(text);
  });

  it("returns a void element's tag alone", () => {
    expect(
      canvasSourceOuterHtml(documentOf(PAGE), byMarker(PAGE, "<img", "img")),
    ).toBe(`<img src="a.png">`);
  });

  it.each([
    ["a generated element", pageElement({ tid: "lead", generated: true })],
    ["an ambiguous tid", pageElement({ tid: "twin" })],
    ["an unknown tid", pageElement({ tid: "missing" })],
  ])("returns null for %s", (_label, element) => {
    expect(canvasSourceOuterHtml(documentOf(PAGE), element)).toBeNull();
  });

  it("returns markup of exactly 65536 bytes and null one byte past it", () => {
    const shell = `<p data-tid="big"></p>`;
    const padFor = (bytes: number): string =>
      `<p data-tid="big">${"a".repeat(bytes - shell.length)}</p>`;
    const element = pageElement({ tid: "big" });

    const exact = padFor(OUTER_HTML_MAX);
    expect(canvasSourceOuterHtml(documentOf(exact), element)).toBe(exact);
    expect(
      canvasSourceOuterHtml(documentOf(padFor(OUTER_HTML_MAX + 1)), element),
    ).toBeNull();
  });

  it("counts bytes, not characters, against the cap", () => {
    const text = `<p data-tid="wide">${"€".repeat(30_000)}</p>`;
    expect(text.length).toBeLessThan(OUTER_HTML_MAX);
    expect(
      canvasSourceOuterHtml(documentOf(text), pageElement({ tid: "wide" })),
    ).toBeNull();
  });
});

interface FakeFile {
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

type ArtifactReadSpan = Extract<
  SandboxSource,
  { kind: "artifact" }
>["readSpan"];

function artifactSource(
  file: FakeFile,
  readSpan: ArtifactReadSpan,
): SandboxSource {
  return artifactSourceSized(file, readSpan, file.bytes.length);
}

/** The manifest's size can disagree with the bytes, which is the point of some tests. */
function artifactSourceSized(
  file: FakeFile,
  readSpan: ArtifactReadSpan,
  byteLength: number,
): SandboxSource {
  return {
    kind: "artifact",
    artifactId: "canvas-1",
    treePath: "",
    entryPath: ENTRY,
    manifest: {
      files: {
        [ENTRY]: { sha256: file.sha256, byteLength, mediaType: "text/html" },
      },
    },
    readSpan,
    resolveOutsideReference: () => null,
  };
}

function servingWholeFile(file: FakeFile) {
  return vi.fn(
    (
      _sha: string,
      offset: number,
      length: number,
    ): Promise<{
      bytes: Uint8Array;
      totalBytes: number;
      mediaType: string;
    }> =>
      Promise.resolve({
        bytes: file.bytes.slice(offset, offset + length),
        totalBytes: file.bytes.length,
        mediaType: "text/html",
      }),
  );
}

function fileOf(text: string): FakeFile {
  return { bytes: new TextEncoder().encode(text), sha256: "f".repeat(64) };
}

describe("readCanvasBoardDocument", () => {
  const signal = new AbortController().signal;

  it("returns the file's hash, its exact text and a parse of that text", async () => {
    const file = fileOf(`<p data-tid="a">héllo</p>`);
    const board = await readCanvasBoardDocument(
      artifactSource(file, servingWholeFile(file)),
      signal,
    );
    expect(board.sha256).toBe(file.sha256);
    expect(board.text).toBe(`<p data-tid="a">héllo</p>`);
    expect(
      board.parsed.elements.some((node) => node.effectiveTid === "a"),
    ).toBe(true);
  });

  it("reads the span of the manifest's hash", async () => {
    const file = fileOf("<p>x</p>");
    const readSpan = servingWholeFile(file);
    await readCanvasBoardDocument(artifactSource(file, readSpan), signal);
    expect(readSpan).toHaveBeenCalledWith(
      file.sha256,
      0,
      file.bytes.length,
      signal,
    );
  });

  it("keeps a leading byte-order mark so markers stay offsets into the original file", async () => {
    const file = fileOf('﻿<p data-tid="a">x</p>');
    const board = await readCanvasBoardDocument(
      artifactSource(file, servingWholeFile(file)),
      signal,
    );
    expect(board.text.startsWith("﻿")).toBe(true);
    expect(
      board.parsed.elements.find((node) => node.effectiveTid === "a")?.startTag
        ?.start,
    ).toBe(1);
  });

  it("reads a file larger than one range in range-sized spans, in order", async () => {
    // A comment keeps the parse trivial; only the span arithmetic matters.
    const body = `<!--${"a".repeat(RANGE_MAX + 6)}-->`;
    const file = fileOf(body);
    const readSpan = servingWholeFile(file);
    const board = await readCanvasBoardDocument(
      artifactSource(file, readSpan),
      signal,
    );
    expect(board.text.length).toBe(body.length);
    expect(
      readSpan.mock.calls.map(([, offset, length]) => [offset, length]),
    ).toEqual([
      [0, RANGE_MAX],
      [RANGE_MAX, file.bytes.length - RANGE_MAX],
    ]);
  });

  it("refuses a source that is not an artifact", async () => {
    await expect(
      readCanvasBoardDocument({ kind: "html", html: "<p></p>" }, signal),
    ).rejects.toThrow("This artboard is unavailable.");
  });

  it("refuses an entry the manifest does not list", async () => {
    const file = fileOf("<p></p>");
    const source = artifactSource(file, servingWholeFile(file));
    if (source.kind !== "artifact") throw new Error("fixture");
    await expect(
      readCanvasBoardDocument(
        { ...source, entryPath: "boards/other.html" },
        signal,
      ),
    ).rejects.toThrow("This artboard is unavailable.");
  });

  it("refuses a file over the text limit without reading it", async () => {
    const file = fileOf("<p></p>");
    const readSpan = servingWholeFile(file);
    await expect(
      readCanvasBoardDocument(
        artifactSourceSized(file, readSpan, TEXT_MAX + 1),
        signal,
      ),
    ).rejects.toThrow("This artboard is too large to edit here.");
    expect(readSpan).not.toHaveBeenCalled();
  });

  it("refuses a span the host says is unavailable", async () => {
    const file = fileOf("<p></p>");
    await expect(
      readCanvasBoardDocument(
        artifactSource(file, () => Promise.resolve({ unavailable: "gone" })),
        signal,
      ),
    ).rejects.toThrow("This artboard is unavailable.");
  });

  it.each([
    [
      "a total that disagrees with the manifest",
      (file: FakeFile) => ({
        bytes: file.bytes,
        totalBytes: file.bytes.length + 1,
        mediaType: "text/html",
      }),
    ],
    [
      "an empty span, which would never finish",
      (file: FakeFile) => ({
        bytes: new Uint8Array(0),
        totalBytes: file.bytes.length,
        mediaType: "text/html",
      }),
    ],
    [
      "more bytes than were asked for",
      (file: FakeFile) => ({
        bytes: new Uint8Array(file.bytes.length + 1),
        totalBytes: file.bytes.length,
        mediaType: "text/html",
      }),
    ],
  ])("refuses %s", async (_label, answer) => {
    const file = fileOf("<p>some text</p>");
    await expect(
      readCanvasBoardDocument(
        artifactSource(file, () => Promise.resolve(answer(file))),
        signal,
      ),
    ).rejects.toThrow("The artboard could not be read. Try again.");
  });

  it("refuses bytes that are not valid UTF-8 rather than guessing", async () => {
    const file: FakeFile = {
      bytes: new Uint8Array([0x3c, 0xff, 0xfe]),
      sha256: "f".repeat(64),
    };
    await expect(
      readCanvasBoardDocument(
        artifactSource(file, servingWholeFile(file)),
        signal,
      ),
    ).rejects.toThrow();
  });

  it("stops when the caller aborts", async () => {
    const file = fileOf("<p></p>");
    const controller = new AbortController();
    controller.abort();
    await expect(
      readCanvasBoardDocument(
        artifactSource(file, servingWholeFile(file)),
        controller.signal,
      ),
    ).rejects.toThrow();
  });
});
