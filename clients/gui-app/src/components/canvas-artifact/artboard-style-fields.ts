import type { ArtboardEdit } from "@traycer/protocol/host/epic/artboard-edit";

export const ARTBOARD_STYLE_FIELDS = [
  { property: "width", label: "Width", section: "Size" },
  { property: "height", label: "Height", section: "Size" },
  { property: "padding", label: "Padding", section: "Spacing" },
  { property: "margin", label: "Margin", section: "Spacing" },
  { property: "font-family", label: "Font family", section: "Text" },
  { property: "font-size", label: "Font size", section: "Text" },
  { property: "font-weight", label: "Font weight", section: "Text" },
  { property: "color", label: "Text colour", section: "Text" },
  { property: "text-align", label: "Alignment", section: "Text" },
  {
    property: "background-color",
    label: "Background colour",
    section: "Fill & border",
  },
  { property: "border-width", label: "Border width", section: "Fill & border" },
  { property: "border-style", label: "Border style", section: "Fill & border" },
  {
    property: "border-color",
    label: "Border colour",
    section: "Fill & border",
  },
  {
    property: "border-radius",
    label: "Corner radius",
    section: "Fill & border",
  },
] as const;

const FONT_WEIGHTS = new Map([
  ["100", "Thin"],
  ["200", "Extra light"],
  ["300", "Light"],
  ["400", "Regular"],
  ["500", "Medium"],
  ["600", "Semibold"],
  ["700", "Bold"],
  ["800", "Extra bold"],
  ["900", "Black"],
]);

function displayColor(value: string): string {
  return value.replace(
    /rgba?\(([^)]+)\)/gi,
    (original: string, channels: string) => {
      const parts = channels.trim().split(/\s*[,/]\s*|\s+/);
      if (parts.length < 3 || parts.length > 4) return original;
      const numbers = parts.map((part, index) => {
        const number = Number.parseFloat(part);
        if (!part.endsWith("%")) return number;
        return number * (index === 3 ? 0.01 : 2.55);
      });
      if (numbers.some((part) => !Number.isFinite(part))) return original;
      const alpha = numbers[3] ?? 1;
      if (alpha === 0) return "transparent";
      const hex = (part: number): string =>
        Math.round(Math.max(0, Math.min(255, part)))
          .toString(16)
          .padStart(2, "0");
      return `#${numbers.slice(0, 3).map(hex).join("")}${alpha < 1 ? hex(alpha * 255) : ""}`;
    },
  );
}

export function displayStyleValue(property: string, value: string): string {
  if (property.endsWith("color")) return displayColor(value);
  if (property === "font-family") {
    const first = value.match(/^\s*(?:"([^"]*)"|'([^']*)'|([^,]*))/);
    return (first?.[1] ?? first?.[2] ?? first?.[3] ?? value).trim();
  }
  if (property === "font-weight") {
    let weight = value;
    if (value === "normal") weight = "400";
    if (value === "bold") weight = "700";
    const name = FONT_WEIGHTS.get(weight);
    return name === undefined ? weight : `${name} ${weight}`;
  }
  return value.replace(
    /-?\d*\.\d+px\b/g,
    (length) => `${Math.round(Number.parseFloat(length))}px`,
  );
}

export function styleFieldEdit(property: string, value: string): ArtboardEdit {
  let next = value.trim();
  if (property === "font-weight") {
    for (const [weight, name] of FONT_WEIGHTS) {
      if (next.toLowerCase() === `${name} ${weight}`.toLowerCase()) {
        next = weight;
        break;
      }
    }
  }
  return {
    kind: "set-style",
    property,
    value: next === "" ? null : next,
  };
}
