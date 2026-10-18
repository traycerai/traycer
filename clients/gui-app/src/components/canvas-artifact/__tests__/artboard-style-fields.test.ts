import { describe, expect, it } from "vitest";
import { artboardEditSchema } from "@traycer/protocol/host/epic/artboard-edit";
import {
  ARTBOARD_STYLE_FIELDS,
  styleFieldEdit,
} from "../artboard-style-fields";
import { validateArtboardCss } from "../artboard-css-validation";

describe("ARTBOARD_STYLE_FIELDS", () => {
  it("offers the twelve properties the properties panel edits, in panel order", () => {
    expect(ARTBOARD_STYLE_FIELDS.map((field) => field.property)).toEqual([
      "width",
      "height",
      "padding",
      "margin",
      "color",
      "background-color",
      "font-family",
      "font-size",
      "border-width",
      "border-style",
      "border-color",
      "border-radius",
    ]);
  });

  it("never lists a property twice or leaves a label blank", () => {
    const properties = ARTBOARD_STYLE_FIELDS.map((field) => field.property);
    expect(new Set(properties).size).toBe(properties.length);
    for (const field of ARTBOARD_STYLE_FIELDS) {
      expect(field.label.trim()).not.toBe("");
    }
  });

  it("names each property the way the code editor would write it", () => {
    for (const field of ARTBOARD_STYLE_FIELDS) {
      expect(field.property).toBe(field.property.toLowerCase());
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

  it("always produces an edit the host contract accepts", () => {
    for (const value of ["red", "", "  "]) {
      const edit = styleFieldEdit("color", value);
      expect(artboardEditSchema.parse(edit)).toEqual(edit);
    }
  });
});
