import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  artboardEditSchema,
  epicEditArtboardRequestSchema,
  epicEditArtboardResponseSchema,
  epicEditArtboardV10,
} from "@traycer/protocol/host/epic/artboard-edit";

// The step-one edits join the unreleased epic.editArtboard@1.0 union. The
// schema checks shape only (integers, enums, required fields); the host owns
// the semantic bounds (end > start, sizes, names, media types), so nothing here
// asserts a schema-level rejection for them.

const SHA = "b".repeat(64);

const BASE_REQUEST = {
  epicId: "epic-1",
  artifactId: "canvas-1",
  boardPath: "boards/home.html",
  servedSha256: SHA,
  locator: { kind: "tid", tid: "t-1" },
  fallbackTid: null,
} as const;

const NEW_EDITS = [
  {
    kind: "wrap-text-range",
    start: 0,
    end: 5,
    tag: "b",
    href: null,
    expectedText: "Hello",
  },
  {
    kind: "wrap-text-range",
    start: 2,
    end: 9,
    tag: "i",
    href: null,
    expectedText: "llo wor",
  },
  {
    kind: "wrap-text-range",
    start: 2,
    end: 9,
    tag: "u",
    href: null,
    expectedText: "a &amp; b",
  },
  {
    kind: "wrap-text-range",
    start: 3,
    end: 7,
    tag: "a",
    href: "https://example.com/a?b=c",
    expectedText: "d.co",
  },
  {
    kind: "unwrap-text-range",
    start: 0,
    end: 5,
    tag: "b",
    expectedText: "Hello",
  },
  { kind: "unwrap-text-range", start: 1, end: 2, tag: "a", expectedText: "e" },
  { kind: "set-css-variable", name: "--brand", value: "#fff" },
  { kind: "set-css-variable", name: "--brand", value: null },
  { kind: "insert-html-after", html: "<p>new</p>" },
  { kind: "insert-html-after", html: "" },
  {
    kind: "write-asset",
    fileName: "hero.png",
    bytesBase64: "iVBORw0KGgo=",
    mediaType: "image/png",
    replace: false,
  },
  {
    kind: "write-asset",
    fileName: "hero.png",
    bytesBase64: "",
    mediaType: "image/webp",
    replace: true,
  },
] as const;

