import type { ArtboardEdit } from "@traycer/protocol/host/epic/artboard-edit";

export const ARTBOARD_STYLE_FIELDS = [
  { property: "width", label: "Width" },
  { property: "height", label: "Height" },
  { property: "padding", label: "Padding" },
  { property: "margin", label: "Margin" },
  { property: "color", label: "Text colour" },
  { property: "background-color", label: "Background colour" },
  { property: "font-family", label: "Font family" },
  { property: "font-size", label: "Font size" },
  { property: "border-width", label: "Border width" },
  { property: "border-style", label: "Border style" },
  { property: "border-color", label: "Border colour" },
  { property: "border-radius", label: "Corner radius" },
] as const;
export function styleFieldEdit(property: string, value: string): ArtboardEdit {
  return {
    kind: "set-style",
    property,
    value: value.trim() === "" ? null : value.trim(),
  };
}
