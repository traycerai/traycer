/**
 * Pure DOM construction for the isolated-world overlay: the closed shadow root,
 * its stylesheet, and every chrome node the guest paints into. No state, no
 * listeners - `boot()` owns those.
 */
import { ANNOTATION_TARGET_PICKER_CSS } from "./browser-annotation-target-picker";

export const OVERLAY_MODES = ["select", "region", "draw", "erase"] as const;

export type OverlayMode = (typeof OVERLAY_MODES)[number];

const MODE_LABELS: Record<OverlayMode, string> = {
  select: "Select",
  region: "Region",
  draw: "Draw",
  erase: "Erase",
};

export interface OverlayChrome {
  readonly host: HTMLDivElement;
  readonly layer: HTMLDivElement;
  readonly hover: HTMLDivElement;
  readonly hoverLabel: HTMLDivElement;
  readonly marquee: HTMLDivElement;
  readonly svg: SVGSVGElement;
  readonly pill: HTMLDivElement;
  readonly buttons: Record<string, HTMLButtonElement>;
  readonly editor: HTMLDivElement;
  readonly comment: HTMLTextAreaElement;
  readonly refuseLine: HTMLDivElement;
  readonly refuseBanner: HTMLDivElement;
  readonly errorLine: HTMLDivElement;
}

/**
 * Builds the overlay host and returns its nodes. The caller appends
 * `host` to the page and wires behavior.
 */
