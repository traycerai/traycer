import { describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import {
  decodeUnresolvedArtifactImageText,
  jsonContentToArtifactMarkdown,
  jsonContentToMarkdown,
  unresolvedArtifactImageText,
} from "@traycer/protocol/common/json-content-serializer";
import {
  READERS,
  guiReader,
  imageAttrsOf,
  onlyImageOf,
  textsOf,
  type IngestReader,
} from "./artifact-ingest-readers";

/**
 * The artifact serializer never asks a reader at runtime: it writes an
 * unresolved image's fallback text raw when the producer's exact decoder
 * accepts it and the container is one where the readers keep the image. These
 * tests are where that rule meets the two real readers, each through an
 * attached Yjs document: the artifact editor's own manager and schema, and the
 * host converter's stock options. Where the serializer and a reader disagree,
 * the row fails and says what each side did.
 */

const OPTIONS = { mentionFormat: "llm", platform: "POSIX" } as const;
const BS = "\\";

function serialize(content: JsonContent): string {
  return jsonContentToArtifactMarkdown(content, OPTIONS);
}

const P = (value: string): JsonContent => ({
  type: "paragraph",
  content: [{ type: "text", text: value }],
});
const doc = (...content: JsonContent[]): JsonContent => ({
  type: "doc",
  content,
});

// ---------------------------------------------------------------------------
// 1. Producer / reader agreement
// ---------------------------------------------------------------------------

const ALPHABET = [
  "a",
  " ",
  BS,
  "[",
  "]",
  "`",
  "|",
  "\n",
  "\r",
  "<",
  ">",
  "(",
  ")",
  "*",
  "#",
  "-",
  "1",
  "&",
];

const SRCS: readonly string[] = [
  "images/x.png",
  "images/a b.png",
  "images/a(b).png",
  "images/a<b.png",
  "images/a>b.png",
  `images/a${BS}b.png`,
  `images/a${BS}*b.png`,
  `images/a${BS}_b.png`,
  "images/a&amp;b.png",
  "images/a%20b.png",
  "images/ b.png",
  "images/a\tb.png",
];

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function shortAlts(): string[] {
  const out: string[] = [""];
  let layer: string[] = [""];
  for (let length = 1; length <= 3; length++) {
    layer = layer.flatMap((prefix) => ALPHABET.map((char) => prefix + char));
    out.push(...layer);
  }
  return out;
}

function depthAlts(): string[] {
  const out: string[] = [];
  for (let depth = 0; depth <= 5; depth++) {
    out.push(`${"[".repeat(depth)}x${"]".repeat(depth)}`);
  }
  return out;
}

function sampledAlts(count: number): string[] {
  const next = seeded(1563);
  const out: string[] = [];
  for (let index = 0; index < count; index++) {
    const length = 4 + Math.floor(next() * 9);
    let alt = "";
    for (let at = 0; at < length; at++) {
      alt += ALPHABET[Math.floor(next() * ALPHABET.length)];
    }
    out.push(alt);
  }
  return out;
}

interface Pair {
  readonly alt: string;
  readonly src: string;
}

function agreementPairs(): Pair[] {
  const pairs: Pair[] = [];
  const first = SRCS[0] ?? "";
  for (const alt of [...shortAlts(), ...depthAlts()]) {
    pairs.push({ alt, src: first });
  }
  const next = seeded(42);
  for (const alt of sampledAlts(500)) {
    pairs.push({ alt, src: SRCS[Math.floor(next() * SRCS.length)] ?? first });
  }
  const plainAlts = ["", "a", "a b", "a[b]", "a|b", "a\nb", "`x`", "a ``]`` b"];
  for (const src of SRCS) {
    for (const alt of plainAlts) pairs.push({ alt, src });
  }
  return pairs;
}

describe("producer and readers agree on every fallback the decoder accepts", () => {
  const pairs = agreementPairs();

  it.each(READERS.map((reader) => [reader.name, reader] as const))(
    "%s reads each accepted producer text as exactly one image with that alt and source",
    (_name, reader) => {
      const failures: string[] = [];
      let accepted = 0;
      for (const { alt, src } of pairs) {
        const text = unresolvedArtifactImageText(alt, src);
        const decoded = decodeUnresolvedArtifactImageText(text);
        if (decoded === null) continue;
        accepted++;
        // The decoder never returns another image.
        expect(decoded).toEqual({ alt, src });
        const read = onlyImageOf(reader.stored(text));
        if (read === null || read.alt !== alt || read.src !== src) {
          failures.push(
            `alt=${JSON.stringify(alt)} src=${JSON.stringify(src)} text=${JSON.stringify(text)} read=${JSON.stringify(read)}`,
          );
        }
      }
      expect(accepted).toBeGreaterThan(3000);
      expect(failures).toEqual([]);
    },
  );

  const mustAccept: readonly (readonly [string, string, string])[] = [
    ["plain", "a", "images/x.png"],
    ["empty", "", "images/x.png"],
    ["spaces", "a b c", "images/x.png"],
    ["pipes", "a | b", "images/x.png"],
    ["a backslash", `a ${BS} b`, "images/x.png"],
    ["a simple multiline label", "a\nb", "images/x.png"],
    ["a one-backtick code span", "a `b` c", "images/x.png"],
    [
      "a two-backtick code span holding a bracket (review case)",
      "a ``]`` b",
      "images/missing.png",
    ],
    [
      "a three-backtick code span holding a bracket",
      "a ```]``` b",
      "images/missing.png",
    ],
    ["an alt that is a code span", "`x`", "images/missing.png"],
    ["brackets one level deep", "a[b]", "x"],
    ["brackets two levels deep", "a[b[c]]", "x"],
    ["a source with a space", "a", "images/a b.png"],
    ["a source with parentheses", "a", "x(1).png"],
    ["a source with an angle bracket", "a", "images/a<b.png"],
    ["a source with a closing angle bracket", "a b", "images/a b>.png"],
    ["a source with a backslash", "a", `images/a${BS}b.png`],
    [
      "a source with a doubled backslash and a space",
      "a",
      `images/a${BS}${BS}b c.png`,
    ],
    ["a source with a backslash and an asterisk", "a", `images/a${BS}*b.png`],
    ["a source with a backslash and an underscore", "a", `images/a${BS}_b.png`],
    ["a source with an entity", "a", "images/a&amp;b.png"],
    ["a source with a percent escape", "a", "images/a%20b.png"],
    ["a source with a no-break space", "a", "images/ b.png"],
    ["a source with a tab", "a", "images/a\tb.png"],
  ];

  it.each(
    mustAccept.flatMap(([name, alt, src]) =>
      READERS.map((reader) => [name, reader, alt, src] as const),
    ),
  )("%s: accepted, and read as that image by %s", (_name, reader, alt, src) => {
    const text = unresolvedArtifactImageText(alt, src);
    expect(decodeUnresolvedArtifactImageText(text)).toEqual({ alt, src });
    expect(onlyImageOf(reader.stored(text))).toEqual({ alt, src });
  });
});

// ---------------------------------------------------------------------------
// 2. Container differential
// ---------------------------------------------------------------------------

const FALLBACK = unresolvedArtifactImageText("a", "images/x.png");
const FALLBACK_MULTI = unresolvedArtifactImageText("a\nb", "images/x.png");

const li = (...content: JsonContent[]): JsonContent => ({
  type: "listItem",
  content,
});
const ti = (...content: JsonContent[]): JsonContent => ({
  type: "taskItem",
  attrs: { checked: false },
  content,
});
const ul = (...items: JsonContent[]): JsonContent => ({
  type: "bulletList",
  content: items,
});
const ol = (...items: JsonContent[]): JsonContent => ({
  type: "orderedList",
  attrs: { start: 1, type: null },
  content: items,
});
const tl = (...items: JsonContent[]): JsonContent => ({
  type: "taskList",
  content: items,
});
const bq = (...content: JsonContent[]): JsonContent => ({
  type: "blockquote",
  content,
});
const H = (value: string): JsonContent => ({
  type: "heading",
  attrs: { level: 1 },
  content: [{ type: "text", text: value }],
});
const cell = (type: string, block: JsonContent): JsonContent => ({
  type,
  content: [block],
});
const table = (block: JsonContent): JsonContent => ({
  type: "table",
  content: [
    { type: "tableRow", content: [cell("tableHeader", P("h"))] },
    { type: "tableRow", content: [cell("tableCell", block)] },
  ],
});

/** The 45 containers; `fallback` is the paragraph under test. */
function containers(
  fallback: JsonContent,
): readonly (readonly [string, JsonContent])[] {
  const T = P("t");
  const U = P("u");
  return [
    ["top level", doc(fallback)],
    ["top level after a paragraph", doc(T, fallback)],
    ["after a heading", doc(H("h"), fallback)],
    ["before a heading", doc(fallback, H("h"))],
    ["bullet item, first", doc(ul(li(fallback)))],
    ["bullet item, later", doc(ul(li(T, fallback)))],
    ["ordered item, first", doc(ol(li(fallback)))],
    ["ordered item, later", doc(ol(li(T, fallback)))],
    ["task item, first", doc(tl(ti(fallback)))],
    ["task item, later", doc(tl(ti(T, fallback)))],
    ["bullet > bullet", doc(ul(li(T, ul(li(fallback)))))],
    ["ordered > ordered", doc(ol(li(T, ol(li(fallback)))))],
    ["bullet > ordered", doc(ul(li(T, ol(li(fallback)))))],
    ["ordered > bullet", doc(ol(li(T, ul(li(fallback)))))],
    ["task > ordered", doc(tl(ti(T, ol(li(fallback)))))],
    ["ordered > task", doc(ol(li(T, tl(ti(fallback)))))],
    ["bullet > bullet > bullet", doc(ul(li(T, ul(li(T, ul(li(fallback)))))))],
    [
      "ordered > ordered > ordered",
      doc(ol(li(T, ol(li(T, ol(li(fallback))))))),
    ],
    ["ordered > bullet > ordered", doc(ol(li(T, ul(li(T, ol(li(fallback)))))))],
    ["quote", doc(bq(fallback))],
    ["quote, later", doc(bq(T, fallback))],
    ["quote > quote", doc(bq(bq(fallback)))],
    ["bullet > quote", doc(ul(li(T, bq(fallback))))],
    ["ordered > quote", doc(ol(li(T, bq(fallback))))],
    ["bullet item first > quote", doc(ul(li(bq(fallback))))],
    ["quote > bullet", doc(bq(ul(li(fallback))))],
    ["quote > ordered", doc(bq(ol(li(fallback))))],
    ["quote > task", doc(bq(tl(ti(fallback))))],
    ["table cell", doc(table(fallback))],
    ["bullet > bullet, later", doc(ul(li(T, ul(li(T, fallback)))))],
    ["ordered > ordered, later", doc(ol(li(T, ol(li(T, fallback)))))],
    ["bullet > ordered, later", doc(ul(li(T, ol(li(T, fallback)))))],
    ["ordered > bullet, later", doc(ol(li(T, ul(li(T, fallback)))))],
    ["bullet x3, later", doc(ul(li(T, ul(li(T, ul(li(T, fallback)))))))],
    ["quote > bullet, later", doc(bq(ul(li(T, fallback))))],
    ["quote > ordered, later", doc(bq(ol(li(T, fallback))))],
    ["bullet > quote > quote", doc(ul(li(T, bq(bq(fallback)))))],
    ["bullet > quote, later", doc(ul(li(T, bq(T, fallback))))],
    ["quote > bullet > quote", doc(bq(ul(li(T, bq(fallback)))))],
    ["bullet > bullet first > quote", doc(ul(li(T, ul(li(bq(fallback))))))],
    ["task > bullet, later", doc(tl(ti(T, ul(li(T, fallback)))))],
    ["task > quote", doc(tl(ti(T, bq(fallback))))],
    ["bullet, later of three", doc(ul(li(T, U, fallback)))],
    [
      "ordered start 10, later",
      doc({
        type: "orderedList",
        attrs: { start: 10, type: null },
        content: [li(T, fallback)],
      }),
    ],
    ["bullet second item, later", doc(ul(li(P("s")), li(T, fallback)))],
  ];
}

const [GUI, HOST] = READERS;

function keepsOneImage(
  reader: IngestReader,
  markdown: string,
  alt: string,
): boolean {
  const images = imageAttrsOf(reader.stored(markdown));
  return (
    images.length === 1 &&
    images[0]?.alt === alt &&
    images[0]?.src === "images/x.png"
  );
}

/** The fallback is raw in `markdown` when its `![` is not escaped there. */
function isRaw(markdown: string): boolean {
  return markdown.includes("![a");
}

/**
 * Containers the host's `documentSchema` cannot hold, so the host's whole
 * document reads back empty whatever is written in them: a task item's nested
 * list or quote (`taskItem: "(paragraph|taskList)+"`) and a list item that
 * opens with a quote (`listItem: "paragraph block*"`). It is the schema, not
 * the image: the control row below uses plain text, and the same four were
 * checked against the host's own converter (`convertMarkdownToYXmlFragment`
 * into an attached fragment, `convertYXmlFragmentToJsonContent`).
 */
const HOST_LOSES_THE_DOCUMENT_LIST: readonly string[] = [
  "task > ordered",
  "bullet item first > quote",
  "task > bullet, later",
  "task > quote",
];
const HOST_LOSES_THE_DOCUMENT: ReadonlySet<string> = new Set(
  HOST_LOSES_THE_DOCUMENT_LIST,
);

/**
 * A nested list item that opens with a quote: the host drops that item (and
 * only it) for the same reason, so the text written in it is gone but the
 * outer item stays. Checked against the host's converter with plain text.
 */
const HOST_LOSES_THE_ITEM: ReadonlySet<string> = new Set([
  "bullet > bullet first > quote",
]);

/**
 * Containers where the host's real converter drops a raw fallback's image and
 * this install's readers keep it. Raw markdown, per container:
 *
 * - `bullet > ordered, later`: `- t\n  1. t\n\n     ![a](images/x.png)`
 * - `ordered > bullet, later`: `1. t\n   - t\n\n     ![a](images/x.png)`
 *
 * What the real host converter stores (unpatched tiptap 3.31.x parse, then
 * `documentSchema`): for the first, the nested item's second block is a text
 * paragraph `"![a](images/x.png)"`, no image; for the second, the paragraph is
 * `[" ", image]` - an inline image inside a paragraph, which the schema drops.
 * This install's parser (patched tiptap 3.30.1) reads both as a nested item
 * `[paragraph, image]`, so no reader here can reproduce the host's parse. The
 * serializer escapes both, which is what the real host needs. The rows below
 * pin it in both directions: if an OSS reader stops keeping the raw image, the
 * pin fails and should be removed.
 */
const REAL_HOST_DROPS_OSS_READERS_KEEP: readonly string[] = [
  "bullet > ordered, later",
  "ordered > bullet, later",
];

const QUOTE_FIRST_ITEM: ReadonlySet<string> = new Set([
  "bullet item first > quote",
  "bullet > bullet first > quote",
]);

describe("containers: the serializer's raw-or-escaped decision against both readers (gui, host schema (documentSchema))", () => {
  const single = containers(P(FALLBACK));
  const multi = containers(P(FALLBACK_MULTI));

  it("has the 45 containers", () => {
    expect(single).toHaveLength(45);
    expect(multi.map(([name]) => name)).toEqual(single.map(([name]) => name));
  });

  // The GUI reader reads `- > x` as an item with an empty first paragraph
  // and a quote after it, which the serializer writes back as an empty marker
  // line and the quote below it. The host's parser opens that item with the
  // quote, which `documentSchema` refuses, so the host drops the item - with
  // plain text in the quote just the same. Not an image matter; pinned so the
  // pass-2 rows above can skip it knowingly.
  it("shows the host dropping an item that opens with a quote, plain text or fallback alike", () => {
    for (const quoted of ["x", "![a](images/x.png)"]) {
      const stored = HOST.stored(`- t\n- \n  > ${quoted}`);
      expect(textsOf(stored)).toEqual(["t"]);
      expect(imageAttrsOf(stored)).toEqual([]);
    }
    const stored = GUI.stored("- t\n- \n  > ![a](images/x.png)");
    expect(imageAttrsOf(stored)).toEqual([{ alt: "a", src: "images/x.png" }]);
  });

  it("shows the host losing the nested item, and only it, with plain text in it", () => {
    for (const [name, content] of containers(P("x"))) {
      if (!HOST_LOSES_THE_ITEM.has(name)) continue;
      expect(textsOf(HOST.stored(serialize(content)))).toEqual(["t"]);
      expect(textsOf(GUI.stored(serialize(content)))).toEqual(["t", "x"]);
    }
  });

  it("shows the host losing the whole document in those containers with plain text in them", () => {
    const lost = containers(P("x"))
      .filter(
        ([, content]) => HOST.stored(serialize(content)).content === undefined,
      )
      .map(([name]) => name);
    expect(lost).toEqual(HOST_LOSES_THE_DOCUMENT_LIST);
    for (const [name, content] of containers(P("x"))) {
      if (HOST_LOSES_THE_DOCUMENT.has(name)) continue;
      expect(GUI.stored(serialize(content)).content).toBeDefined();
    }
  });

  /**
   * The invariant for one markdown body: raw means both readers keep exactly
   * the one image; escaped means both keep the text and no image.
   */
  function expectKept(
    name: string,
    markdown: string,
    alt: string,
    label: string,
  ): void {
    if (isRaw(markdown)) {
      expect({
        label,
        gui: keepsOneImage(GUI, markdown, alt),
        host: keepsOneImage(HOST, markdown, alt),
      }).toEqual({ label, gui: true, host: true });
      return;
    }
    for (const reader of READERS) {
      const stored = reader.stored(markdown);
      if (reader === HOST && HOST_LOSES_THE_DOCUMENT.has(name)) {
        expect({ label, stored }).toEqual({ label, stored: { type: "doc" } });
        continue;
      }
      if (reader === HOST && HOST_LOSES_THE_ITEM.has(name)) {
        expect({
          label,
          images: imageAttrsOf(stored),
          texts: textsOf(stored),
        }).toEqual({ label, images: [], texts: ["t"] });
        continue;
      }
      expect({
        label,
        reader: reader.name,
        images: imageAttrsOf(stored),
      }).toEqual({ label, reader: reader.name, images: [] });
      expect(textsOf(stored).join("\n")).toContain(
        alt === "a" ? "[a](images/x.png)" : "[a",
      );
    }
  }

  describe.each([
    ["a single-line alt", single, "a"],
    ["a multiline alt", multi, "a\nb"],
  ] as const)("%s", (_label, list, alt) => {
    it.each(list.map(([name, content]) => [name, content] as const))(
      "%s",
      (name, content) => {
        const md1 = serialize(content);
        expectKept(name, md1, alt, "pass 1");
        if (isRaw(md1)) return;
        // What the readers store is written again by the same rule, and the
        // result is stable from there.
        for (const reader of READERS) {
          if (
            reader === HOST &&
            (HOST_LOSES_THE_DOCUMENT.has(name) || HOST_LOSES_THE_ITEM.has(name))
          ) {
            continue;
          }
          // The GUI reader gives a quote-first item an empty first paragraph,
          // and the serializer then writes the quote on a line of its own
          // behind an empty marker: see the row below for the host.
          if (QUOTE_FIRST_ITEM.has(name)) continue;
          const md2 = serialize(reader.stored(md1));
          expectKept(name, md2, alt, `pass 2 (${reader.name})`);
          expect(serialize(reader.stored(md2))).toBe(md2);
        }
      },
    );
  });

  // The serializer writes the fallback raw if and only if both readers keep
  // the image it reads back as, and the real host does too (the pinned list):
  // the escaped containers are the ones where at least one reader drops it,
  // which the same markdown with the fallback written raw shows.
  it.each(single.map(([name, content]) => [name, content] as const))(
    "%s: raw if and only if both readers keep the image written raw there",
    (name, content) => {
      const md = serialize(content);
      const rawMd = md.replace(`!${BS}[a](images/x.png)`, FALLBACK);
      const gui = keepsOneImage(GUI, rawMd, "a");
      const host = keepsOneImage(HOST, rawMd, "a");
      const pinned = REAL_HOST_DROPS_OSS_READERS_KEEP.includes(name);
      expect({ raw: isRaw(md), gui, host, pinned }).toEqual({
        raw: gui && host && !pinned,
        gui,
        host,
        pinned,
      });
    },
  );

  it("pins exactly the containers the real host drops and these readers keep", () => {
    const flipped = single
      .filter(([, content]) => {
        const md = serialize(content);
        const rawMd = md.replace(`!${BS}[a](images/x.png)`, FALLBACK);
        return (
          !isRaw(md) &&
          keepsOneImage(GUI, rawMd, "a") &&
          keepsOneImage(HOST, rawMd, "a")
        );
      })
      .map(([name]) => name);
    expect(flipped).toEqual(REAL_HOST_DROPS_OSS_READERS_KEEP);
  });

  it.each(REAL_HOST_DROPS_OSS_READERS_KEEP.map((name) => [name] as const))(
    "%s: escaped by the serializer, kept as text by both readers, and both would keep the image if it were raw",
    (name) => {
      for (const [alt, list] of [
        ["a", single],
        ["a\nb", multi],
      ] as const) {
        const content = list.find(([candidate]) => candidate === name)?.[1];
        if (content === undefined) throw new Error(`missing container ${name}`);
        const md = serialize(content);
        expect(isRaw(md)).toBe(false);
        const rawMd = md.replace(`!${BS}[a`, "![a");
        for (const reader of READERS) {
          const escaped = reader.stored(md);
          expect(imageAttrsOf(escaped)).toEqual([]);
          expect(textsOf(escaped).join("\n")).toContain(
            alt === "a" ? "[a](images/x.png)" : "[a",
          );
          expect(keepsOneImage(reader, rawMd, alt)).toBe(true);
        }
      }
    },
  );
});

// ---------------------------------------------------------------------------
// 3. Siblings: a fallback that is not the paragraph's only content stays text
// ---------------------------------------------------------------------------

describe("a fallback that shares its paragraph is escaped, and both readers keep it as text", () => {
  const text = (value: string): JsonContent => ({ type: "text", text: value });
  const hardBreak: JsonContent = { type: "hardBreak" };
  const rows: readonly (readonly [string, JsonContent, string])[] = [
    [
      "leading text",
      doc({
        type: "paragraph",
        content: [text(`x ${FALLBACK}`)],
      }),
      `x !${BS}[a](images/x.png)`,
    ],
    [
      "trailing text",
      doc({
        type: "paragraph",
        content: [text(`${FALLBACK} x`)],
      }),
      `!${BS}[a](images/x.png) x`,
    ],
    [
      "a hard break",
      doc({
        type: "paragraph",
        content: [text(FALLBACK), hardBreak, text("y")],
      }),
      `!${BS}[a](images/x.png)${BS}\ny`,
    ],
    [
      "two fallbacks in one paragraph",
      doc({
        type: "paragraph",
        content: [text(FALLBACK), text(FALLBACK)],
      }),
      `!${BS}[a](images/x.png)!${BS}[a](images/x.png)`,
    ],
    [
      "a mark on the text",
      doc({
        type: "paragraph",
        content: [{ type: "text", text: FALLBACK, marks: [{ type: "bold" }] }],
      }),
      `**!${BS}[a](images/x.png)**`,
    ],
    [
      "a heading",
      doc({
        type: "heading",
        attrs: { level: 1 },
        content: [text(FALLBACK)],
      }),
      `# !${BS}[a](images/x.png)`,
    ],
  ];

  it.each(
    rows.flatMap(([name, content, bytes]) =>
      READERS.map((reader) => [name, content, bytes, reader] as const),
    ),
  )("%s: escaped, kept as text by %s", (_name, content, bytes, reader) => {
    const md1 = serialize(content);
    expect(md1).toBe(bytes);
    const stored = reader.stored(md1);
    expect(imageAttrsOf(stored)).toEqual([]);
    expect(textsOf(stored).join("")).toContain("![a](images/x.png)");
    // Written again, the stored text is the same bytes.
    const md2 = serialize(stored);
    expect(serialize(reader.stored(md2))).toBe(md2);
    expect(md2).toBe(md1);
  });

  it.each(READERS.map((reader) => [reader.name, reader] as const))(
    "a fallback alone is raw at the top level and kept as one image by %s",
    (_name, reader) => {
      const md = serialize(doc(P(FALLBACK)));
      expect(md).toBe(FALLBACK);
      expect(onlyImageOf(reader.stored(md))).toEqual({
        alt: "a",
        src: "images/x.png",
      });
    },
  );
});

// ---------------------------------------------------------------------------
// 4. The review case
// ---------------------------------------------------------------------------

describe("identical text at the top level and in a bullet item, in one document", () => {
  const same = "![a](images/x.png)";
  const content = doc(P(same), ul(li(P(same))));

  it("writes the top level raw and the bullet item escaped", () => {
    expect(serialize(content)).toBe(
      `![a](images/x.png)\n\n- !${BS}[a](images/x.png)`,
    );
  });

  it.each(READERS.map((reader) => [reader.name, reader] as const))(
    "%s keeps one image and one text, and writes the same bytes again",
    (_name, reader) => {
      const md = serialize(content);
      const stored = reader.stored(md);
      expect(imageAttrsOf(stored)).toEqual([{ alt: "a", src: "images/x.png" }]);
      expect(textsOf(stored)).toEqual([same]);
      expect(serialize(stored)).toBe(md);
    },
  );
});

// ---------------------------------------------------------------------------
// 5. An image node's destination, written twice
// ---------------------------------------------------------------------------

describe("an image node's source survives two writes and two ingests", () => {
  const srcs: readonly string[] = [
    `images/a${BS}*b.png`,
    `images/a${BS}_b.png`,
    `images/a${BS}[b.png`,
    `images/a${BS}b.png`,
    `images/a b${BS}.png`,
  ];

  it.each(
    srcs.flatMap((src) => READERS.map((reader) => [src, reader] as const)),
  )("%j through %s", (src, reader) => {
    const node = doc({ type: "image", attrs: { src, alt: "a" } });
    const md1 = serialize(node);
    const stored1 = reader.stored(md1);
    expect(imageAttrsOf(stored1)).toEqual([{ alt: "a", src }]);
    const md2 = serialize(stored1);
    expect(md2).toBe(md1);
    const stored2 = reader.stored(md2);
    expect(imageAttrsOf(stored2)).toEqual([{ alt: "a", src }]);
    expect(serialize(stored2)).toBe(md1);
  });

  it("writes the review case's source in the bracketed form with its backslash escaped", () => {
    expect(
      serialize(
        doc({ type: "image", attrs: { src: `images/a${BS}*b.png`, alt: "a" } }),
      ),
    ).toBe(`![a](<images/a${BS}${BS}*b.png>)`);
  });
});

// ---------------------------------------------------------------------------
// 6. Timing: no reader call, one pass
// ---------------------------------------------------------------------------

describe("serializing a large body with a fallback in it is linear", () => {
  const KIB = 1024;
  const time = (content: JsonContent): number => {
    const start = performance.now();
    serialize(content);
    return performance.now() - start;
  };
  // The best of a few runs, so one scheduling hiccup is not the measurement.
  const best = (content: JsonContent): number =>
    Math.min(time(content), time(content), time(content));

  const paragraphs = (bytes: number): JsonContent => {
    const line = "word ".repeat(200).slice(0, 999) + ".";
    const blocks: JsonContent[] = [];
    for (let size = 0; size < bytes; size += line.length) {
      blocks.push(P(line));
    }
    blocks.push(P(FALLBACK));
    return doc(...blocks);
  };
  const backslashes = (bytes: number): JsonContent =>
    doc(P(BS.repeat(bytes)), P(FALLBACK));

  function guard(small: JsonContent, large: JsonContent): void {
    const smallTime = best(small);
    // The 256 KiB bound first: a quadratic pass fails here, in seconds,
    // rather than after the 1 MiB run.
    expect(smallTime).toBeLessThan(2000);
    const largeTime = best(large);
    expect(largeTime).toBeLessThan(2000);
    expect(largeTime).toBeLessThan(6 * smallTime + 50);
  }

  it("serializes 256 KiB and 1 MiB of 1000-character paragraphs plus one fallback", () => {
    guard(paragraphs(256 * KIB), paragraphs(1024 * KIB));
  });

  it("serializes a 256 KiB line of backslashes plus one fallback", () => {
    guard(backslashes(256 * KIB), backslashes(1024 * KIB));
  });

  it("writes the fallback raw in the large body", () => {
    expect(serialize(paragraphs(256 * KIB)).endsWith(`\n\n${FALLBACK}`)).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// 7. An image node after another block of a list or task item
// ---------------------------------------------------------------------------

describe("an image node that follows a block in a list item is its own block", () => {
  const SHOT = { alt: "shot", src: "images/0123abcd.png" };
  const shot: JsonContent = {
    type: "image",
    attrs: { src: SHOT.src, alt: SHOT.alt },
  };
  const code: JsonContent = {
    type: "codeBlock",
    attrs: { language: null },
    content: [{ type: "text", text: "c" }],
  };
  const t = P("t");

  const rows: readonly (readonly [string, JsonContent, string, number])[] = [
    ["a bullet item", doc(ul(li(t, shot))), `- t\n\n  ![shot](${SHOT.src})`, 1],
    [
      "an ordered item",
      doc(ol(li(t, shot))),
      `1. t\n\n   ![shot](${SHOT.src})`,
      1,
    ],
    [
      "a task item",
      doc(tl(ti(t, shot))),
      `- [ ] t\n\n  ![shot](${SHOT.src})`,
      1,
    ],
    [
      "a quote before the image, which must not take it in lazily",
      doc(ul(li(t, bq(P("q")), shot))),
      `- t\n  > q\n\n  ![shot](${SHOT.src})`,
      1,
    ],
    [
      "a nested item before the image, which must not take it in",
      doc(ul(li(t, ul(li(P("s"))), shot))),
      `- t\n  - s\n\n  ![shot](${SHOT.src})`,
      1,
    ],
    [
      "two images",
      doc(ul(li(t, shot, shot))),
      `- t\n\n  ![shot](${SHOT.src})\n\n  ![shot](${SHOT.src})`,
      2,
    ],
    [
      "a nested item",
      doc(ul(li(t, ul(li(P("s"), shot))))),
      `- t\n  - s\n\n    ![shot](${SHOT.src})`,
      1,
    ],
    [
      "an image after a paragraph inside a quote inside an item",
      doc(ul(li(t, bq(P("q"), shot)))),
      `- t\n  > q\n  >\n  > ![shot](${SHOT.src})`,
      1,
    ],
    [
      "an image alone in a quote inside an item",
      doc(ul(li(t, bq(shot)))),
      `- t\n  > ![shot](${SHOT.src})`,
      1,
    ],
  ];

  it.each(
    rows.flatMap(([name, content, bytes, count]) =>
      READERS.map((reader) => ({
        name,
        readerName: reader.name,
        content,
        bytes,
        count,
        reader,
      })),
    ),
  )(
    "$name: exact bytes and three passes through $readerName",
    ({ name, content, bytes, count, reader }) => {
      const expected = Array.from({ length: count }, () => SHOT);
      const md1 = serialize(content);
      expect(md1).toBe(bytes);
      const stored1 = reader.stored(md1);
      // `documentSchema`'s `taskItem` is `(paragraph|taskList)+`: it cannot
      // hold an image at all, with a blank line before it or without, and the
      // host's own converter reads the whole document back empty (checked on
      // the converter for both spellings). A schema limit, not the spelling.
      if (reader === HOST && name === "a task item") {
        expect(stored1).toEqual({ type: "doc" });
        return;
      }
      expect(imageAttrsOf(stored1)).toEqual(expected);
      const md2 = serialize(stored1);
      const stored2 = reader.stored(md2);
      expect(imageAttrsOf(stored2)).toEqual(expected);
      const md3 = serialize(stored2);
      const stored3 = reader.stored(md3);
      expect(imageAttrsOf(stored3)).toEqual(expected);
      expect(md2).toBe(md1);
      expect(md3).toBe(md2);
    },
  );

  it("leaves the prompt serializer's bullet item with an image tight", () => {
    expect(jsonContentToMarkdown(doc(ul(li(t, shot))), OPTIONS)).toBe(
      `- t\n  ![shot](${SHOT.src})`,
    );
  });

  it("gives a later code block no blank line, and a later quote none", () => {
    expect(serialize(doc(ul(li(t, code))))).toBe("- t\n  ```\n  c\n  ```");
    expect(serialize(doc(ul(li(t, bq(P("q"))))))).toBe("- t\n  > q");
  });
});

// ---------------------------------------------------------------------------
// 8. Later label lines, and entities
// ---------------------------------------------------------------------------

describe("a later label line: the decoder against both readers", () => {
  // Later lines the decoder accepts: each, written raw as the producer's text,
  // must be read back by both readers as exactly one image with that alt.
  const accepted: readonly string[] = [
    "[b]",
    `${BS}# b`,
    "*b*",
    "_b_",
    "+b",
    "-b",
    "=b",
    "|b|",
    "~b",
    "!b",
    "(b)",
    "&b",
    ":b",
    "`b`",
    "1.b",
    "#b",
    "####### b",
  ];

  it.each(
    accepted.flatMap((line) =>
      READERS.map((reader) => [line, reader.name, reader] as const),
    ),
  )(
    "accepted later line %j: read as one image by %s",
    (line, _name, reader) => {
      const alt = `a\n${line}`;
      const text = unresolvedArtifactImageText(alt, "images/x.png");
      expect(decodeUnresolvedArtifactImageText(text)).toEqual({
        alt,
        src: "images/x.png",
      });
      expect(onlyImageOf(reader.stored(text))).toEqual({
        alt,
        src: "images/x.png",
      });
    },
  );

  // Later lines the decoder rejects. `conservative` marks the rows where both
  // readers would still read exactly the one image: the rejection costs the
  // retry there and nothing else. Every other row is one where at least one
  // reader does not read the producer's text as that image.
  const rejected: readonly (readonly [string, string, boolean])[] = [
    ["# b", "an ATX heading", false],
    ["###### b", "a six-hash heading", false],
    ["- b", "a dash bullet", false],
    ["+ b", "a plus bullet", false],
    ["* b", "an asterisk bullet", false],
    ["-", "a lone dash", true],
    ["1. b", "an ordered item at 1", false],
    ["1) b", "an ordered item at 1 with a parenthesis", false],
    ["01. b", "an ordered item at 01", true],
    ["2. b", "an ordered item at 2", true],
    ["10) b", "an ordered item at 10", true],
    ["> b", "a quote", false],
    ["---", "a rule or setext underline", true],
    ["===", "a setext underline", true],
    ["***", "an asterisk rule", true],
    ["___", "an underscore rule", true],
    ["- - -", "a spaced rule", false],
    ["|-|", "a table delimiter row", true],
    [":-:", "an aligned delimiter cell", true],
    ["| --- |", "a spaced table delimiter row", true],
    ["<div>", "an HTML block", false],
    ["<b>", "an HTML tag", true],
    ["```", "a backtick fence", true],
    ["~~~", "a tilde fence", true],
    [" b", "a leading space", true],
  ];

  it.each(rejected)(
    "rejected later line %j (%s)",
    (line, _name, conservative) => {
      const alt = `a\n${line}`;
      const text = unresolvedArtifactImageText(alt, "images/x.png");
      expect(decodeUnresolvedArtifactImageText(text)).toBeNull();
      const reads = READERS.map(
        (reader) =>
          JSON.stringify(onlyImageOf(reader.stored(text))) ===
          JSON.stringify({ alt, src: "images/x.png" }),
      );
      expect({ line, bothRead: reads.every(Boolean) }).toEqual({
        line,
        bothRead: conservative,
      });
    },
  );

  it.each([
    ["a blank line between label lines", "a\n\nb", false],
    ["a previous line ending in a space", "a \nb", true],
    ["a previous line ending in a tab", "a\t\nb", true],
  ])("rejected: %s", (_name, alt, conservative) => {
    const text = unresolvedArtifactImageText(alt, "images/x.png");
    expect(decodeUnresolvedArtifactImageText(text)).toBeNull();
    const bothRead = READERS.every(
      (reader) =>
        JSON.stringify(onlyImageOf(reader.stored(text))) ===
        JSON.stringify({ alt, src: "images/x.png" }),
    );
    expect(bothRead).toBe(conservative);
  });
});

describe("entities in an alt or a source", () => {
  const rows: readonly (readonly [string, string])[] = [
    ["&amp;", "images/x.png"],
    ["a\n&amp;", "images/x.png"],
    ["&#35;", "images/x.png"],
    ["&lt;b&gt;", "images/x.png"],
    ["a", "images/a&amp;b.png"],
  ];

  it.each(
    rows.flatMap(([alt, src]) =>
      READERS.map((reader) => [alt, src, reader.name, reader] as const),
    ),
  )(
    "alt %j, src %j: decode accepts and %s reads exactly that, or decode rejects",
    (alt, src, _name, reader) => {
      const text = unresolvedArtifactImageText(alt, src);
      const decoded = decodeUnresolvedArtifactImageText(text);
      if (decoded === null) return;
      expect(decoded).toEqual({ alt, src });
      expect(onlyImageOf(reader.stored(text))).toEqual({ alt, src });
    },
  );
});

// ---------------------------------------------------------------------------
// 9. Fences, link destinations and code spans through both readers
// ---------------------------------------------------------------------------

describe("fences, link destinations and code spans: written, ingested, written again", () => {
  type BlockView =
    | { kind: "code"; language: string | null; text: string }
    | { kind: "mermaid"; code: string }
    | { kind: "wireframe"; html: string };

  // The host converter turns a mermaid or wireframe fence into its own block
  // after the parse, and the gui parser does it in the parse, so both are
  // compared as the same view.
  function blocksOf(node: JsonContent): BlockView[] {
    const own: BlockView[] = [];
    const text = textsOf(node).join("");
    if (node.type === "codeBlock") {
      const language = node.attrs?.language;
      if (language === "mermaid") own.push({ kind: "mermaid", code: text });
      else if (language === "wireframe") {
        own.push({ kind: "wireframe", html: text });
      } else {
        own.push({
          kind: "code",
          language:
            typeof language === "string" && language !== "" ? language : null,
          text,
        });
      }
    } else if (node.type === "mermaidBlock") {
      const code = node.attrs?.code;
      own.push({ kind: "mermaid", code: typeof code === "string" ? code : "" });
    } else if (node.type === "uiPreviewBlock") {
      const html = node.attrs?.htmlContent;
      own.push({
        kind: "wireframe",
        html: typeof html === "string" ? html : "",
      });
    }
    return own.concat((node.content ?? []).flatMap(blocksOf));
  }

  interface Run {
    readonly text: string;
    readonly marks: string;
  }

  // The text of the document as runs of one set of marks, so the code-marked
  // text and the unmarked text beside it are compared exactly.
  function runsOf(node: JsonContent): Run[] {
    const runs: Run[] = [];
    const visit = (current: JsonContent): void => {
      if (current.type === "text") {
        const marks = (current.marks ?? [])
          .map((mark) =>
            mark.type === "link"
              ? `link:${String(mark.attrs?.href)}`
              : mark.type,
          )
          .sort()
          .join(",");
        const last = runs.at(-1);
        if (last !== undefined && last.marks === marks) {
          runs[runs.length - 1] = {
            text: last.text + (current.text ?? ""),
            marks,
          };
        } else {
          runs.push({ text: current.text ?? "", marks });
        }
      }
      for (const child of current.content ?? []) visit(child);
    };
    visit(node);
    return runs;
  }

  const code = (value: string, language: string | null): JsonContent => ({
    type: "codeBlock",
    attrs: { language },
    content: [{ type: "text", text: value }],
  });
  const mermaid = (value: string): JsonContent => ({
    type: "mermaidBlock",
    attrs: { code: value },
  });
  const wireframe = (value: string): JsonContent => ({
    type: "uiPreviewBlock",
    attrs: { htmlContent: value, title: "UI Preview", isCompleteHtml: true },
  });

  const fenceRows: readonly (readonly [string, JsonContent])[] = [
    [
      "a code block with a line of three backticks",
      doc(code("a\n```\nb", null)),
    ],
    [
      "a code block with a line of four backticks",
      doc(code("a\n````\nb", null)),
    ],
    ["a code block with a line of tildes", doc(code("a\n~~~\nb", null))],
    ["a code block with a backtick inside a line", doc(code("a`b", null))],
    [
      "a mermaid block with a line of three backticks",
      doc(mermaid("graph\n```\nx")),
    ],
    [
      "a wireframe block with a line of three backticks",
      doc(wireframe("<p>\n```\n</p>")),
    ],
    ["a code block whose language holds a backtick", doc(code("x", "a`b"))],
    [
      "that language with a line of tildes in the content",
      doc(code("x\n~~~\ny", "a`b")),
    ],
    [
      "a longer fence inside a bullet item",
      doc(ul(li(P("t"), code("a\n```\nb", null)))),
    ],
    ["a longer fence inside a quote", doc(bq(code("a\n```\nb", null)))],
  ];

  it.each(
    fenceRows.flatMap(([name, content]) =>
      READERS.map((reader) => [name, reader.name, content, reader] as const),
    ),
  )("%s through %s", (_name, _readerName, content, reader) => {
    const expected = blocksOf(content);
    const md1 = serialize(content);
    const stored1 = reader.stored(md1);
    expect(blocksOf(stored1)).toEqual(expected);
    const md2 = serialize(stored1);
    expect(md2).toBe(md1);
    expect(blocksOf(reader.stored(md2))).toEqual(expected);
  });

  const link = (label: string, href: string): JsonContent => ({
    type: "text",
    text: label,
    marks: [{ type: "link", attrs: { href } }],
  });
  const around = (middle: JsonContent): JsonContent =>
    doc({
      type: "paragraph",
      content: [
        { type: "text", text: "x " },
        middle,
        { type: "text", text: " y" },
      ],
    });
  const inCell = (middle: JsonContent): JsonContent =>
    doc(table({ type: "paragraph", content: [middle] }));

  const hrefs: readonly string[] = [
    "https://example.test/a)b",
    "https://example.test/a b",
    "https://example.test/a(b",
    `https://example.test/a${BS}*b`,
    "https://example.test/a<b",
    "https://example.test/a>b",
    "https://example.test/p",
  ];
  const cellHrefs: readonly string[] = [
    ...hrefs,
    "https://example.test/a|b",
    `https://example.test/a${BS}|b`,
  ];
  const linkRows: readonly (readonly [string, JsonContent])[] = [
    ...hrefs.map(
      (href) => [`a link to ${href}`, around(link("t", href))] as const,
    ),
    ...cellHrefs.map(
      (href) =>
        [`a link to ${href} in a table cell`, inCell(link("t", href))] as const,
    ),
  ];

  it.each(
    linkRows.flatMap(([name, content]) =>
      READERS.map((reader) => [name, reader.name, content, reader] as const),
    ),
  )("%s through %s", (_name, _readerName, content, reader) => {
    const expected = runsOf(content);
    const md1 = serialize(content);
    const stored1 = reader.stored(md1);
    expect(runsOf(stored1)).toEqual(expected);
    const md2 = serialize(stored1);
    expect(md2).toBe(md1);
    expect(runsOf(reader.stored(md2))).toEqual(expected);
  });

  const codeText = (value: string, extra: readonly string[]): JsonContent => ({
    type: "text",
    text: value,
    marks: [{ type: "code" }, ...extra.map((type) => ({ type }))],
  });
  const codeValues: readonly string[] = [
    "a`b",
    "``",
    "`a",
    "a`",
    " a ",
    "  ",
    " ",
    "a``b`c",
  ];
  const codeRows: readonly (readonly [string, JsonContent])[] = [
    ...codeValues.map(
      (value) =>
        [
          `code holding ${JSON.stringify(value)}`,
          around(codeText(value, [])),
        ] as const,
    ),
    ["code and bold", around(codeText("a`b", ["bold"]))],
    [
      "code holding a pipe and a backtick in a table cell",
      inCell(codeText("a|b`c", [])),
    ],
  ];

  it.each(
    codeRows.flatMap(([name, content]) =>
      READERS.map((reader) => [name, reader.name, content, reader] as const),
    ),
  )("%s through %s", (_name, _readerName, content, reader) => {
    const expected = runsOf(content);
    const md1 = serialize(content);
    const stored1 = reader.stored(md1);
    expect({ md1, runs: runsOf(stored1) }).toEqual({ md1, runs: expected });
    const md2 = serialize(stored1);
    expect(md2).toBe(md1);
    expect(runsOf(reader.stored(md2))).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// 10. A line holding only <br>
// ---------------------------------------------------------------------------

function nodesOfType(node: JsonContent, type: string): JsonContent[] {
  const found = node.type === type ? [node] : [];
  return [
    ...found,
    ...(node.content ?? []).flatMap((child) => nodesOfType(child, type)),
  ];
}

function paragraphTexts(node: JsonContent): string[] {
  return nodesOfType(node, "paragraph").map((paragraph) =>
    (paragraph.content ?? [])
      .map((child) => (child.type === "text" ? (child.text ?? "") : "\u0000"))
      .join(""),
  );
}

describe("a block holding only <br> is a paragraph of that text, as the host stores it", () => {
  const rows: ReadonlyArray<readonly [string, string, string, string, string]> =
    [
      [
        "between paragraphs",
        "before\n\n<br>\n\nafter",
        "before\n\n" + BS + "<br>\n\nafter",
        "<br>",
        "paragraph",
      ],
      ["alone", "<br>", BS + "<br>", "<br>", "paragraph"],
      ["self-closing", "<br/>", BS + "<br/>", "<br/>", "paragraph"],
      [
        "self-closing with a space",
        "<br />",
        BS + "<br />",
        "<br />",
        "paragraph",
      ],
      [
        "under a bullet item",
        "- a\n  <br>",
        "- a\n\n  " + BS + "<br>",
        "<br>",
        "listItem",
      ],
      ["in a quote", "> <br>", "> " + BS + "<br>", "<br>", "blockquote"],
      [
        "between paragraphs of an ordered item",
        "1. a\n\n   <br>\n\n   c",
        "1. a\n\n   " + BS + "<br>\n\n   c",
        "<br>",
        "listItem",
      ],
    ];

  it.each(
    rows.map(([name, input, expectedMd1, breakText, container]) => ({
      name,
      input,
      expectedMd1,
      breakText,
      container,
    })),
  )("$name", ({ input, expectedMd1, breakText, container }) => {
    const stored0 = guiReader.stored(input);
    expect(paragraphTexts(stored0)).toContain(breakText);
    expect(nodesOfType(stored0, "hardBreak")).toEqual([]);
    expect(nodesOfType(stored0, container).length).toBeGreaterThan(0);

    const md1 = serialize(stored0);
    expect(md1).toBe(expectedMd1);

    const stored1 = guiReader.stored(md1);
    expect(paragraphTexts(stored1)).toContain(breakText);
    expect(nodesOfType(stored1, "hardBreak")).toEqual([]);
    expect(nodesOfType(stored1, container).length).toBeGreaterThan(0);

    const md2 = serialize(stored1);
    expect(md2).toBe(md1);
  });

  it("an inline <br> in a paragraph stays a hard break and writes a backslash newline", () => {
    const stored0 = guiReader.stored("a<br>b");
    expect(stored0).toEqual(
      doc({
        type: "paragraph",
        content: [
          { type: "text", text: "a" },
          { type: "hardBreak" },
          { type: "text", text: "b" },
        ],
      }),
    );
    const md1 = serialize(stored0);
    expect(md1).toBe("a" + BS + "\nb");
    expect(serialize(guiReader.stored(md1))).toBe(md1);
  });

  it("a <br> in a table cell keeps its hard break", () => {
    const stored0 = guiReader.stored("| a<br>b |\n| --- |\n| c |");
    const header = nodesOfType(stored0, "tableHeader");
    expect(header).toHaveLength(1);
    expect(nodesOfType(header[0], "hardBreak")).toHaveLength(1);
    const md1 = serialize(stored0);
    expect(md1).toBe("| a<br>b |\n| --- |\n| c |");
    expect(serialize(guiReader.stored(md1))).toBe(md1);
  });

  it("a <br> in a heading keeps its hard break", () => {
    const stored0 = guiReader.stored("# a<br>b");
    expect(stored0).toEqual(
      doc({
        type: "heading",
        attrs: { level: 1 },
        content: [
          { type: "text", text: "a" },
          { type: "hardBreak" },
          { type: "text", text: "b" },
        ],
      }),
    );
    const md1 = serialize(stored0);
    expect(md1).toBe("# a<br>b");
    expect(serialize(guiReader.stored(md1))).toBe(md1);
  });

  it("any other html block takes the default path", () => {
    expect(guiReader.stored("<div>x</div>")).toEqual(doc(P("x")));
  });
});

// ---------------------------------------------------------------------------
// 11. An ATX heading that ends in a run of hashes
// ---------------------------------------------------------------------------

describe("a level-2 heading ending in # keeps its text through two writes and two ingests", () => {
  const heading2 = (value: string): JsonContent => ({
    type: "heading",
    attrs: { level: 2 },
    content: [{ type: "text", text: value }],
  });

  const headingsOf = (
    stored: JsonContent,
  ): Array<{ level: unknown; texts: string[] }> =>
    nodesOfType(stored, "heading").map((node) => ({
      level: node.attrs?.level,
      texts: textsOf(node),
    }));

  // [name, text, the markdown written, the text a reader stores back]. The
  // last row's trailing spaces end the heading line, which no heading keeps.
  const rows: ReadonlyArray<readonly [string, string, string, string]> = [
    ["a hash after a space", "Title #", "## Title " + BS + "#", "Title #"],
    [
      "two hashes after a space",
      "Title ##",
      "## Title " + BS + "##",
      "Title ##",
    ],
    ["a lone hash", "#", "## " + BS + "#", "#"],
    ["two lone hashes", "##", "## " + BS + "##", "##"],
    ["a hash inside a word", "a#", "## a#", "a#"],
    ["a hash with text after it", "Title # x", "## Title # x", "Title # x"],
    [
      "a typed backslash before the hash",
      "Title " + BS + "#",
      "## Title " + BS + BS + "#",
      "Title " + BS + "#",
    ],
    ["a hash after a tab", "Title\t#", "## Title\t" + BS + "#", "Title\t#"],
    [
      "a hash after a space, then spaces",
      "Title #  ",
      "## Title " + BS + "#",
      "Title #",
    ],
  ];

  it.each(
    rows.flatMap(([name, value, expectedMd, expectedText]) =>
      READERS.map((reader) => ({
        name,
        readerName: reader.name,
        value,
        expectedMd,
        expectedText,
        reader,
      })),
    ),
  )(
    "$name through $readerName",
    ({ value, expectedMd, expectedText, reader }) => {
      const expectedHeadings = [{ level: 2, texts: [expectedText] }];
      const md1 = serialize(doc(heading2(value)));
      expect(md1).toBe(expectedMd);

      const stored1 = reader.stored(md1);
      expect(headingsOf(stored1)).toEqual(expectedHeadings);

      const md2 = serialize(stored1);
      expect(md2).toBe(md1);
      const stored2 = reader.stored(md2);
      expect(headingsOf(stored2)).toEqual(expectedHeadings);
      expect(serialize(stored2)).toBe(md2);
    },
  );
});
