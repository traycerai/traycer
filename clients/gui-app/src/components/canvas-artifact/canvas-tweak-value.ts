export type CanvasKnobValue = {
  readonly kind: "color" | "number" | "text";
  readonly input: string;
  readonly unit: string;
};
export function canvasKnobValue(value: string): CanvasKnobValue {
  if (/^#[0-9a-f]{6}$/i.test(value))
    return { kind: "color", input: value, unit: "" };
  if (/^#[0-9a-f]{3}$/i.test(value))
    return {
      kind: "color",
      input: `#${[...value.slice(1)].map((char) => char + char).join("")}`,
      unit: "",
    };
  const number = /^(-?(?:\d+(?:\.\d*)?|\.\d+))([a-z%]*)$/i.exec(value);
  return number
    ? { kind: "number", input: number[1], unit: number[2] }
    : { kind: "text", input: value, unit: "" };
}