export function createOverlayChrome(input: {
  readonly document: Document;
  readonly targetPickerRoot: HTMLElement;
}): OverlayChrome {
  const D = input.document;

  const host = D.createElement("div");
  host.setAttribute("data-traycer-annotation", "host");
  host.style.cssText =
    "position:fixed;inset:0;z-index:2147483647;pointer-events:none;margin:0;padding:0;";
  const shadow = host.attachShadow({ mode: "closed" });
  const style = D.createElement("style");
  style.textContent = [
    ":host{all:initial;}",
    '*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}',
    ".pill{position:fixed;top:14px;left:50%;transform:translateX(-50%);display:flex;gap:2px;background:#2c2c31;border-radius:10px;padding:4px;pointer-events:auto;z-index:4;box-shadow:0 8px 24px rgba(0,0,0,.28);}",
    ".pill button{border:0;background:none;color:#c9c9d1;font-size:13px;padding:6px 14px;border-radius:7px;cursor:pointer;}",
    '.pill button[aria-pressed="true"]{background:#4a4a55;color:#8ab4ff;}',
    ".layer{position:fixed;inset:0;pointer-events:none;z-index:1;}",
    ".outline{position:fixed;pointer-events:none;border:2px solid #635bff;box-shadow:0 0 0 4px rgba(255,255,255,.85),0 0 0 5px rgba(17,17,22,.35);background:rgba(99,91,255,.06);border-radius:3px;}",
    ".outline.region{border-color:#5b7cfa;background:rgba(91,124,250,.06);}",
    ".outline.invalid{border-color:#d4a94e;box-shadow:0 0 0 4px rgba(255,255,255,.9),0 0 0 5px rgba(80,50,0,.35);background:rgba(212,169,78,.12);}",
    ".hover{position:fixed;pointer-events:none;border:2px solid #8ab4ff;box-shadow:0 0 0 3px rgba(255,255,255,.7);background:rgba(138,180,255,.08);border-radius:3px;opacity:0;visibility:hidden;}",
    ".hover-label{position:fixed;pointer-events:none;z-index:2;max-width:80vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-radius:4px;background:#111827;color:#fff;padding:2px 6px;font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;box-shadow:0 1px 3px rgba(0,0,0,.4);opacity:0;visibility:hidden;}",
    ".hover.visible,.hover-label.visible{opacity:1;visibility:visible;}",
    "@media (prefers-reduced-motion:no-preference){.hover{transition-property:left,top,width,height,opacity;transition-duration:110ms,110ms,110ms,110ms,80ms;transition-timing-function:cubic-bezier(.2,0,0,1);}.hover-label{transition-property:left,top,opacity;transition-duration:110ms,110ms,80ms;transition-timing-function:cubic-bezier(.2,0,0,1);}}",
    ".marquee{position:fixed;pointer-events:none;border:1.5px dashed #5b7cfa;box-shadow:0 0 0 3px rgba(255,255,255,.7);background:rgba(91,124,250,.08);display:none;}",
    ".badge{position:fixed;pointer-events:none;background:#635bff;color:#fff;font-size:11px;padding:2px 7px;border-radius:6px;box-shadow:0 0 0 2px rgba(255,255,255,.9),0 1px 2px rgba(0,0,0,.25);z-index:2;white-space:nowrap;max-width:40vw;overflow:hidden;text-overflow:ellipsis;}",
    ".badge.invalid{background:#d4a94e;color:#1a1204;}",
    ".ink{position:fixed;inset:0;width:100%;height:100%;overflow:visible;}",
    ".ink .halo-light{fill:#fff;opacity:.88;}",
    ".ink .halo-dark{fill:#111218;opacity:.42;}",
    ".ink .pen{fill:#5b7cfa;}",
    ".editor{position:fixed;background:#2c2c31;border-radius:12px;padding:8px 10px;width:min(430px,calc(100vw - 24px));pointer-events:auto;z-index:4;box-shadow:0 10px 28px rgba(0,0,0,.32);display:none;}",
    ".row{display:flex;align-items:flex-end;gap:8px;}",
    ".editor textarea{min-width:0;flex:1;background:none;border:0;color:#e7e7ec;font-size:13px;outline:none;resize:none;min-height:34px;max-height:120px;line-height:1.35;font-family:inherit;}",
    ANNOTATION_TARGET_PICKER_CSS,
    ".refuse{color:#d4a94e;font-size:11px;margin-top:5px;display:none;}",
    ".refuse-banner{position:fixed;top:58px;left:50%;transform:translateX(-50%);background:#2c2c31;color:#d4a94e;font-size:12px;padding:6px 12px;border-radius:8px;pointer-events:none;z-index:4;display:none;box-shadow:0 8px 20px rgba(0,0,0,.28);}",
    ".error{color:#f0b4b4;font-size:11px;margin-top:5px;display:none;}",
  ].join("");

  const layer = D.createElement("div");
  layer.className = "layer";
  const hover = D.createElement("div");
  hover.className = "hover";
  const hoverLabel = D.createElement("div");
  hoverLabel.className = "hover-label";
  hoverLabel.setAttribute("aria-hidden", "true");
  const marquee = D.createElement("div");
  marquee.className = "marquee";
  const svg = D.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "ink");
  svg.setAttribute("aria-hidden", "true");

  const pill = D.createElement("div");
  pill.className = "pill";
  pill.setAttribute("role", "toolbar");
  pill.setAttribute("aria-label", "Annotation tools");

  const buttons: Record<string, HTMLButtonElement> = {};
  for (const modeName of OVERLAY_MODES) {
    const btn = D.createElement("button");
    btn.type = "button";
    btn.textContent = MODE_LABELS[modeName];
    btn.setAttribute("data-mode", modeName);
    btn.setAttribute("aria-pressed", modeName === "select" ? "true" : "false");
    pill.appendChild(btn);
    buttons[modeName] = btn;
  }

  const editor = D.createElement("div");
  editor.className = "editor";
  const row = D.createElement("div");
  row.className = "row";
  const comment = D.createElement("textarea");
  comment.rows = 1;
  comment.placeholder = "Describe the change...";
  comment.setAttribute("aria-label", "Annotation comment");
  row.appendChild(comment);
  row.appendChild(input.targetPickerRoot);
  const refuseLine = D.createElement("div");
  refuseLine.className = "refuse";
  const refuseBanner = D.createElement("div");
  refuseBanner.className = "refuse-banner";
  const errorLine = D.createElement("div");
  errorLine.className = "error";
  editor.appendChild(row);
  editor.appendChild(refuseLine);
  editor.appendChild(errorLine);

  shadow.appendChild(style);
  shadow.appendChild(layer);
  layer.appendChild(svg);
  layer.appendChild(hover);
  layer.appendChild(hoverLabel);
  layer.appendChild(marquee);
  shadow.appendChild(pill);
  shadow.appendChild(editor);
  shadow.appendChild(refuseBanner);

  return {
    host,
    layer,
    hover,
    hoverLabel,
    marquee,
    svg,
    pill,
    buttons,
    editor,
    comment,
    refuseLine,
    refuseBanner,
    errorLine,
  };
}
