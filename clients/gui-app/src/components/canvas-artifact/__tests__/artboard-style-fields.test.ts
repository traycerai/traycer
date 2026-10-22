import { describe, expect, it } from "vitest";
import { artboardEditSchema } from "@traycer/protocol/host/epic/artboard-edit";
import {
  ARTBOARD_STYLE_FIELDS,
  styleFieldEdit,
} from "../artboard-style-fields";
import { validateArtboardCss } from "../artboard-css-validation";

describe("ARTBOARD_STYLE_FIELDS", () => {
  it("offers the fourteen properties the properties panel edits, in panel order", () => {
    expect(ARTBOARD_STYLE_FIELDS.map((field) => field.property)).toEqual([
      "width",
      "height",
      "padding",
      "margin",
      "font-family",
      "font-size",
      "font-weight",
      "color",
      "text-align",
      "background-color",
      "border-width",
      "border-style",
      "border-color",
      "border-radius",
    ]);
  });

  it("leaves no label blank", () => {
    for (const field of ARTBOARD_STYLE_FIELDS) {
      expect(field.label.trim()).not.toBe("");
    }
  });

  it("names each property the way the code editor would write it", () => {
    for (const field of ARTBOARD_STYLE_FIELDS) {
      const parsed = validateArtboardCss(`${field.property}: x`, () => true);
      expect(parsed).toEqual({
        ok: true,
        declarations: [{ property: field.property, value: "x" }],
      });
    }
  });
});

describe("styleFieldEdit", () => {
  it("sets the property to the entered value", () => {
    expect(styleFieldEdit("color", "red")).toEqual({
      kind: "set-style",
      property: "color",
      value: "red",
    });
  });

  it("trims the value but keeps what is inside it", () => {
    expect(styleFieldEdit("padding", "  1px   2px \n")).toEqual({
      kind: "set-style",
      property: "padding",
      value: "1px   2px",
    });
  });

  it.each(["", " ", "\t\n  "])(
    "removes the declaration for the blank value %j",
    (blank) => {
      expect(styleFieldEdit("margin", blank)).toEqual({
        kind: "set-style",
        property: "margin",
        value: null,
      });
    },
  );

  it("keeps an !important the person typed, for the host to preserve", () => {
    expect(styleFieldEdit("color", "red !important")).toMatchObject({
      value: "red !important",
    });
  });

  it.each([
    ["Regular 400", "400"],
    ["Bold 700", "700"],
    ["  Bold 700 ", "700"],
  ])(
    "turns the font weight name %j back into the number %s",
    (shown, value) => {
      expect(styleFieldEdit("font-weight", shown)).toEqual({
        kind: "set-style",
        property: "font-weight",
        value,
      });
    },
  );

  it.each(["600", "bold", "bolder", "var(--weight)", "700 !important"])(
    "keeps the font weight %j as the person wrote it",
    (value) => {
      expect(styleFieldEdit("font-weight", value)).toMatchObject({ value });
    },
  );

  it("only reads a weight name on the font-weight property", () => {
    expect(styleFieldEdit("font-family", "Bold 700")).toMatchObject({
      value: "Bold 700",
    });
  });

  it("always produces an edit the host contract accepts", () => {
    for (const value of ["red", "", "  "]) {
      const edit = styleFieldEdit("color", value);
      expect(artboardEditSchema.parse(edit)).toEqual(edit);
    }
  });
});
