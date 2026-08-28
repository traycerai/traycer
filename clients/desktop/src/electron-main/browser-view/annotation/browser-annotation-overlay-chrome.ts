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
    ":host{all:initial;--annotation-background:#fafafa;--annotation-foreground:#252525;--annotation-popover:#fff;--annotation-popover-foreground:#252525;--annotation-muted-foreground:#737373;--annotation-border:#e5e5e5;--annotation-input:#e5e5e5;--annotation-ring:#a3a3a3;--annotation-primary:#252525;--annotation-primary-foreground:#fafafa;--annotation-accent:#f5f5f5;--annotation-accent-foreground:#252525;--annotation-destructive:#dc2626;--annotation-warning:#d97706;--annotation-warning-foreground:#78350f;--annotation-font:-apple-system,BlinkMacSystemFont,sans-serif;--annotation-radius:6px;--annotation-color-scheme:light;font-size:16px;color-scheme:var(--annotation-color-scheme);}",
    "*{box-sizing:border-box;font-family:var(--annotation-font);}",
    ".pill{position:fixed;top:12px;left:50%;transform:translateX(-50%);display:grid;grid-auto-flow:column;gap:2px;width:max-content;max-width:calc(100vw - 24px);padding:3px;background:color-mix(in srgb,var(--annotation-foreground) 8%,var(--annotation-popover));color:var(--annotation-popover-foreground);border:1px solid var(--annotation-border);border-radius:calc(var(--annotation-radius) + 3px);pointer-events:auto;z-index:4;box-shadow:0 8px 24px rgba(0,0,0,.18);}",
    ".pill button{min-width:0;min-height:28px;border:0;background:transparent;color:var(--annotation-muted-foreground);font-size:13px;font-weight:500;line-height:1;padding:6px 10px;border-radius:var(--annotation-radius);cursor:pointer;}",
    '.pill button[aria-pressed="true"]{background:var(--annotation-background);color:var(--annotation-foreground);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.12);}',
    ".pill button:focus-visible{outline:2px solid var(--annotation-ring);outline-offset:1px;}",
    ".pill button:disabled{opacity:.5;cursor:default;}",
    ".layer{position:fixed;inset:0;pointer-events:none;z-index:1;}",
    ".outline{position:fixed;pointer-events:none;border:2px solid var(--annotation-primary);box-shadow:0 0 0 4px rgba(255,255,255,.85),0 0 0 5px rgba(17,17,22,.35);background:color-mix(in srgb,var(--annotation-primary) 8%,transparent);border-radius:3px;}",
    ".outline.region{background:color-mix(in srgb,var(--annotation-primary) 10%,transparent);}",
    ".outline.invalid{border-color:var(--annotation-warning);box-shadow:0 0 0 4px rgba(255,255,255,.9),0 0 0 5px rgba(80,50,0,.35);background:color-mix(in srgb,var(--annotation-warning) 12%,transparent);}",
    ".hover{position:fixed;pointer-events:none;border:2px solid var(--annotation-primary);box-shadow:0 0 0 3px rgba(255,255,255,.7);background:color-mix(in srgb,var(--annotation-primary) 8%,transparent);border-radius:3px;opacity:0;visibility:hidden;}",
    ".hover-label{position:fixed;pointer-events:none;z-index:2;max-width:80vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-radius:var(--annotation-radius);background:var(--annotation-popover);color:var(--annotation-popover-foreground);border:1px solid var(--annotation-border);padding:2px 6px;font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;box-shadow:0 1px 3px rgba(0,0,0,.2);opacity:0;visibility:hidden;}",
    ".hover.visible,.hover-label.visible{opacity:1;visibility:visible;}",
    "@media (prefers-reduced-motion:no-preference){.hover{transition-property:left,top,width,height,opacity;transition-duration:110ms,110ms,110ms,110ms,80ms;transition-timing-function:cubic-bezier(.2,0,0,1);}.hover-label{transition-property:left,top,opacity;transition-duration:110ms,110ms,80ms;transition-timing-function:cubic-bezier(.2,0,0,1);}}",
    ".marquee{position:fixed;pointer-events:none;border:1.5px dashed var(--annotation-primary);box-shadow:0 0 0 3px rgba(255,255,255,.7);background:color-mix(in srgb,var(--annotation-primary) 8%,transparent);display:none;}",
    ".badge{position:fixed;pointer-events:none;background:var(--annotation-primary);color:var(--annotation-primary-foreground);font-size:11px;padding:2px 7px;border-radius:var(--annotation-radius);box-shadow:0 0 0 2px rgba(255,255,255,.9),0 1px 2px rgba(0,0,0,.25);z-index:2;white-space:nowrap;max-width:40vw;overflow:hidden;text-overflow:ellipsis;}",
    ".badge.invalid{background:var(--annotation-warning);color:var(--annotation-warning-foreground);}",
    ".ink{position:fixed;inset:0;width:100%;height:100%;overflow:visible;}",
    ".ink .halo-light{fill:#fff;opacity:.88;}",
    ".ink .halo-dark{fill:#111218;opacity:.42;}",
    ".ink .pen{fill:var(--annotation-primary);}",
    ".editor{position:fixed;width:min(42ch,calc(100vw - 24px));padding:10px;background:var(--annotation-popover);color:var(--annotation-popover-foreground);border:1px solid var(--annotation-border);border-radius:calc(var(--annotation-radius) + 4px);pointer-events:auto;z-index:4;box-shadow:0 10px 28px rgba(0,0,0,.2);display:none;}",
    ".row{display:grid;min-width:0;gap:8px;}",
    ".comment-label{color:var(--annotation-popover-foreground);font-size:12px;font-weight:500;line-height:1.25;}",
    ".editor textarea{width:100%;min-width:0;min-height:56px;max-height:120px;padding:8px 10px;background:var(--annotation-background);border:1px solid var(--annotation-input);border-radius:var(--annotation-radius);color:var(--annotation-foreground);font-size:13px;line-height:1.45;outline:none;resize:none;}",
    ".editor textarea::placeholder{color:var(--annotation-muted-foreground);}",
    ".editor textarea:focus-visible{border-color:var(--annotation-ring);box-shadow:0 0 0 2px color-mix(in srgb,var(--annotation-ring) 30%,transparent);}",
    ".editor textarea:disabled{opacity:.5;}",
    ANNOTATION_TARGET_PICKER_CSS,
    ".refuse{color:var(--annotation-warning-foreground);font-size:11px;margin-top:5px;display:none;}",
    ".refuse-banner{position:fixed;top:58px;left:50%;transform:translateX(-50%);max-width:calc(100vw - 24px);background:var(--annotation-popover);color:var(--annotation-warning-foreground);border:1px solid var(--annotation-border);font-size:12px;padding:6px 12px;border-radius:var(--annotation-radius);pointer-events:none;z-index:4;display:none;box-shadow:0 8px 20px rgba(0,0,0,.18);}",
    ".error{color:var(--annotation-destructive);font-size:11px;margin-top:5px;display:none;}",
    "@media (hover:hover){.pill button:hover{background:color-mix(in srgb,var(--annotation-accent) 70%,transparent);color:var(--annotation-accent-foreground);}}",
    "@media (pointer:coarse){.pill button,.target-trigger,.target-option{min-height:44px;}}",
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
  const commentLabel = D.createElement("label");
  commentLabel.className = "comment-label";
  commentLabel.htmlFor = "traycer-annotation-comment";
  commentLabel.textContent = "Describe the change";
  const comment = D.createElement("textarea");
  comment.id = "traycer-annotation-comment";
  comment.rows = 1;
  comment.placeholder = "Add details…";
  comment.setAttribute(
    "aria-describedby",
    "traycer-annotation-refuse traycer-annotation-error",
  );
  row.append(commentLabel, comment, input.targetPickerRoot);
  const refuseLine = D.createElement("div");
  refuseLine.id = "traycer-annotation-refuse";
  refuseLine.className = "refuse";
  refuseLine.setAttribute("role", "status");
  const refuseBanner = D.createElement("div");
  refuseBanner.className = "refuse-banner";
  refuseBanner.setAttribute("role", "status");
  const errorLine = D.createElement("div");
  errorLine.id = "traycer-annotation-error";
  errorLine.className = "error";
  errorLine.setAttribute("role", "alert");
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
