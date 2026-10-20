import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  artboardEditSchema,
  epicEditArtboardRequestSchema,
  epicEditArtboardV10,
} from "@traycer/protocol/host/epic/artboard-edit";

// The step-two edits (move, box size, align, distribute, wrap, unwrap) join the
// unreleased epic.editArtboard@1.0 union. The schema checks shape and the
// collection bounds; which elements may be moved or wrapped together is the
// host's call, so nothing here asserts that.

const SHA = "c".repeat(64);

const BASE_REQUEST = {
  epicId: "epic-1",
  artifactId: "canvas-1",
  boardPath: "boards/home.html",
  servedSha256: SHA,
  locator: { kind: "tid", tid: "t-1" },
  fallbackTid: null,
} as const;

const TID = (tid: string) => ({ kind: "tid", tid }) as const;
const POSITION = (startTagOffset: number, tagName: string) =>
  ({ kind: "position", startTagOffset, tagName }) as const;

function placement(tid: string, declarations: readonly unknown[]) {
  return { locator: TID(tid), declarations };
}

const LEFT = { property: "left", value: "10px" } as const;

const NEW_EDITS = [
  { kind: "move-element", before: null },
  { kind: "move-element", before: TID("sibling") },
  { kind: "move-element", before: POSITION(42, "li") },
  { kind: "set-box", width: 120, height: 40 },
  { kind: "set-box", width: 0, height: 0 },
  { kind: "set-box", width: 12.5, height: null },
  { kind: "set-box", width: null, height: null },
  {
    kind: "align-elements",
    elements: [
      { locator: TID("a"), declarations: [LEFT] },
      {
        locator: POSITION(10, "div"),
        declarations: [{ property: "margin-left", value: null }],
      },
    ],
    mode: "left",
  },
  {
    kind: "distribute-elements",
    elements: [
      {
        locator: TID("a"),
        declarations: [LEFT, { property: "top", value: "0" }],
      },
    ],
    axis: "x",
  },
  {
    kind: "wrap-elements",
    locators: [TID("a"), POSITION(5, "p")],
    tag: "div",
    className: null,
  },
  {
    kind: "wrap-elements",
    locators: [TID("a")],
    tag: "section",
    className: "group wide",
  },
  { kind: "unwrap-element" },
] as const;