describe("epic.editArtboard@1.0 step-one edits", () => {
  it("stays the one and only 1.0 contract, with no new minor", () => {
    const entry = hostRpcRegistry["epic.editArtboard"];
    expect(entry[1].latestMinor).toBe(0);
    expect(Object.keys(entry[1].versions)).toEqual(["0"]);
    expect(entry[1].versions[0].contract).toBe(epicEditArtboardV10);
    expect(entry.degrade).toEqual({ kind: "unsupported" });
  });

  for (const edit of NEW_EDITS) {
    it(`round-trips ${JSON.stringify(edit)}`, () => {
      expect(artboardEditSchema.parse(edit)).toEqual(edit);
      expect(
        epicEditArtboardRequestSchema.parse({ ...BASE_REQUEST, edit }),
      ).toEqual({ ...BASE_REQUEST, edit });
    });
  }

  it("keeps every earlier edit kind in the union", () => {
    for (const edit of [
      { kind: "set-style", property: "color", value: "red" },
      { kind: "set-attribute", name: "alt", value: null },
      { kind: "set-text-content", text: "x" },
      { kind: "set-text-node", index: 0, text: "x", expectedText: "y" },
      { kind: "insert-tid-only" },
      { kind: "delete-element" },
      { kind: "duplicate-element" },
    ] as const) {
      expect(artboardEditSchema.parse(edit)).toEqual(edit);
    }
  });

  const REJECTED: readonly (readonly [string, unknown])[] = [
    [
      "a wrap with an unknown tag",
      {
        kind: "wrap-text-range",
        start: 0,
        end: 1,
        tag: "span",
        href: null,
        expectedText: "x",
      },
    ],
    [
      "a wrap with an upper-case tag",
      {
        kind: "wrap-text-range",
        start: 0,
        end: 1,
        tag: "B",
        href: null,
        expectedText: "x",
      },
    ],
    [
      "a wrap without an href",
      {
        kind: "wrap-text-range",
        start: 0,
        end: 1,
        tag: "b",
        expectedText: "x",
      },
    ],
    [
      "a wrap with an undefined href",
      {
        kind: "wrap-text-range",
        start: 0,
        end: 1,
        tag: "b",
        href: undefined,
        expectedText: "x",
      },
    ],
    [
      "a wrap with a non-string href",
      {
        kind: "wrap-text-range",
        start: 0,
        end: 1,
        tag: "a",
        href: 5,
        expectedText: "x",
      },
    ],
    [
      "a wrap with a negative start",
      {
        kind: "wrap-text-range",
        start: -1,
        end: 1,
        tag: "b",
        href: null,
        expectedText: "x",
      },
    ],
    [
      "a wrap with a fractional end",
      {
        kind: "wrap-text-range",
        start: 0,
        end: 1.5,
        tag: "b",
        href: null,
        expectedText: "x",
      },
    ],
    [
      "a wrap missing its end",
      {
        kind: "wrap-text-range",
        start: 0,
        tag: "b",
        href: null,
        expectedText: "x",
      },
    ],
    [
      "an unwrap with an unknown tag",
      {
        kind: "unwrap-text-range",
        start: 0,
        end: 1,
        tag: "em",
        expectedText: "x",
      },
    ],
    [
      "an unwrap with a negative offset",
      {
        kind: "unwrap-text-range",
        start: 0,
        end: -2,
        tag: "b",
        expectedText: "x",
      },
    ],
    [
      "an unwrap missing its tag",
      { kind: "unwrap-text-range", start: 0, end: 1, expectedText: "x" },
    ],
    [
      "a css variable with an empty name",
      { kind: "set-css-variable", name: "", value: "x" },
    ],
    [
      "a css variable without a value",
      { kind: "set-css-variable", name: "--x" },
    ],
    [
      "a css variable with a non-string value",
      { kind: "set-css-variable", name: "--x", value: 3 },
    ],
    ["an insert without html", { kind: "insert-html-after" }],
    ["an insert with non-string html", { kind: "insert-html-after", html: 4 }],
    [
      "an asset without replace",
      {
        kind: "write-asset",
        fileName: "a.png",
        bytesBase64: "AA==",
        mediaType: "image/png",
      },
    ],
    [
      "an asset with a non-boolean replace",
      {
        kind: "write-asset",
        fileName: "a.png",
        bytesBase64: "AA==",
        mediaType: "image/png",
        replace: "yes",
      },
    ],
    [
      "an asset with an empty file name",
      {
        kind: "write-asset",
        fileName: "",
        bytesBase64: "AA==",
        mediaType: "image/png",
        replace: false,
      },
    ],
    [
      "an asset with an empty media type",
      {
        kind: "write-asset",
        fileName: "a.png",
        bytesBase64: "AA==",
        mediaType: "",
        replace: false,
      },
    ],
    [
      "an asset without bytes",
      {
        kind: "write-asset",
        fileName: "a.png",
        mediaType: "image/png",
        replace: false,
      },
    ],
    [
      "a wrap without expectedText",
      { kind: "wrap-text-range", start: 0, end: 1, tag: "b", href: null },
    ],
    [
      "a wrap with undefined expectedText",
      {
        kind: "wrap-text-range",
        start: 0,
        end: 1,
        tag: "b",
        href: null,
        expectedText: undefined,
      },
    ],
    [
      "a wrap with a numeric expectedText",
      {
        kind: "wrap-text-range",
        start: 0,
        end: 1,
        tag: "b",
        href: null,
        expectedText: 5,
      },
    ],
    [
      "a wrap with a null expectedText",
      {
        kind: "wrap-text-range",
        start: 0,
        end: 1,
        tag: "b",
        href: null,
        expectedText: null,
      },
    ],
    [
      "an unwrap without expectedText",
      { kind: "unwrap-text-range", start: 0, end: 1, tag: "b" },
    ],
    [
      "an unwrap with undefined expectedText",
      {
        kind: "unwrap-text-range",
        start: 0,
        end: 1,
        tag: "b",
        expectedText: undefined,
      },
    ],
    [
      "an unwrap with an object expectedText",
      {
        kind: "unwrap-text-range",
        start: 0,
        end: 1,
        tag: "b",
        expectedText: { text: "x" },
      },
    ],
    [
      "a text-node edit without expectedText",
      { kind: "set-text-node", index: 0, text: "x" },
    ],
    [
      "a text-node edit with undefined expectedText",
      { kind: "set-text-node", index: 0, text: "x", expectedText: undefined },
    ],
    [
      "a text-node edit with a non-string expectedText",
      { kind: "set-text-node", index: 0, text: "x", expectedText: ["y"] },
    ],
  ];

  for (const [label, edit] of REJECTED) {
    it(`rejects ${label}`, () => {
      expect(artboardEditSchema.safeParse(edit).success).toBe(false);
    });
  }
});

describe("epicEditArtboardResponseSchema writtenPath", () => {
  const SUCCESS = { ok: true, tid: "t-1", sha256After: SHA, splices: [] };

  it("round-trips a write-asset success with the written path", () => {
    const response = {
      ...SUCCESS,
      writtenPath: "assets/hero.png",
      splices: [
        { start: 10, end: 20, replacement: 'src="../assets/hero.png"' },
      ],
    };
    expect(epicEditArtboardResponseSchema.parse(response)).toEqual(response);
  });

  it("leaves writtenPath absent for every other success", () => {
    const parsed = epicEditArtboardResponseSchema.parse(SUCCESS);
    expect(parsed).toEqual(SUCCESS);
    expect("writtenPath" in parsed).toBe(false);
  });

  it.each([
    "../escape.png",
    "/abs/hero.png",
    "assets\\hero.png",
    ".hidden/x.png",
    "",
  ])("rejects the written path %j", (writtenPath) => {
    expect(
      epicEditArtboardResponseSchema.safeParse({ ...SUCCESS, writtenPath })
        .success,
    ).toBe(false);
  });

  it("round-trips a refusal, which has no written path", () => {
    const refusal = { ok: false, reason: "asset-exists", detail: "Taken." };
    expect(epicEditArtboardResponseSchema.parse(refusal)).toEqual(refusal);
  });
});
