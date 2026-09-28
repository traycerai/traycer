/** Kept out of `zoom-controls.tsx` so that file exports components only, which is what keeps fast refresh working for it. */
export function fitLabel(kind: "screen" | "width"): string {
  return kind === "screen" ? "Fit to screen" : "Fit to width";
}