describe("epic.editArtboard@1.0 step-two edits", () => {
  it("stays the one 1.0 contract, with no new minor", () => {
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

  it("keeps the earlier arms in the union", () => {
    for (const edit of [
      { kind: "set-style", property: "color", value: "red" },
      { kind: "set-text-node", index: 0, text: "x", expectedText: "y" },
      { kind: "delete-element" },
      { kind: "duplicate-element" },
      {
        kind: "wrap-text-range",
        start: 0,
        end: 1,
        tag: "b",
        href: null,
        expectedText: "x",
      },
      { kind: "set-css-variable", name: "--x", value: null },
      { kind: "insert-html-after", html: "<p>x</p>" },
    ] as const) {
      expect(artboardEditSchema.parse(edit)).toEqual(edit);
    }
  });

  describe("move-element", () => {
    it.each([
      ["a missing before", { kind: "move-element" }],
      ["an undefined before", { kind: "move-element", before: undefined }],
      ["a string before", { kind: "move-element", before: "t-1" }],
      ["a before with an empty tid", { kind: "move-element", before: TID("") }],
      [
        "a before with an unknown locator kind",
        { kind: "move-element", before: { kind: "selector", selector: "p" } },
      ],
      [
        "a position before with a negative offset",
        { kind: "move-element", before: POSITION(-1, "p") },
      ],
      [
        "a position before with a fractional offset",
        { kind: "move-element", before: POSITION(1.5, "p") },
      ],
      [
        "a position before with an empty tag",
        { kind: "move-element", before: POSITION(1, "") },
      ],
    ])("rejects %s", (_label, edit) => {
      expect(artboardEditSchema.safeParse(edit).success).toBe(false);
    });
  });

  describe("set-box", () => {
    it.each([
      ["a negative width", { kind: "set-box", width: -1, height: 1 }],
      ["a negative height", { kind: "set-box", width: 1, height: -0.5 }],
      ["an infinite width", { kind: "set-box", width: Infinity, height: 1 }],
      ["a NaN height", { kind: "set-box", width: 1, height: NaN }],
      ["a string width", { kind: "set-box", width: "10", height: 1 }],
      ["a missing width", { kind: "set-box", height: 1 }],
      ["a missing height", { kind: "set-box", width: 1 }],
      ["an undefined height", { kind: "set-box", width: 1, height: undefined }],
    ])("rejects %s", (_label, edit) => {
      expect(artboardEditSchema.safeParse(edit).success).toBe(false);
    });
  });

  describe("align-elements and distribute-elements", () => {
    const entry = placement("a", [LEFT]);

    it.each(["left", "center", "right", "top", "middle", "bottom"] as const)(
      "accepts the align mode %s",
      (mode) => {
        const edit = { kind: "align-elements", elements: [entry], mode };
        expect(artboardEditSchema.parse(edit)).toEqual(edit);
      },
    );

    it.each(["x", "y"] as const)("accepts the distribute axis %s", (axis) => {
      const edit = { kind: "distribute-elements", elements: [entry], axis };
      expect(artboardEditSchema.parse(edit)).toEqual(edit);
    });

    it.each(["Left", "start", "justify", ""])(
      "rejects the align mode %j",
      (mode) => {
        expect(
          artboardEditSchema.safeParse({
            kind: "align-elements",
            elements: [entry],
            mode,
          }).success,
        ).toBe(false);
      },
    );

    it.each(["z", "X", "horizontal", ""])(
      "rejects the distribute axis %j",
      (axis) => {
        expect(
          artboardEditSchema.safeParse({
            kind: "distribute-elements",
            elements: [entry],
            axis,
          }).success,
        ).toBe(false);
      },
    );

    for (const kind of ["align-elements", "distribute-elements"] as const) {
      const make = (elements: unknown) =>
        kind === "align-elements"
          ? { kind, elements, mode: "left" }
          : { kind, elements, axis: "x" };

      it(`${kind} accepts 1 and 256 elements`, () => {
        expect(artboardEditSchema.safeParse(make([entry])).success).toBe(true);
        const many = Array.from({ length: 256 }, (_, index) =>
          placement(`e${index}`, [LEFT]),
        );
        expect(artboardEditSchema.safeParse(make(many)).success).toBe(true);
      });

      it(`${kind} rejects no elements and 257 elements`, () => {
        expect(artboardEditSchema.safeParse(make([])).success).toBe(false);
        const tooMany = Array.from({ length: 257 }, (_, index) =>
          placement(`e${index}`, [LEFT]),
        );
        expect(artboardEditSchema.safeParse(make(tooMany)).success).toBe(false);
      });

      it(`${kind} rejects missing and non-array elements`, () => {
        expect(artboardEditSchema.safeParse(make(undefined)).success).toBe(
          false,
        );
        expect(artboardEditSchema.safeParse(make(entry)).success).toBe(false);
      });

      it(`${kind} rejects an element without a locator or with a bad one`, () => {
        expect(
          artboardEditSchema.safeParse(make([{ declarations: [LEFT] }]))
            .success,
        ).toBe(false);
        expect(
          artboardEditSchema.safeParse(
            make([{ locator: TID(""), declarations: [LEFT] }]),
          ).success,
        ).toBe(false);
      });
    }

    describe("declarations", () => {
      const make = (declarations: unknown) => ({
        kind: "align-elements",
        elements: [{ locator: TID("a"), declarations }],
        mode: "left",
      });

      it.each([
        "left",
        "top",
        "margin",
        "margin-left",
        "margin-right",
        "margin-top",
        "margin-bottom",
      ] as const)(
        "accepts the property %s with a value or null",
        (property) => {
          expect(
            artboardEditSchema.safeParse(make([{ property, value: "1px" }]))
              .success,
          ).toBe(true);
          expect(
            artboardEditSchema.safeParse(make([{ property, value: null }]))
              .success,
          ).toBe(true);
        },
      );

      it.each([
        "color",
        "padding",
        "width",
        "right",
        "bottom",
        "Left",
        "margin-inline",
        "",
      ])("rejects the property %j", (property) => {
        expect(
          artboardEditSchema.safeParse(make([{ property, value: "1px" }]))
            .success,
        ).toBe(false);
      });

      it("accepts 1 to 7 declarations and rejects none or 8", () => {
        const seven = [
          "left",
          "top",
          "margin",
          "margin-left",
          "margin-right",
          "margin-top",
          "margin-bottom",
        ].map((property) => ({ property, value: "0" }));
        expect(artboardEditSchema.safeParse(make(seven)).success).toBe(true);
        expect(artboardEditSchema.safeParse(make([])).success).toBe(false);
        expect(
          artboardEditSchema.safeParse(make([...seven, LEFT])).success,
        ).toBe(false);
      });

      it("rejects a declaration without a value or with a non-string one", () => {
        expect(
          artboardEditSchema.safeParse(make([{ property: "left" }])).success,
        ).toBe(false);
        expect(
          artboardEditSchema.safeParse(
            make([{ property: "left", value: undefined }]),
          ).success,
        ).toBe(false);
        expect(
          artboardEditSchema.safeParse(make([{ property: "left", value: 5 }]))
            .success,
        ).toBe(false);
      });

      it("rejects missing declarations", () => {
        expect(
          artboardEditSchema.safeParse({
            kind: "align-elements",
            elements: [{ locator: TID("a") }],
            mode: "left",
          }).success,
        ).toBe(false);
      });
    });
  });

  describe("wrap-elements", () => {
    const make = (overrides: Record<string, unknown>) => ({
      kind: "wrap-elements",
      locators: [TID("a")],
      tag: "div",
      className: null,
      ...overrides,
    });

    it.each(["div", "section"] as const)("accepts the tag %s", (tag) => {
      expect(artboardEditSchema.safeParse(make({ tag })).success).toBe(true);
    });

    it.each(["span", "DIV", "article", "p", ""])(
      "rejects the tag %j",
      (tag) => {
        expect(artboardEditSchema.safeParse(make({ tag })).success).toBe(false);
      },
    );

    it("accepts 1 and 256 locators and rejects none or 257", () => {
      const many = (count: number) =>
        Array.from({ length: count }, (_, index) => TID(`e${index}`));
      expect(
        artboardEditSchema.safeParse(make({ locators: many(1) })).success,
      ).toBe(true);
      expect(
        artboardEditSchema.safeParse(make({ locators: many(256) })).success,
      ).toBe(true);
      expect(artboardEditSchema.safeParse(make({ locators: [] })).success).toBe(
        false,
      );
      expect(
        artboardEditSchema.safeParse(make({ locators: many(257) })).success,
      ).toBe(false);
    });

    it("accepts a class name up to 4096 characters, or null, and rejects more or undefined", () => {
      expect(
        artboardEditSchema.safeParse(make({ className: "a".repeat(4096) }))
          .success,
      ).toBe(true);
      expect(
        artboardEditSchema.safeParse(make({ className: "" })).success,
      ).toBe(true);
      expect(
        artboardEditSchema.safeParse(make({ className: "a".repeat(4097) }))
          .success,
      ).toBe(false);
      expect(
        artboardEditSchema.safeParse(make({ className: undefined })).success,
      ).toBe(false);
      expect(artboardEditSchema.safeParse(make({ className: 5 })).success).toBe(
        false,
      );
    });

    it("rejects missing or malformed locators", () => {
      expect(
        artboardEditSchema.safeParse(make({ locators: undefined })).success,
      ).toBe(false);
      expect(
        artboardEditSchema.safeParse(make({ locators: TID("a") })).success,
      ).toBe(false);
      expect(
        artboardEditSchema.safeParse(make({ locators: [TID("")] })).success,
      ).toBe(false);
      expect(
        artboardEditSchema.safeParse(make({ locators: [POSITION(-1, "p")] }))
          .success,
      ).toBe(false);
    });
  });

  it("gives unwrap-element no fields: extras are dropped, never kept", () => {
    expect(
      artboardEditSchema.parse({ kind: "unwrap-element", tid: "x" }),
    ).toEqual({
      kind: "unwrap-element",
    });
  });

  it("rejects an unknown step-two kind", () => {
    expect(
      artboardEditSchema.safeParse({ kind: "reorder-elements" }).success,
    ).toBe(false);
  });
});
